import { logger } from '@trigger.dev/sdk/v3';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl, getLocaleTexts, type LocaleTexts } from '../utils/constants.js';
import { proxyFetch, type ProxyProvider, type ProxyFetchMeta } from './proxy-fetch.js';
import { extractAppointments, extractGroups } from './html-parsers.js';

export class SessionExpiredError extends Error {
  constructor(detail?: string) {
    super(`Session expired${detail ? ` (${detail})` : ''}`);
    this.name = 'SessionExpiredError';
  }
}

export interface VisaSession {
  cookie: string;
  csrfToken: string;
  authenticityToken: string;
}

export interface DaySlot {
  date: string;
  business_day: boolean;
}

export interface TimeSlots {
  available_times: string[];
  business_times: string[];
}

export interface CurrentAppointment {
  consularDate: string;       // YYYY-MM-DD
  consularTime: string;       // HH:MM
  casDate: string | null;     // YYYY-MM-DD (null for embassies without CAS, e.g. Peru)
  casTime: string | null;     // HH:MM
}

export interface VisaClientConfig {
  scheduleId: string;
  applicantIds: string[];
  consularFacilityId: string;
  ascFacilityId: string;
  proxyProvider: ProxyProvider;
  proxyUrls?: string[] | null;
  userId?: string | null;
  locale?: string;
  captureHtml?: boolean;
}

export class VisaClient {
  private session: VisaSession;
  private config: VisaClientConfig;
  private userId: string | null = null;
  private baseUrl: string;
  private texts: LocaleTexts;
  private extractedAscFacilityId: string | null = null;
  private collectsBiometrics: boolean | null = null;  // from data-collects-biometrics attr
  private hasAscFields: boolean | null = null;         // whether ASC form fields exist in HTML
  private capturedPages = new Map<string, string>();
  private lastProxyMeta: ProxyFetchMeta = { proxyAttemptIp: null, fallbackReason: null, websharePoolSize: 0, errorSource: null, tcpSubcategory: null, poolExhausted: false, socketBytesRead: null };

  constructor(session: VisaSession, config: VisaClientConfig) {
    this.session = { ...session };
    this.config = config;
    if (config.userId) this.userId = config.userId;
    const locale = config.locale ?? 'es-co';
    this.baseUrl = getBaseUrl(locale);
    this.texts = getLocaleTexts(locale);
  }

  getSession(): VisaSession {
    return { ...this.session };
  }

  getConfig(): VisaClientConfig {
    return { ...this.config };
  }

  getUserId(): string | null {
    return this.userId;
  }

  getExtractedAscFacilityId(): string | null {
    return this.extractedAscFacilityId;
  }

  getLastProxyMeta(): ProxyFetchMeta {
    return this.lastProxyMeta;
  }

  getCapturedPages(): Map<string, string> {
    return this.capturedPages;
  }

  /** Whether the consulate collects biometrics (from data-collects-biometrics). null = not yet detected. */
  getCollectsBiometrics(): boolean | null {
    return this.collectsBiometrics;
  }

  /** Whether ASC form fields exist in the appointment HTML. false = renewal/interview-waiver account. */
  getHasAscFields(): boolean | null {
    return this.hasAscFields;
  }

  updateSession(newSession: Partial<VisaSession>): void {
    if (newSession.cookie) this.session.cookie = newSession.cookie;
    if (newSession.csrfToken) this.session.csrfToken = newSession.csrfToken;
    if (newSession.authenticityToken) this.session.authenticityToken = newSession.authenticityToken;
  }

  // ── Headers ────────────────────────────────────────────

  private ajaxHeaders(): Record<string, string> {
    return {
      Cookie: `_yatri_session=${this.session.cookie}`,
      'X-CSRF-Token': this.session.csrfToken,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'User-Agent': USER_AGENT,
      Referer: `${this.baseUrl}/schedule/${this.config.scheduleId}/appointment`,
      ...BROWSER_HEADERS,
    };
  }

  private updateCookieFromResponse(resp: Response): void {
    const cookies = resp.headers.getSetCookie();
    for (const cookie of cookies) {
      const match = cookie.match(/_yatri_session=([^;]+)/);
      if (match?.[1]) {
        this.session.cookie = match[1];
        return;
      }
    }
  }

  private async doFetch(url: string, options: RequestInit = {}): Promise<Response> {
    try {
      const { response, meta } = await proxyFetch(url, options, this.config.proxyProvider, this.config.proxyUrls);
      this.lastProxyMeta = meta;
      this.updateCookieFromResponse(response);
      return response;
    } catch (err) {
      const proxyMeta = (err as { proxyMeta?: ProxyFetchMeta }).proxyMeta;
      if (proxyMeta) this.lastProxyMeta = proxyMeta;
      throw err;
    }
  }

  /** Wraps doFetch with retry on 5xx errors (2 retries, 300ms/600ms backoff). */
  private async fetchWithRetry(url: string, options: RequestInit, label: string): Promise<Response> {
    const RETRIES = 2;
    const BACKOFF = [300, 600];
    for (let attempt = 0; ; attempt++) {
      const resp = await this.doFetch(url, options);
      if (resp.status < 500 || attempt >= RETRIES) return resp;
      // Consume body to release connection
      await resp.text().catch(() => {});
      await new Promise((r) => setTimeout(r, BACKOFF[attempt]!));
    }
  }

  /** Always uses direct fetch — Bright Data proxy returns 402 on POST to gov sites */
  private async doDirectFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const { response, meta } = await proxyFetch(url, options, 'direct');
    this.lastProxyMeta = meta;
    this.updateCookieFromResponse(response);
    return response;
  }

  private assertOk(resp: Response, label: string): void {
    // 5xx = server error (transient, retryable)
    if (resp.status >= 500) {
      throw new Error(`${label} failed: HTTP ${resp.status}`);
    }
    // Anything other than 200 = session expired (302, 401, 403, etc.)
    if (resp.status !== 200) {
      const location = resp.headers.get('location') || '';
      throw new SessionExpiredError(`${label}: HTTP ${resp.status}, location=${location}`);
    }
    // 200 but HTML instead of JSON = proxy followed redirect to sign_in page
    if (label !== 'Appointment page') {
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('text/html')) {
        throw new SessionExpiredError(`${label}: 200 but content-type=${ct}`);
      }
    }
  }

  /** Parse JSON safely — empty/truncated body (session expired) → SessionExpiredError */
  private async safeJson<T>(resp: Response, label: string): Promise<T> {
    const text = await resp.text();
    if (!text || text.length === 0) {
      throw new SessionExpiredError(`${label}: empty response body (session likely expired)`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      // Truncated JSON or HTML = session expired
      throw new SessionExpiredError(`${label}: invalid JSON (${text.length} bytes, starts with: ${text.substring(0, 40)})`);
    }
  }

  // ── Token Refresh ──────────────────────────────────────

  async refreshTokens(): Promise<void> {
    const refreshParts: string[] = [];
    if (this.config.applicantIds.length > 1) {
      refreshParts.push(this.config.applicantIds.map((id) => `applicants[]=${id}`).join('&'));
    }
    refreshParts.push('confirmed_limit_message=1');
    if (this.texts.includeCommit) refreshParts.push(`commit=${this.texts.continueText}`);
    const url = `${this.baseUrl}/schedule/${this.config.scheduleId}/appointment?${refreshParts.join('&')}`;

    // Must use direct — Firecrawl strips form elements (no authenticity_token)
    const resp = await this.doDirectFetch(url, {
      headers: {
        Cookie: `_yatri_session=${this.session.cookie}`,
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        ...BROWSER_HEADERS,
      },
      redirect: 'manual',
    });

    this.assertOk(resp, 'Appointment page');

    const html = await resp.text();
    if (this.config.captureHtml) this.capturedPages.set('appointment-page', html);

    const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
    if (!csrfMatch?.[1]) throw new Error('CSRF token not found in HTML');
    this.session.csrfToken = csrfMatch[1];

    const authMatch = html.match(/<input[^>]+name="authenticity_token"[^>]+value="([^"]+)"/);
    if (!authMatch?.[1]) throw new Error('authenticity_token not found in appointment page HTML');
    this.session.authenticityToken = authMatch[1];

    const userIdMatch = html.match(/\/groups\/(\d+)/);
    if (userIdMatch?.[1]) {
      this.userId = userIdMatch[1];
    }

    // Extract ASC facility ID from dropdown (useful for non-Bogota embassies)
    const ascMatch = html.match(/<select[^>]+asc_appointment_facility_id[^>]*>[\s\S]*?<option[^>]+value="(\d+)"/);
    if (ascMatch?.[1]) {
      this.extractedAscFacilityId = ascMatch[1];
    }

    // Detect if consulate collects biometrics (renewal accounts have data-collects-biometrics="false" and no ASC fields)
    const collectsBioMatch = html.match(/data-collects-biometrics="(\w+)"/);
    if (collectsBioMatch?.[1]) {
      this.collectsBiometrics = collectsBioMatch[1] === 'true';
    }
    // If no ASC fields exist at all in the HTML, this is a renewal/interview-waiver account
    this.hasAscFields = html.includes('asc_appointment_facility_id');
  }

  // ── Current Appointment (from groups page) ────────────

  async getCurrentAppointment(): Promise<CurrentAppointment | null> {
    if (!this.userId) return null;

    const resp = await this.doDirectFetch(`${this.baseUrl}/groups/${this.userId}`, {
      headers: {
        Cookie: `_yatri_session=${this.session.cookie}`,
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        ...BROWSER_HEADERS,
      },
      redirect: 'manual',
    });

    if (resp.status !== 200) return null;

    const html = await resp.text();
    if (this.config.captureHtml) this.capturedPages.set('groups-page', html);

    const groups = extractGroups(html);
    const myGroup = groups.find(g => g.scheduleId === String(this.config.scheduleId));
    if (!myGroup || !myGroup.currentConsularDate || !myGroup.currentConsularTime) return null;

    return {
      consularDate: myGroup.currentConsularDate,
      consularTime: myGroup.currentConsularTime,
      casDate: myGroup.currentCasDate,
      casTime: myGroup.currentCasTime,
    };
  }

  // ── Consular Days ──────────────────────────────────────

  async getConsularDays(): Promise<DaySlot[]> {
    const resp = await this.fetchWithRetry(
      `${this.baseUrl}/schedule/${this.config.scheduleId}/appointment/days/${this.config.consularFacilityId}.json?appointments[expedite]=false`,
      { headers: this.ajaxHeaders() },
      'Consular days',
    );
    this.assertOk(resp, 'Consular days');
    return this.safeJson<DaySlot[]>(resp, 'Consular days');
  }

  // ── Consular Times ─────────────────────────────────────

  async getConsularTimes(date: string): Promise<TimeSlots> {
    const resp = await this.fetchWithRetry(
      `${this.baseUrl}/schedule/${this.config.scheduleId}/appointment/times/${this.config.consularFacilityId}.json?date=${date}&appointments[expedite]=false`,
      { headers: this.ajaxHeaders() },
      'Consular times',
    );
    this.assertOk(resp, 'Consular times');
    return this.safeJson<TimeSlots>(resp, 'Consular times');
  }

  // ── CAS Days ───────────────────────────────────────────

  async getCasDays(consularDate: string, consularTime: string): Promise<DaySlot[]> {
    const resp = await this.fetchWithRetry(
      `${this.baseUrl}/schedule/${this.config.scheduleId}/appointment/days/${this.config.ascFacilityId}.json?consulate_id=${this.config.consularFacilityId}&consulate_date=${consularDate}&consulate_time=${consularTime}&appointments[expedite]=false`,
      { headers: this.ajaxHeaders() },
      'CAS days',
    );
    this.assertOk(resp, 'CAS days');
    return this.safeJson<DaySlot[]>(resp, 'CAS days');
  }

  // ── CAS Times ──────────────────────────────────────────

  async getCasTimes(date: string, consularDate?: string, consularTime?: string): Promise<TimeSlots> {
    let url = `${this.baseUrl}/schedule/${this.config.scheduleId}/appointment/times/${this.config.ascFacilityId}.json?date=${date}`;
    if (consularDate && consularTime) {
      url += `&consulate_id=${this.config.consularFacilityId}&consulate_date=${consularDate}&consulate_time=${consularTime}`;
    }
    url += '&appointments[expedite]=false';
    const resp = await this.fetchWithRetry(url, { headers: this.ajaxHeaders() }, 'CAS times');
    this.assertOk(resp, 'CAS times');
    return this.safeJson<TimeSlots>(resp, 'CAS times');
  }

  // ── Reschedule ─────────────────────────────────────────

  async reschedule(
    consularDate: string,
    consularTime: string,
    casDate?: string,
    casTime?: string,
  ): Promise<boolean> {
    const body = new URLSearchParams({
      authenticity_token: this.session.authenticityToken,
      confirmed_limit_message: '1',
      use_consulate_appointment_capacity: 'true',
      'appointments[consulate_appointment][facility_id]': this.config.consularFacilityId,
      'appointments[consulate_appointment][date]': consularDate,
      'appointments[consulate_appointment][time]': consularTime,
    });

    // Only include ASC fields if this embassy collects biometrics
    if (this.config.ascFacilityId && casDate && casTime) {
      body.set('appointments[asc_appointment][facility_id]', this.config.ascFacilityId);
      body.set('appointments[asc_appointment][date]', casDate);
      body.set('appointments[asc_appointment][time]', casTime);
    }

    if (this.texts.includeCommit) {
      body.set('commit', this.texts.rescheduleText);
    }

    // Only include applicants[] in Referer when multiple applicants (single = implicit)
    const appointmentUrl = `${this.baseUrl}/schedule/${this.config.scheduleId}/appointment`;
    const refererParts: string[] = [];
    if (this.config.applicantIds.length > 1) {
      refererParts.push(this.config.applicantIds.map(id => `applicants%5B%5D=${id}`).join('&'));
    }
    refererParts.push('confirmed_limit_message=1');
    if (this.texts.includeCommit) refererParts.push(`commit=${this.texts.continueText}`);
    const referer = refererParts.length > 0 ? `${appointmentUrl}?${refererParts.join('&')}` : appointmentUrl;

    logger.info('[reschedule] POST details', {
      scheduleId: this.config.scheduleId,
      consular: `${consularDate} ${consularTime}`,
      cas: casDate ? `${casDate} ${casTime}` : 'N/A',
      applicantIds: this.config.applicantIds,
      authTokenLen: this.session.authenticityToken?.length ?? 0,
      authTokenPrefix: this.session.authenticityToken?.substring(0, 16) ?? '(empty)',
      csrfTokenLen: this.session.csrfToken?.length ?? 0,
      cookieLen: this.session.cookie?.length ?? 0,
      bodyLen: body.toString().length,
    });

    const resp = await this.doDirectFetch(appointmentUrl, {
      method: 'POST',
      headers: {
        Cookie: `_yatri_session=${this.session.cookie}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': this.session.csrfToken,
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: referer,
        Origin: 'https://ais.usvisa-info.com',
        'Upgrade-Insecure-Requests': '1',
        ...BROWSER_HEADERS,
      },
      redirect: 'manual',
      body: body.toString(),
    });

    logger.info('[reschedule] POST response', {
      status: resp.status,
      location: resp.headers.get('location') ?? '(none)',
      contentType: resp.headers.get('content-type') ?? '(none)',
      setCookie: resp.headers.getSetCookie().length > 0,
    });

    // Follow redirect chain: POST → 302 /continue → 302 /instructions → 200
    return this.followRedirectChain(resp);
  }

  private async followRedirectChain(resp: Response): Promise<boolean> {
    let current = resp;

    for (let hops = 0; hops < 5; hops++) {
      if (current.status !== 302) break;

      const location = current.headers.get('location');
      if (!location) break;

      logger.info('[reschedule] Redirect hop', { hop: hops, status: current.status, location });

      if (location.includes('sign_in')) {
        // Read body for diagnostic before throwing
        const body = await current.text().catch(() => '(unreadable)');
        logger.error('[reschedule] Redirected to sign_in — session expired', {
          hop: hops, location, bodyPreview: body.substring(0, 300),
        });
        throw new SessionExpiredError();
      }

      if (location.includes('instructions')) {
        return true; // success — /instructions is the final confirmation page
      }

      // /continue is NOT a success signal — it's a normal intermediate redirect.
      // Follow it to see where it actually leads (could be /instructions or /appointment).

      current = await this.doDirectFetch(location, {
        headers: {
          Cookie: `_yatri_session=${this.session.cookie}`,
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Upgrade-Insecure-Requests': '1',
          ...BROWSER_HEADERS,
        },
        redirect: 'manual',
      });
    }

    // Check final page content
    if (current.status === 200) {
      const text = await current.text();
      logger.info('[reschedule] Final page', {
        status: 200,
        hasSuccess: text.includes('programado exitosamente') || text.includes('instructions'),
        bodyPreview: text.substring(0, 300),
      });
      if (text.includes('programado exitosamente') || text.includes('instructions')) {
        return true;
      }
    } else {
      logger.warn('[reschedule] Unexpected final status', {
        status: current.status,
        contentType: current.headers.get('content-type') ?? '(none)',
      });
    }

    return false;
  }
}

import { USER_AGENT, BROWSER_HEADERS, getBaseUrl, getLocaleTexts, type LocaleTexts } from '../utils/constants.js';
import { proxyFetch, type ProxyProvider } from './proxy-fetch.js';

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
  consularDate: string;  // YYYY-MM-DD
  consularTime: string;  // HH:MM
  casDate: string;       // YYYY-MM-DD
  casTime: string;       // HH:MM
}

export interface VisaClientConfig {
  scheduleId: string;
  applicantIds: string[];
  consularFacilityId: string;
  ascFacilityId: string;
  proxyProvider: ProxyProvider;
  userId?: string | null;
  locale?: string;
}

// URL locale (/es-co/) controls the language. Support Spanish + English for robustness.
const MONTH_MAP: Record<string, string> = {
  enero: '01', febrero: '02', marzo: '03', abril: '04',
  mayo: '05', junio: '06', julio: '07', agosto: '08',
  septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12',
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};

function parseAppointmentDate(text: string): { date: string; time: string } | null {
  // Format: "30 noviembre, 2026, 08:45 ..." or "30 November, 2026, 08:45 ..."
  const match = text.match(/(\d{1,2})\s+(\w+),\s*(\d{4}),\s*(\d{2}:\d{2})/);
  if (!match) return null;
  const [, day, monthName, year, time] = match;
  const month = MONTH_MAP[monthName!.toLowerCase()];
  if (!month) return null;
  return {
    date: `${year}-${month}-${day!.padStart(2, '0')}`,
    time: time!,
  };
}

export class VisaClient {
  private session: VisaSession;
  private config: VisaClientConfig;
  private userId: string | null = null;
  private baseUrl: string;
  private texts: LocaleTexts;
  private extractedAscFacilityId: string | null = null;

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

  getUserId(): string | null {
    return this.userId;
  }

  getExtractedAscFacilityId(): string | null {
    return this.extractedAscFacilityId;
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
    const setCookie = resp.headers.get('set-cookie');
    if (setCookie) {
      const match = setCookie.match(/_yatri_session=([^;]+)/);
      if (match?.[1]) {
        this.session.cookie = match[1];
      }
    }
  }

  private async doFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const resp = await proxyFetch(url, options, this.config.proxyProvider);
    this.updateCookieFromResponse(resp);
    return resp;
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
    const resp = await proxyFetch(url, options, 'direct');
    this.updateCookieFromResponse(resp);
    return resp;
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

  // ── Token Refresh ──────────────────────────────────────

  async refreshTokens(): Promise<void> {
    const qs = this.config.applicantIds.map((id) => `applicants[]=${id}`).join('&');
    const url = `${this.baseUrl}/schedule/${this.config.scheduleId}/appointment?${qs}&confirmed_limit_message=1&commit=${this.texts.continueText}`;

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

    const consularMatch = html.match(/<p class='consular-appt'>[\s\S]*?<\/strong>\s*\n?\s*([^<&]+)/);
    const casMatch = html.match(/<p class='asc-appt'>[\s\S]*?<\/strong>\s*\n?\s*([^<&]+)/);

    if (!consularMatch?.[1] || !casMatch?.[1]) return null;

    const consular = parseAppointmentDate(consularMatch[1].trim());
    const cas = parseAppointmentDate(casMatch[1].trim());

    if (!consular || !cas) return null;

    return {
      consularDate: consular.date,
      consularTime: consular.time,
      casDate: cas.date,
      casTime: cas.time,
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
    return resp.json() as Promise<DaySlot[]>;
  }

  // ── Consular Times ─────────────────────────────────────

  async getConsularTimes(date: string): Promise<TimeSlots> {
    const resp = await this.fetchWithRetry(
      `${this.baseUrl}/schedule/${this.config.scheduleId}/appointment/times/${this.config.consularFacilityId}.json?date=${date}&appointments[expedite]=false`,
      { headers: this.ajaxHeaders() },
      'Consular times',
    );
    this.assertOk(resp, 'Consular times');
    return resp.json() as Promise<TimeSlots>;
  }

  // ── CAS Days ───────────────────────────────────────────

  async getCasDays(consularDate: string, consularTime: string): Promise<DaySlot[]> {
    const resp = await this.fetchWithRetry(
      `${this.baseUrl}/schedule/${this.config.scheduleId}/appointment/days/${this.config.ascFacilityId}.json?consulate_id=${this.config.consularFacilityId}&consulate_date=${consularDate}&consulate_time=${consularTime}&appointments[expedite]=false`,
      { headers: this.ajaxHeaders() },
      'CAS days',
    );
    this.assertOk(resp, 'CAS days');
    return resp.json() as Promise<DaySlot[]>;
  }

  // ── CAS Times ──────────────────────────────────────────

  async getCasTimes(date: string): Promise<TimeSlots> {
    const resp = await this.fetchWithRetry(
      `${this.baseUrl}/schedule/${this.config.scheduleId}/appointment/times/${this.config.ascFacilityId}.json?date=${date}&appointments[expedite]=false`,
      { headers: this.ajaxHeaders() },
      'CAS times',
    );
    this.assertOk(resp, 'CAS times');
    return resp.json() as Promise<TimeSlots>;
  }

  // ── Reschedule ─────────────────────────────────────────

  async reschedule(
    consularDate: string,
    consularTime: string,
    casDate?: string,
    casTime?: string,
  ): Promise<boolean> {
    // Tokens already valid — session proven alive by prior API calls in this run.
    // refreshTokens() is called in poll-visa before triggering reschedule-visa,
    // and reschedule-visa makes 4+ API calls (getDays, getTimes, getCasDays, getCasTimes)
    // before reaching this point. No need to refresh again (~1s saved).

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

    // Match real browser POST: no X-CSRF-Token (form uses authenticity_token in body),
    // full Referer with query params, Upgrade-Insecure-Requests, sec-ch-ua headers
    const qs = this.config.applicantIds.map(id => `applicants%5B%5D=${id}`).join('&');
    const resp = await this.doDirectFetch(`${this.baseUrl}/schedule/${this.config.scheduleId}/appointment`, {
      method: 'POST',
      headers: {
        Cookie: `_yatri_session=${this.session.cookie}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: `${this.baseUrl}/schedule/${this.config.scheduleId}/appointment?${qs}&confirmed_limit_message=1&commit=${this.texts.continueText}`,
        Origin: 'https://ais.usvisa-info.com',
        'Upgrade-Insecure-Requests': '1',
        ...BROWSER_HEADERS,
      },
      redirect: 'manual',
      body: body.toString(),
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

      if (location.includes('sign_in')) {
        throw new SessionExpiredError();
      }

      if (location.includes('instructions') || location.includes('/continue')) {
        return true; // success! (/continue already confirms the reschedule went through)
      }

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
      if (text.includes('programado exitosamente') || text.includes('instructions')) {
        return true;
      }
    }

    return false;
  }
}

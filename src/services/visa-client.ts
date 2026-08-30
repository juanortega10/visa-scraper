import { logger } from '@trigger.dev/sdk/v3';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl, getLocaleTexts, type LocaleTexts } from '../utils/constants.js';
import { proxyFetch, type ProxyProvider, type ProxyFetchMeta } from './proxy-fetch.js';
import { extractAppointments, extractGroups } from './html-parsers.js';

/**
 * Techo por PETICION del camino critico, en milisegundos.
 *
 * El agente global de undici usa `headersTimeout: 12_000` (`proxy-fetch.ts`), que
 * es correcto para el login: son paginas pesadas y no corren contra el reloj de un
 * cupo. Dentro del camino critico esos 12 s se gastan enteros cuando una ruta se
 * cuelga, y el cupo dura segundos. Medido el 2026-08-27: `refreshTokens()` gasto
 * 12.294 ms identicos en el bot 7 y en el bot 299.
 *
 * Se aplica con `AbortSignal.timeout()` por peticion, no en el agente, entonces el
 * login conserva su margen completo. El POST de reagendamiento NUNCA lleva techo:
 * abortarlo del lado del cliente deja la duda de si el portal ya lo proceso.
 */
export const TECHO_CARRERA_MS = 3_000;

/**
 * Techo de `times.json` y de las dos peticiones de CAS, en milisegundos.
 *
 * Mas alto que `TECHO_CARRERA_MS` por una razon concreta: `refreshTokens()` y
 * `getCurrentAppointment()` tienen SEGUNDA RUTA. Abortarlas rapido es gratis, porque
 * el corte arranca el intento por proxy. `times.json` no tiene segunda ruta: el
 * reintento de `proxyFetch` solo cubre errores de TCP, y un abort no lo es
 * (`TCP_RE` no lo reconoce). Ahi un techo corto convierte "lento pero vivo" en
 * "perdido", que es peor que esperar.
 *
 * Medido el 2026-08-30: con 3.000 ms el ensayo del sniper aborto en el primer
 * intento. Sigue muy por debajo de los 12.000 ms del agente.
 */
export const TECHO_HORAS_MS = 8_000;

/** Techo del GET de dias. Mas suelto: perder este tick cuesta un ciclo, no un cupo. */
export const TECHO_DIAS_MS = 6_000;

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
  applicantNames: string[];   // full names from the same groups page (may be empty)
}

export interface VisaClientConfig {
  scheduleId: string;
  applicantIds: string[];
  consularFacilityId: string;
  ascFacilityId: string;
  proxyProvider: ProxyProvider;
  /**
   * Proveedor para el POST de reschedule y para `refreshTokens()`.
   *
   * Por defecto `'direct'`, que es el comportamiento historico de toda la flota. Existe
   * porque `doDirectFetch` estaba fijo en `'direct'`: cuando la IP directa del host queda
   * TCP-bloqueada por el portal, los GET JSON siguen saliendo por el proxy y el POST falla,
   * entonces el bot ve cupos y no puede tomarlos.
   *
   * Bright Data devuelve 402 en POST, entonces solo `'direct'` y `'webshare'` sirven aqui.
   */
  postProvider?: ProxyProvider;
  proxyUrls?: string[] | null;
  userId?: string | null;
  locale?: string;
  captureHtml?: boolean;
  /**
   * Cuando se emitio el `authenticity_token` que viene en la sesion. Sale de
   * `sessions.tokens_refreshed_at`. Sin este dato el token cuenta como vencido y
   * `ensureTokens()` lo refresca, que es el comportamiento historico.
   */
  tokensRefreshedAt?: Date | null;
}

/**
 * Agrega un techo de tiempo por peticion sin pisar un `signal` que ya venga puesto.
 * Con `techoMs` sin definir devuelve las mismas opciones, entonces el llamador que
 * no pide techo no cambia de comportamiento.
 */
function conTecho(options: RequestInit, techoMs?: number): RequestInit {
  if (!techoMs || options.signal) return options;
  return { ...options, signal: AbortSignal.timeout(techoMs) };
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
  /**
   * Clave para fijar la IP de webshare durante toda la vida de este cliente.
   * Un cliente = un run de un bot, entonces todas las peticiones del camino
   * critico salen por la misma IP: sin tuneles frios y con una sola huella.
   */
  private readonly stickyKey = `vc-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  /**
   * Momento en que el portal emitio el `authenticity_token` que trae la sesion.
   *
   * Se siembra desde `sessions.tokens_refreshed_at`, entonces un token precalentado
   * en un run anterior sigue contando como fresco en este. `null` = edad desconocida,
   * que se trata como vencido.
   */
  private tokensRefreshedAt: Date | null = null;
  private lastProxyMeta: ProxyFetchMeta = { proxyAttemptIp: null, fallbackReason: null, websharePoolSize: 0, errorSource: null, tcpSubcategory: null, poolExhausted: false, socketBytesRead: null };

  constructor(session: VisaSession, config: VisaClientConfig) {
    this.session = { ...session };
    this.config = config;
    if (config.userId) this.userId = config.userId;
    if (config.tokensRefreshedAt) this.tokensRefreshedAt = config.tokensRefreshedAt;
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

  /** Momento de emision del `authenticity_token`, para persistirlo en `sessions`. */
  getTokensRefreshedAt(): Date | null {
    return this.tokensRefreshedAt;
  }

  /** Edad del token en milisegundos. `Infinity` cuando no se conoce la emision. */
  getTokensAgeMs(): number {
    if (!this.tokensRefreshedAt || !this.session.authenticityToken) return Number.POSITIVE_INFINITY;
    const edad = Date.now() - this.tokensRefreshedAt.getTime();
    return edad < 0 ? Number.POSITIVE_INFINITY : edad;
  }

  /**
   * Refresca el `authenticity_token` SOLO si hace falta.
   *
   * Precomputar lo precomputable: el token vive con la sesion de Rails, no con la
   * peticion, entonces se puede pedir con calma antes de que aparezca el cupo. En el
   * camino critico esta llamada cuesta 0 ms cuando el token ya esta fresco.
   *
   * Devuelve `true` si toco pedir la pagina al portal.
   */
  async ensureTokens(maxAgeMs: number): Promise<boolean> {
    if (this.getTokensAgeMs() <= maxAgeMs) return false;
    await this.refreshTokens();
    return true;
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
      const { response, meta } = await proxyFetch(url, options, this.config.proxyProvider, this.config.proxyUrls, this.stickyKey);
      this.lastProxyMeta = meta;
      this.updateCookieFromResponse(response);
      return response;
    } catch (err) {
      const proxyMeta = (err as { proxyMeta?: ProxyFetchMeta }).proxyMeta;
      if (proxyMeta) this.lastProxyMeta = proxyMeta;
      throw err;
    }
  }

  /**
   * `doFetch` con reintento ante 5xx.
   *
   * Dos perfiles, porque no todas las peticiones corren contra un reloj:
   *   normal  2 reintentos con 300 y 600 ms. Para el polling, donde esperar sale
   *           mas barato que perder el dato.
   *   carrera 1 reintento con 50 ms. Para `times.json` cuando ya vimos un cupo:
   *           el cupo dura segundos y 900 ms de sueño llegan tarde igual.
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    label: string,
    perfil: 'normal' | 'carrera' = 'normal',
    techoMs?: number,
  ): Promise<Response> {
    const BACKOFF = perfil === 'carrera' ? [50] : [300, 600];
    const RETRIES = BACKOFF.length;
    for (let attempt = 0; ; attempt++) {
      // El techo se arma DENTRO del bucle: un `AbortSignal.timeout` ya vencido
      // aborta el reintento antes de que salga.
      const resp = await this.doFetch(url, conTecho(options, techoMs));
      if (resp.status < 500 || attempt >= RETRIES) return resp;
      // Se consume el cuerpo para liberar la conexion
      await resp.text().catch(() => {});
      await new Promise((r) => setTimeout(r, BACKOFF[attempt]!));
    }
  }

  /** Always uses direct fetch — Bright Data proxy returns 402 on POST to gov sites */
  private async doDirectFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const provider = this.config.postProvider ?? 'direct';
    const { response, meta } = await proxyFetch(
      url, options, provider,
      provider === 'direct' ? undefined : this.config.proxyUrls,
      this.stickyKey,
    );
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

    // La restriccion real es NO usar Firecrawl, que borra los elementos del
    // formulario y deja la pagina sin `authenticity_token`. Cualquier otra ruta
    // sirve: esto es un GET. La regla "solo directo" de `doDirectFetch` existe
    // para los POST, donde Bright Data devuelve 402.
    //
    // Antes esto salia solo por la ruta directa y sin respaldo. Cuando esa ruta
    // se cuelga, agota el `headersTimeout` de 12 s del agente directo
    // (`proxy-fetch.ts:573`) DENTRO del camino critico, justo cuando corre el
    // reloj del cupo. Medido el 2026-08-27: 12.294 ms identicos en dos bots.
    const opciones = {
      headers: {
        Cookie: `_yatri_session=${this.session.cookie}`,
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        ...BROWSER_HEADERS,
      },
      redirect: 'manual' as const,
    };
    const puedeCaerAlProxy = this.config.proxyProvider !== 'direct'
      && this.config.proxyProvider !== 'firecrawl';

    // Techo por peticion en LAS DOS rutas. Sin el, la ruta directa colgada gasta los
    // 12 s del agente y recien ahi arranca el proxy: 12 s antes de la primera
    // alternativa. Con techo, el peor caso es 2 x TECHO_CARRERA_MS.
    let resp: Response;
    try {
      resp = await this.doDirectFetch(url, conTecho(opciones, TECHO_CARRERA_MS));
    } catch (err) {
      if (!puedeCaerAlProxy) throw err;
      const { response, meta } = await proxyFetch(url, conTecho(opciones, TECHO_CARRERA_MS), this.config.proxyProvider, this.config.proxyUrls, this.stickyKey);
      this.lastProxyMeta = meta;
      this.updateCookieFromResponse(response);
      resp = response;
    }

    this.assertOk(resp, 'Appointment page');

    const html = await resp.text();
    if (this.config.captureHtml) this.capturedPages.set('appointment-page', html);

    const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
    if (!csrfMatch?.[1]) throw new Error('CSRF token not found in HTML');
    this.session.csrfToken = csrfMatch[1];

    const authMatch = html.match(/<input[^>]+name="authenticity_token"[^>]+value="([^"]+)"/);
    if (!authMatch?.[1]) throw new Error('authenticity_token not found in appointment page HTML');
    this.session.authenticityToken = authMatch[1];
    // Sello de emision. Lo lee `ensureTokens()` y lo persiste `poll-visa` en
    // `sessions.tokens_refreshed_at` para que el proximo run herede la frescura.
    this.tokensRefreshedAt = new Date();

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

    const url = `${this.baseUrl}/groups/${this.userId}`;
    const options: RequestInit = {
      headers: {
        Cookie: `_yatri_session=${this.session.cookie}`,
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        ...BROWSER_HEADERS,
      },
      redirect: 'manual',
    };

    // Direct first, then the bot's own provider. On the RPi the residential IP is
    // blocked for this HTML page (ECONNREFUSED / connection_reset) even while the
    // JSON polling endpoints work, which silently killed the appointment sync for
    // every dev-polled bot. This is a GET, so any provider is fine (the direct-only
    // rule in doDirectFetch exists for POSTs, where Bright Data returns 402).
    let resp: Response;
    try {
      resp = await this.doDirectFetch(url, conTecho(options, TECHO_CARRERA_MS));
    } catch (err) {
      if (this.config.proxyProvider === 'direct') throw err;
      const { response, meta } = await proxyFetch(url, conTecho(options, TECHO_CARRERA_MS), this.config.proxyProvider, this.config.proxyUrls, this.stickyKey);
      this.lastProxyMeta = meta;
      this.updateCookieFromResponse(response);
      resp = response;
    }

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
      applicantNames: myGroup.applicantNames.filter(Boolean),
    };
  }

  // ── Consular Days ──────────────────────────────────────

  async getConsularDays(): Promise<DaySlot[]> {
    const resp = await this.fetchWithRetry(
      `${this.baseUrl}/schedule/${this.config.scheduleId}/appointment/days/${this.config.consularFacilityId}.json?appointments[expedite]=false`,
      { headers: this.ajaxHeaders() },
      'Consular days',
      'normal',
      TECHO_DIAS_MS,
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
      'carrera',   // ya vimos el cupo: aqui cada 100 ms cuenta
      TECHO_HORAS_MS,
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
      'carrera',
      TECHO_HORAS_MS,
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
    const resp = await this.fetchWithRetry(url, { headers: this.ajaxHeaders() }, 'CAS times', 'carrera', TECHO_HORAS_MS);
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

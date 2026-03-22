import { ProxyAgent } from 'undici';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl, getLocaleTexts } from '../utils/constants.js';
import type { VisaSession } from './visa-client.js';
import { logAuth } from '../utils/auth-logger.js';
import { getEffectiveWebshareUrls } from './proxy-fetch.js';
import {
  extractScheduleId,
  extractApplicantIdsFromGroups,
  extractApplicantIdsFromAppointment,
  extractApplicantNames,
  extractAppointments,
  extractFacilityIds,
  extractGroups,
} from './html-parsers.js';
export type { GroupInfo as GroupResult } from './html-parsers.js';

export interface LoginCredentials {
  email: string;
  password: string;
  scheduleId: string;
  applicantIds: string[];
  locale?: string;
}

export interface LoginResult extends VisaSession {
  /** Whether tokens were extracted (false = cookie only, tokens need refreshTokens later) */
  hasTokens: boolean;
}

export class InvalidCredentialsError extends Error {
  constructor(message = 'Invalid email or password') {
    super(message);
    this.name = 'InvalidCredentialsError';
  }
}

export class AccountLockedError extends Error {
  /** When the lockout expires (if parseable from response), or undefined */
  lockedUntil?: Date;

  constructor(message = 'Account locked after too many failed login attempts', lockedUntil?: Date) {
    super(message);
    this.name = 'AccountLockedError';
    this.lockedUntil = lockedUntil;
  }
}

interface PureFetchLoginOptions {
  /** Skip fetching appointment page for tokens (faster, ~970ms vs ~1.7s) */
  skipTokens?: boolean;
  /** Which sign_in page to use for initial cookie. IV is less trafficked. */
  visaType?: 'iv' | 'niv';
  /** Optional proxy URL (e.g. webshare) — routes all fetch calls through this proxy */
  proxyUrl?: string;
}

/**
 * Pure fetch-based login.
 *
 * 1. GET sign_in page → _yatri_session cookie + CSRF token from HTML
 * 2. POST sign_in with AJAX headers → bypasses hCaptcha, gets new session cookie
 * 3. (optional) GET appointment page → csrfToken + authenticityToken
 *
 * Total: ~970ms (skipTokens) or ~1.7s (with tokens)
 */
export async function pureFetchLogin(
  creds: LoginCredentials,
  opts: PureFetchLoginOptions = {},
): Promise<LoginResult> {
  const { skipTokens = false, visaType = 'iv', proxyUrl } = opts;
  const locale = creds.locale ?? 'es-co';
  const nivBaseUrl = getBaseUrl(locale);
  const texts = getLocaleTexts(locale);
  const cookieSourceUrl = `https://ais.usvisa-info.com/${locale}/${visaType}/users/sign_in`;
  const nivSignInUrl = `${nivBaseUrl}/users/sign_in`;
  const dispatcher = proxyUrl
    ? new ProxyAgent({ uri: proxyUrl, connectTimeout: 10_000, headersTimeout: 12_000 })
    : undefined;

  // Step 1: GET sign_in page to get _yatri_session cookie + CSRF
  const getResp = await fetch(cookieSourceUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...BROWSER_HEADERS,
    },
    redirect: 'follow',
    // @ts-expect-error undici dispatcher
    ...(dispatcher ? { dispatcher } : {}),
  });

  if (!getResp.ok) {
    throw new Error(`GET sign_in failed: HTTP ${getResp.status}`);
  }

  // Extract _yatri_session from Set-Cookie
  const setCookieHeaders = getResp.headers.getSetCookie();
  let yatriCookie = '';
  for (const h of setCookieHeaders) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) {
      yatriCookie = m[1];
      break;
    }
  }
  if (!yatriCookie) {
    throw new Error(`No _yatri_session from ${visaType} sign_in GET`);
  }

  // Extract CSRF from HTML meta tag
  const html = await getResp.text();
  const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  if (!csrfMatch?.[1]) {
    throw new Error(`No CSRF token in ${visaType} sign_in HTML`);
  }
  const initialCsrf = csrfMatch[1];

  // Step 2: POST to NIV sign_in via AJAX (bypasses hCaptcha)
  const commitText = locale.startsWith('es-') ? 'Iniciar sesión' : 'Sign In';
  const postResp = await fetch(nivSignInUrl, {
    method: 'POST',
    headers: {
      'Accept': '*/*;q=0.5, text/javascript, application/javascript, application/ecmascript, application/x-ecmascript',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Cookie': `_yatri_session=${yatriCookie}`,
      'Origin': 'https://ais.usvisa-info.com',
      'Referer': nivSignInUrl,
      'User-Agent': USER_AGENT,
      'X-CSRF-Token': initialCsrf,
      'X-Requested-With': 'XMLHttpRequest',
      ...BROWSER_HEADERS,
    },
    body: new URLSearchParams({
      'user[email]': creds.email,
      'user[password]': creds.password,
      'policy_confirmed': '1',
      'commit': commitText,
    }).toString(),
    redirect: 'manual',
    // @ts-expect-error undici dispatcher
    ...(dispatcher ? { dispatcher } : {}),
  });

  // Check for invalid credentials or account lock
  const postBody = await postResp.text();
  if (postBody.includes('inválida') || postBody.includes('Invalid Email or password')) {
    throw new InvalidCredentialsError();
  }

  // Check for explicit account lock message: "Your account is locked until 19 March, 2026, 20:19:09 -05."
  const lockMatch = postBody.match(/account is locked until ([^<.]+)/i);
  if (lockMatch) {
    let lockedUntil: Date | undefined;
    try { lockedUntil = new Date(lockMatch[1].trim()); } catch { /* unparseable */ }
    throw new AccountLockedError(`Account locked until ${lockMatch[1].trim()}`, lockedUntil);
  }

  // Extract new session cookie from POST response
  const postSetCookies = postResp.headers.getSetCookie();
  let newCookie = '';
  for (const h of postSetCookies) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) {
      newCookie = m[1];
      break;
    }
  }
  if (!newCookie) {
    throw new Error(`Login POST failed: status=${postResp.status}, no session cookie. Body: ${postBody.substring(0, 200)}`);
  }

  // Keep cookie URL-encoded as received from Set-Cookie.
  // visa-client sends it as-is in Cookie header — decoding corrupts +, =, / chars → 401.
  const cookie = newCookie;

  // Verify success
  if (postResp.status === 200) {
    if (!postBody.includes('window.location')) {
      // Account locked: form returned without error message (not "inválida" — already caught above)
      if (postBody.includes('sign_in_form')) {
        throw new AccountLockedError();
      }
      throw new Error(`Login POST 200 but no redirect in body: ${postBody.substring(0, 200)}`);
    }
  } else if (postResp.status !== 302) {
    throw new Error(`Login POST unexpected status: ${postResp.status}`);
  }

  // Step 3: Optionally fetch appointment page for CSRF tokens
  if (skipTokens) {
    return { cookie, csrfToken: '', authenticityToken: '', hasTokens: false };
  }

  const qs = creds.applicantIds.map((id) => `applicants[]=${id}`).join('&');
  const appointmentUrl = `${nivBaseUrl}/schedule/${creds.scheduleId}/appointment?${qs}&confirmed_limit_message=1&commit=${texts.continueText}`;

  let tokenResp: Response;
  try {
    tokenResp = await fetch(appointmentUrl, {
      headers: {
        'Cookie': `_yatri_session=${cookie}`,
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        ...BROWSER_HEADERS,
      },
      redirect: 'manual',
      // @ts-expect-error undici dispatcher
      ...(dispatcher ? { dispatcher } : {}),
    });
  } catch (fetchErr) {
    const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const cause = fetchErr instanceof Error && fetchErr.cause ? String(fetchErr.cause) : undefined;
    const detail = `fetch_error: ${errMsg}${cause ? ` cause=${cause}` : ''}`;
    console.warn(`[login] Appointment page fetch FAILED: ${detail}`);
    logAuth({ email: creds.email, action: 'token_fetch_failed', locale, result: 'error', errorMessage: detail });
    return { cookie, csrfToken: '', authenticityToken: '', hasTokens: false };
  }

  if (tokenResp.status !== 200) {
    const location = tokenResp.headers.get('location') || '';
    const bodyPreview = await tokenResp.text().catch(() => '(unreadable)');
    const detail = `http_${tokenResp.status} location=${location} body=${bodyPreview.substring(0, 200)}`;
    console.warn(`[login] Appointment page returned HTTP ${tokenResp.status}, location=${location}, body=${bodyPreview.substring(0, 300)}`);
    logAuth({ email: creds.email, action: 'token_fetch_failed', locale, result: 'error', errorMessage: detail });
    return { cookie, csrfToken: '', authenticityToken: '', hasTokens: false };
  }

  const apptHtml = await tokenResp.text();
  const apptCsrfMatch = apptHtml.match(/<meta name="csrf-token" content="([^"]+)"/);
  const authMatch = apptHtml.match(/<input[^>]+name="authenticity_token"[^>]+value="([^"]+)"/);

  if (!apptCsrfMatch?.[1] || !authMatch?.[1]) {
    const hasForm = apptHtml.includes('<form');
    const hasCloudflare = apptHtml.includes('challenge-platform') || apptHtml.includes('cf-chl');
    const titleMatch = apptHtml.match(/<title>([^<]*)<\/title>/);
    const detail = `parse_failed: htmlLen=${apptHtml.length} hasForm=${hasForm} cloudflare=${hasCloudflare} title="${titleMatch?.[1] ?? '(none)'}"`
    console.warn(`[login] Could not extract tokens from appointment page — ${detail}`);
    logAuth({ email: creds.email, action: 'token_fetch_failed', locale, result: 'error', errorMessage: detail });
    return { cookie, csrfToken: '', authenticityToken: '', hasTokens: false };
  }

  return {
    cookie,
    csrfToken: apptCsrfMatch[1],
    authenticityToken: authMatch[1],
    hasTokens: true,
  };
}

// Re-export parseApptDate for external consumers (e.g. visa-client.ts)
export { parseApptDate } from './html-parsers.js';

// ── Discovery ──────────────────────────────────────────

export interface DiscoverResult {
  scheduleId: string;
  userId: string;
  applicantIds: string[];
  applicantNames: string[];
  currentConsularDate: string | null;
  currentConsularTime: string | null;
  currentCasDate: string | null;
  currentCasTime: string | null;
  consularFacilityId: string;
  ascFacilityId: string;
  collectsBiometrics: boolean;
  cookie: string;
  groups: import('./html-parsers.js').GroupInfo[];
}

/**
 * Discover account details from embassy portal using only email + password.
 *
 * 1. Login via IV sign_in → cookie
 * 2. GET /account (follows redirect to /groups/{userId}) → scheduleId + current appointments
 * 3. GET appointment page → applicantIds, applicantNames, facility IDs
 *
 * Total: ~3-4s
 */
export async function discoverAccount(
  email: string,
  password: string,
  locale: string = 'es-co',
  opts: { proxyUrl?: string } = {},
): Promise<DiscoverResult> {
  const baseUrl = getBaseUrl(locale);
  const { proxyUrl } = opts;
  const dispatcher = proxyUrl
    ? new ProxyAgent({ uri: proxyUrl, connectTimeout: 10_000, headersTimeout: 12_000 })
    : undefined;

  // Step 1: Login via pureFetchLogin (skipTokens) — we only need the cookie
  const loginResult = await pureFetchLogin(
    { email, password, scheduleId: '', applicantIds: [], locale },
    { skipTokens: true, proxyUrl },
  );
  let cookie = loginResult.cookie;

  function updateCookie(resp: Response) {
    for (const h of resp.headers.getSetCookie()) {
      const m = h.match(/_yatri_session=([^;]+)/);
      if (m?.[1]) { cookie = m[1]; break; }
    }
  }

  // Step 2: GET /account — it 302s to /groups/{userId}, follow redirects to get final URL
  const accountUrl = `${baseUrl}/account`;
  const accountResp = await fetch(accountUrl, {
    headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html' },
    redirect: 'follow',
    // @ts-expect-error undici dispatcher
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (accountResp.status !== 200) throw new Error(`Account page returned HTTP ${accountResp.status}`);
  updateCookie(accountResp);

  // Extract userId from final URL (e.g. .../groups/51040127)
  const finalUrl = accountResp.url;
  const userIdMatch = finalUrl.match(/\/groups\/(\d+)/);
  if (!userIdMatch?.[1]) throw new Error(`Could not extract userId from account redirect: ${finalUrl}`);
  const userId = userIdMatch[1];

  // The response IS the groups page (followed redirect)
  const groupsHtml = await accountResp.text();

  // Extract scheduleId from links like /schedule/72824354/
  const scheduleId = extractScheduleId(groupsHtml);
  if (!scheduleId) throw new Error('Could not find scheduleId in groups page');

  // Extract all groups (multi-schedule accounts have one group per applicant/family unit)
  const groups = extractGroups(groupsHtml);

  // Find the primary group (matches scheduleId). Multi-schedule accounts (family members with
  // separate appointments from different years) have multiple groups — we only want the active one.
  const primaryGroup = groups.find(g => g.scheduleId === scheduleId);

  // Extract current appointments (primary group — first in page)
  const { currentConsularDate, currentConsularTime, currentCasDate, currentCasTime } = extractAppointments(groupsHtml);

  // Use primary group's applicant IDs only (not all groups — old/past appointments have different applicants)
  const groupsApplicantIds = primaryGroup?.applicantIds ?? extractApplicantIdsFromGroups(groupsHtml);

  // Step 3: GET appointment page → applicantIds, names, facility IDs
  // applicantIds from groups page are needed in query string — without them the server
  // returns an applicant-selection page instead of the appointment form with facility IDs.
  const texts = getLocaleTexts(locale);
  const applicantQs = groupsApplicantIds.length > 0
    ? groupsApplicantIds.map(id => `applicants[]=${id}`).join('&') + '&'
    : '';
  const appointmentUrl = `${baseUrl}/schedule/${scheduleId}/appointment?${applicantQs}confirmed_limit_message=1&commit=${texts.continueText}`;

  let apptHtml = '';
  let apptPageOk = false;

  // First attempt with current cookie
  const apptResp = await fetch(appointmentUrl, {
    headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html' },
    redirect: 'follow',
    // @ts-expect-error undici dispatcher
    ...(dispatcher ? { dispatcher } : {}),
  });
  updateCookie(apptResp);

  if (apptResp.status === 200) {
    apptHtml = await apptResp.text();
    // Detect if we got redirected to sign_in instead of the real appointment page
    // Use facility_id as marker — present on all appointment pages regardless of applicant count
    const isRealApptPage = apptResp.url.includes('/appointment') && apptHtml.includes('facility_id');
    if (isRealApptPage) {
      apptPageOk = true;
    } else {
      console.warn('[discover] Appointment page redirected to sign_in, retrying with full login');
    }
  } else {
    console.warn(`[discover] Appointment page returned HTTP ${apptResp.status}`);
  }

  // Retry with a full login (skipTokens: false) if first attempt failed
  if (!apptPageOk) {
    try {
      const fullLogin = await pureFetchLogin(
        { email, password, scheduleId, applicantIds: [], locale },
        { skipTokens: false, proxyUrl },
      );
      cookie = fullLogin.cookie;

      const retryResp = await fetch(appointmentUrl, {
        headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html' },
        redirect: 'follow',
        // @ts-expect-error undici dispatcher
        ...(dispatcher ? { dispatcher } : {}),
      });
      updateCookie(retryResp);

      if (retryResp.status === 200) {
        const retryHtml = await retryResp.text();
        if (retryResp.url.includes('/appointment') && retryHtml.includes('facility_id')) {
          apptHtml = retryHtml;
          apptPageOk = true;
        }
      }
    } catch (e) {
      console.warn(`[discover] Full login retry failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (!apptPageOk) {
    console.warn('[discover] Could not access appointment page — using fallbacks');
  }

  // Extract applicant IDs: try appointment page checkboxes first, fallback to primary group
  let applicantIds = apptPageOk ? extractApplicantIdsFromAppointment(apptHtml) : [];
  if (applicantIds.length === 0) {
    // Use primary group IDs (not all groups — accounts with multiple schedules have past applicants)
    applicantIds = primaryGroup?.applicantIds ?? extractApplicantIdsFromGroups(groupsHtml);
  }

  // Extract applicant names: try appointment page first, fallback to primary group
  let applicantNames = apptPageOk ? extractApplicantNames('', apptHtml, true) : [];
  if (applicantNames.length === 0 && primaryGroup) {
    applicantNames = primaryGroup.applicantNames;
  }
  if (applicantNames.length === 0) {
    applicantNames = extractApplicantNames(groupsHtml, apptHtml, apptPageOk);
  }

  // Extract facility IDs from appointment page with locale-based fallback
  const { consularFacilityId, ascFacilityId } = extractFacilityIds(apptHtml, apptPageOk, locale);
  const collectsBiometrics = ascFacilityId !== '';

  return {
    scheduleId,
    userId,
    applicantIds,
    applicantNames,
    currentConsularDate,
    currentConsularTime,
    currentCasDate,
    currentCasTime,
    consularFacilityId,
    ascFacilityId,
    collectsBiometrics,
    cookie,
    groups,
  };
}

/**
 * Login with 2-level fallback chain:
 * 1. pureFetchLogin via IV sign_in (less trafficked, same cookies)
 * 2. pureFetchLogin via NIV sign_in (standard path)
 */
export async function performLogin(creds: LoginCredentials): Promise<LoginResult> {
  // Level 1: IV sign_in
  try {
    const result = await pureFetchLogin(creds, { visaType: 'iv' });
    console.log(`[login] IV succeeded — cookie=${result.cookie.length}chars hasTokens=${result.hasTokens} csrf=${result.csrfToken?.substring(0, 10) || '(none)'}`);
    return result;
  } catch (e) {
    if (e instanceof InvalidCredentialsError || e instanceof AccountLockedError) throw e;
    console.warn(`[login] IV failed: ${e instanceof Error ? e.message : e}`);
  }

  // Level 2: NIV sign_in
  const result = await pureFetchLogin(creds, { visaType: 'niv' });
  console.log(`[login] NIV succeeded — cookie=${result.cookie.length}chars hasTokens=${result.hasTokens} csrf=${result.csrfToken?.substring(0, 10) || '(none)'}`);
  return result;
}

function classifyLoginError(e: unknown): string {
  if (!(e instanceof Error)) return `unknown:${String(e)}`;
  const msg = e.message ?? '';
  const cause = e.cause instanceof Error ? e.cause.message : String(e.cause ?? '');
  if (cause.includes('other side closed') || cause.includes('bytesRead: 0')) return 'embassy_tcp_block';
  if (cause.includes('ECONNREFUSED') || cause.includes('Request was cancelled') || msg.includes('Request was cancelled')) return 'proxy_unreachable';
  if (cause.includes('AggregateError') || cause.includes('getaddrinfo')) return 'dns_or_all_failed';
  if (cause.includes('ETIMEDOUT') || cause.includes('connect timeout') || cause.includes('headersTimeout')) return 'timeout';
  return 'network';
}

/**
 * performLogin with Webshare fallback.
 * On network error (not InvalidCredentialsError), tries up to 4 Webshare IPs.
 * Returns { result, via } where via is a compact attempt chain (e.g. "direct:ok",
 * "direct[dns_or_all_failed] → ws:64.137.96.74[ok]"). Suitable for logging.
 */
export async function loginWithFallback(
  creds: LoginCredentials,
): Promise<{ result: LoginResult; via: string }> {
  const attempts: string[] = [];

  try {
    const result = await performLogin(creds);
    return { result, via: 'direct:ok' };
  } catch (e) {
    if (e instanceof InvalidCredentialsError || e instanceof AccountLockedError) throw e;
    const label = classifyLoginError(e);
    attempts.push(`direct[${label}]`);
    console.warn(`[login] Direct failed [${label}]: ${e instanceof Error ? e.message : e}`);
  }

  let webshareUrls: string[];
  try {
    webshareUrls = await getEffectiveWebshareUrls();
  } catch (apiErr) {
    const msg = apiErr instanceof Error ? apiErr.message : String(apiErr);
    console.warn(`[login] Webshare API load failed: ${msg}`);
    attempts.push(`ws_api_error[${msg}]`);
    throw new Error(attempts.join(' → '));
  }
  if (webshareUrls.length === 0) {
    attempts.push('ws_no_ips');
    throw new Error(attempts.join(' → '));
  }

  const candidates = webshareUrls.slice(0, 4);
  const ips = candidates.map(u => { try { return new URL(u).hostname; } catch { return u; } });
  console.log(`[login] Webshare fallback — trying: ${ips.join(', ')}`);

  let lastRawErr: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const proxyUrl = candidates[i];
    const ip = ips[i];
    try {
      console.log(`[login] → ws:${ip}`);
      const result = await pureFetchLogin(creds, { proxyUrl });
      attempts.push(`ws:${ip}[ok]`);
      console.log(`[login] ✓ ws:${ip} succeeded`);
      return { result, via: attempts.join(' → ') };
    } catch (e2) {
      if (e2 instanceof InvalidCredentialsError || e2 instanceof AccountLockedError) throw e2;
      const label = classifyLoginError(e2);
      attempts.push(`ws:${ip}[${label}]`);
      console.warn(`[login] ✗ ws:${ip} [${label}]: ${e2 instanceof Error ? e2.message : e2}`);
      lastRawErr = e2;
    }
  }

  const chain = attempts.join(' → ');
  console.warn(`[login] All attempts failed: ${chain}`);
  const err = new Error(chain);
  if (lastRawErr instanceof Error) err.cause = lastRawErr.cause;
  throw err;
}

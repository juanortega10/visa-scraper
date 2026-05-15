import { ProxyAgent } from 'undici';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl, getLocaleTexts } from '../utils/constants.js';
import type { VisaSession } from './visa-client.js';
import { logAuth } from '../utils/auth-logger.js';
import { getEffectiveWebshareUrls } from './proxy-fetch.js';
import {
  extractScheduleId,
  extractApplicantIdsFromGroups,
  extractApplicantNames,
  extractFacilityIds,
  extractGroups,
  extractScheduleApplicantPairs,
  hasKnownFacilities,
  AppointmentFormMissingError,
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
    ...(dispatcher ? { dispatcher } : {}),
  });

  const postBody = await postResp.text();

  // Check for explicit account lock message first (language-independent regex)
  const lockMatch = postBody.match(/account is locked until ([^<.]+)/i);
  if (lockMatch) {
    const lockStr = lockMatch[1]!.trim();
    let lockedUntil: Date | undefined;
    try { lockedUntil = new Date(lockStr); } catch { /* unparseable */ }
    throw new AccountLockedError(`Account locked until ${lockStr}`, lockedUntil);
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
      // Structural check: sign_in_form re-rendered = credential failure (language-independent)
      if (postBody.includes('sign_in_form')) {
        throw new InvalidCredentialsError();
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
  /** Per-applicant raw visa-type labels for the primary group (in DOM order). */
  applicantVisaTypes: string[];
  /** Most common normalized visa category (e.g. "B1/B2", "F1", "J1"). null if unparseable. */
  primaryVisaCategory: string | null;
  /** First non-null raw label from the primary group — full Spanish/English description. */
  primaryVisaTypeRaw: string | null;
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
 * 2. GET /account (follows redirect to /groups/{userId}) → scheduleId + applicantIds
 *    from gear dropdown links (/schedule/{id}/applicants/{id}) + appointments + names
 *
 * No appointment-page fetch needed — all required IDs are in the gear links on the groups page.
 * Total: ~2s
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

  // Step 2: GET /account — 302s to /groups/{userId}
  const accountUrl = `${baseUrl}/account`;
  const accountResp = await fetch(accountUrl, {
    headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html' },
    redirect: 'follow',
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (accountResp.status !== 200) throw new Error(`Account page returned HTTP ${accountResp.status}`);
  updateCookie(accountResp);

  // Extract userId from final URL (e.g. .../groups/51040127)
  const finalUrl = accountResp.url;
  const userIdMatch = finalUrl.match(/\/groups\/(\d+)/);
  if (!userIdMatch?.[1]) throw new Error(`Could not extract userId from account redirect: ${finalUrl}`);
  const userId = userIdMatch[1];

  const groupsHtml = await accountResp.text();

  // Extract all groups and schedule→applicant pairings from gear dropdown links
  const groups = extractGroups(groupsHtml);
  const pairs = extractScheduleApplicantPairs(groupsHtml);

  // Primary group: prefer first with a future consular date (filters out CAS-only groups
  // and past appointments). Fall back to first group overall.
  const today = new Date().toISOString().slice(0, 10);
  const primaryGroup = groups.find(g => g.currentConsularDate != null && g.currentConsularDate > today)
    ?? groups[0];

  const primaryScheduleId = primaryGroup?.scheduleId
    ?? pairs.keys().next().value
    ?? extractScheduleId(groupsHtml);

  if (!primaryScheduleId) throw new Error('Could not find scheduleId in groups page');

  // Applicant IDs from gear links for primary schedule (deduped, in DOM order)
  const applicantIds = pairs.get(primaryScheduleId)
    ?? primaryGroup?.applicantIds
    ?? extractApplicantIdsFromGroups(groupsHtml);

  // Names from groups page <td> fallback
  const applicantNames = primaryGroup?.applicantNames.length
    ? primaryGroup.applicantNames
    : extractApplicantNames(groupsHtml, '', false);

  // Appointments scoped to primary group section (avoids picking dates from secondary groups)
  const currentConsularDate = primaryGroup?.currentConsularDate ?? null;
  const currentConsularTime = primaryGroup?.currentConsularTime ?? null;
  const currentCasDate = primaryGroup?.currentCasDate ?? null;
  const currentCasTime = primaryGroup?.currentCasTime ?? null;

  // Visa types from the primary group (zero extra requests — already parsed from groups page)
  const applicantVisaTypes = primaryGroup?.applicantVisaTypes ?? [];
  const primaryVisaCategory = primaryGroup?.primaryVisaCategory ?? null;
  const primaryVisaTypeRaw = applicantVisaTypes.find(Boolean) ?? null;

  // Facility IDs: prefer locale-based known values; if the locale isn't in the
  // KNOWN_FACILITIES map (any country beyond CO/PE), live-fetch the appointment
  // page and parse the <select> blocks. Costs ~1 extra request but works for
  // any new locale without code changes.
  let consularFacilityId = '';
  let ascFacilityId = '';
  if (hasKnownFacilities(locale)) {
    ({ consularFacilityId, ascFacilityId } = extractFacilityIds('', false, locale));
  } else if (primaryScheduleId && applicantIds.length > 0) {
    try {
      // Match pureFetchLogin's URL: confirmed_limit_message=1 skips the
      // intersticial warning page that appears when the user has any
      // reschedules remaining (fr-ca, en-ca, etc.). Without it, we land on
      // "Avertissement Limite de Rendez-vous" which has no facility <select>.
      const texts = getLocaleTexts(locale);
      const qs = applicantIds.map((id) => `applicants[]=${id}`).join('&');
      const apptUrl = `${baseUrl}/schedule/${primaryScheduleId}/appointment?${qs}&confirmed_limit_message=1&commit=${encodeURIComponent(texts.continueText)}`;
      const apptResp = await fetch(apptUrl, {
        headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html' },
        redirect: 'follow',
        ...(dispatcher ? { dispatcher } : {}),
      });
      if (apptResp.status === 200) {
        updateCookie(apptResp);
        const apptHtml = await apptResp.text();
        ({ consularFacilityId, ascFacilityId } = extractFacilityIds(apptHtml, true, locale));
      } else {
        console.warn(`[discover] facility live-fetch HTTP ${apptResp.status} locale=${locale}`);
      }
    } catch (e) {
      if (e instanceof AppointmentFormMissingError) {
        // Form structure missing on live page — bubble up so the user can retry
        // (typical cause: portal overload, transient block, or partial render).
        console.warn(`[discover] facility live-fetch form_missing locale=${locale} overload=${e.hasOverloadMarker}`);
        throw e;
      }
      console.warn(`[discover] facility live-fetch failed locale=${locale}: ${e instanceof Error ? e.message : e}`);
    }
  }
  const collectsBiometrics = ascFacilityId !== '';

  return {
    scheduleId: primaryScheduleId,
    userId,
    applicantIds,
    applicantNames,
    applicantVisaTypes,
    primaryVisaCategory,
    primaryVisaTypeRaw,
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
  const locale = creds.locale ?? 'es-co';

  // es-pe goes directly to NIV — IV endpoint doesn't exist for Peru
  if (!locale.startsWith('es-pe')) {
    // Level 1: IV sign_in
    try {
      const result = await pureFetchLogin(creds, { visaType: 'iv' });
      console.log(`[login] IV succeeded — cookie=${result.cookie.length}chars hasTokens=${result.hasTokens} csrf=${result.csrfToken?.substring(0, 10) || '(none)'}`);
      return result;
    } catch (e) {
      if (e instanceof InvalidCredentialsError || e instanceof AccountLockedError) throw e;
      console.warn(`[login] IV failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Level 2 (or direct for es-pe): NIV sign_in
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

import { USER_AGENT, getBaseUrl, getLocaleTexts } from '../utils/constants.js';
import type { VisaSession } from './visa-client.js';

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

interface PureFetchLoginOptions {
  /** Skip fetching appointment page for tokens (faster, ~970ms vs ~1.7s) */
  skipTokens?: boolean;
  /** Which sign_in page to use for initial cookie. IV is less trafficked. */
  visaType?: 'iv' | 'niv';
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
  const { skipTokens = false, visaType = 'iv' } = opts;
  const locale = creds.locale ?? 'es-co';
  const nivBaseUrl = getBaseUrl(locale);
  const texts = getLocaleTexts(locale);
  const cookieSourceUrl = `https://ais.usvisa-info.com/${locale}/${visaType}/users/sign_in`;
  const nivSignInUrl = `${nivBaseUrl}/users/sign_in`;

  // Step 1: GET sign_in page to get _yatri_session cookie + CSRF
  const getResp = await fetch(cookieSourceUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html',
    },
    redirect: 'follow',
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
    },
    body: new URLSearchParams({
      'user[email]': creds.email,
      'user[password]': creds.password,
      'policy_confirmed': '1',
      'commit': commitText,
    }).toString(),
    redirect: 'manual',
  });

  // Check for invalid credentials
  const postBody = await postResp.text();
  if (postBody.includes('inválida') || postBody.includes('Invalid Email or password')) {
    throw new InvalidCredentialsError();
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

  const tokenResp = await fetch(appointmentUrl, {
    headers: {
      'Cookie': `_yatri_session=${cookie}`,
      'User-Agent': USER_AGENT,
      'Accept': 'text/html',
    },
    redirect: 'follow',
  });

  if (tokenResp.status !== 200) {
    console.warn(`[login] Appointment page returned ${tokenResp.status}, returning cookie without tokens`);
    return { cookie, csrfToken: '', authenticityToken: '', hasTokens: false };
  }

  const apptHtml = await tokenResp.text();
  const apptCsrfMatch = apptHtml.match(/<meta name="csrf-token" content="([^"]+)"/);
  const authMatch = apptHtml.match(/<input[^>]+name="authenticity_token"[^>]+value="([^"]+)"/);

  if (!apptCsrfMatch?.[1] || !authMatch?.[1]) {
    console.warn('[login] Could not extract tokens from appointment page, returning cookie only');
    return { cookie, csrfToken: '', authenticityToken: '', hasTokens: false };
  }

  return {
    cookie,
    csrfToken: apptCsrfMatch[1],
    authenticityToken: authMatch[1],
    hasTokens: true,
  };
}

// ── Known facility IDs per locale (fallback when appointment page is inaccessible) ──

const KNOWN_FACILITIES: Record<string, { consular: string; asc: string }> = {
  'es-co': { consular: '25', asc: '26' },
  'es-pe': { consular: '115', asc: '' },
  // Add more as discovered
};

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
}

// Month map for parsing dates (same as visa-client.ts)
const MONTH_MAP: Record<string, string> = {
  enero: '01', febrero: '02', marzo: '03', abril: '04',
  mayo: '05', junio: '06', julio: '07', agosto: '08',
  septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12',
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};

function parseApptDate(text: string): { date: string; time: string } | null {
  const match = text.match(/(\d{1,2})\s+(\w+),\s*(\d{4}),\s*(\d{2}:\d{2})/);
  if (!match) return null;
  const [, day, monthName, year, time] = match;
  const month = MONTH_MAP[monthName!.toLowerCase()];
  if (!month) return null;
  return { date: `${year}-${month}-${day!.padStart(2, '0')}`, time: time! };
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
): Promise<DiscoverResult> {
  const baseUrl = getBaseUrl(locale);

  // Step 1: Login via pureFetchLogin (skipTokens) — we only need the cookie
  const loginResult = await pureFetchLogin(
    { email, password, scheduleId: '', applicantIds: [], locale },
    { skipTokens: true },
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
  const scheduleMatch = groupsHtml.match(/\/schedule\/(\d+)/);
  if (!scheduleMatch?.[1]) throw new Error('Could not find scheduleId in groups page');
  const scheduleId = scheduleMatch[1];

  // Extract current appointments
  let currentConsularDate: string | null = null;
  let currentConsularTime: string | null = null;
  let currentCasDate: string | null = null;
  let currentCasTime: string | null = null;

  const consularApptMatch = groupsHtml.match(/<p class='consular-appt'>[\s\S]*?<\/strong>\s*\n?\s*([^<&]+)/);
  if (consularApptMatch?.[1]) {
    const parsed = parseApptDate(consularApptMatch[1].trim());
    if (parsed) { currentConsularDate = parsed.date; currentConsularTime = parsed.time; }
  }

  const casApptMatch = groupsHtml.match(/<p class='asc-appt'>[\s\S]*?<\/strong>\s*\n?\s*([^<&]+)/);
  if (casApptMatch?.[1]) {
    const parsed = parseApptDate(casApptMatch[1].trim());
    if (parsed) { currentCasDate = parsed.date; currentCasTime = parsed.time; }
  }

  // Pre-extract applicant IDs from groups page (needed in appointment URL)
  const groupsApplicantIds: string[] = [];
  {
    const groupsApplicantRegex = /\/applicants\/(\d+)/g;
    const seen = new Set<string>();
    let gMatch;
    while ((gMatch = groupsApplicantRegex.exec(groupsHtml)) !== null) {
      if (!seen.has(gMatch[1]!)) {
        seen.add(gMatch[1]!);
        groupsApplicantIds.push(gMatch[1]!);
      }
    }
  }

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
        { skipTokens: false },
      );
      cookie = fullLogin.cookie;

      const retryResp = await fetch(appointmentUrl, {
        headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html' },
        redirect: 'follow',
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

  // Extract applicant IDs from checkboxes: <input ... name="applicants[]" ... value="87117943" ...>
  const applicantIds: string[] = [];
  if (apptPageOk) {
    const applicantIdRegex = /name="applicants\[\]"[^>]*value="(\d+)"/g;
    let idMatch;
    while ((idMatch = applicantIdRegex.exec(apptHtml)) !== null) {
      applicantIds.push(idMatch[1]!);
    }
    if (applicantIds.length === 0) {
      // Try reverse attribute order: value before name
      const reverseRegex = /value="(\d+)"[^>]*name="applicants\[\]"/g;
      while ((idMatch = reverseRegex.exec(apptHtml)) !== null) {
        applicantIds.push(idMatch[1]!);
      }
    }
  }
  if (applicantIds.length === 0) {
    // Fallback: extract from groups page links like /applicants/87066525
    const groupsApplicantRegex = /\/applicants\/(\d+)/g;
    const seen = new Set<string>();
    let gMatch;
    while ((gMatch = groupsApplicantRegex.exec(groupsHtml)) !== null) {
      if (!seen.has(gMatch[1]!)) {
        seen.add(gMatch[1]!);
        applicantIds.push(gMatch[1]!);
      }
    }
  }

  // Extract applicant names — they're text nodes after each checkbox:
  // <input type="checkbox" name="applicants[]" ... value="87117943" ... />\nJuan Alberto Ortega Riveros\n<br>
  const applicantNames: string[] = [];
  if (apptPageOk) {
    const nameRegex = /name="applicants\[\]"[^>]*\/>\s*\n?\s*([^\n<]+)/g;
    let nameMatch;
    while ((nameMatch = nameRegex.exec(apptHtml)) !== null) {
      const name = nameMatch[1]!.trim();
      if (name) applicantNames.push(name);
    }
  }
  if (applicantNames.length === 0) {
    // Fallback: extract names from groups page table (Peru has names in <td> before passport number)
    const tdNameRegex = /<td>([A-Z][a-záéíóúñ]+(?: [A-Z][a-záéíóúñ]+)+)<\/td>/g;
    let tdMatch;
    while ((tdMatch = tdNameRegex.exec(groupsHtml)) !== null) {
      applicantNames.push(tdMatch[1]!);
    }
  }

  // Extract consular facility ID from the appointment form
  let consularFacilityId = '';
  if (apptPageOk) {
    const consularFacilityMatch = apptHtml.match(/consulate_appointment_facility_id[\s\S]*?value="(\d+)"/);
    if (consularFacilityMatch?.[1]) consularFacilityId = consularFacilityMatch[1];
  }
  // Fallback: known facilities map
  if (!consularFacilityId) {
    const knownFacility = KNOWN_FACILITIES[locale];
    if (knownFacility) consularFacilityId = knownFacility.consular;
  }

  // Extract ASC facility ID from select dropdown
  let ascFacilityId = '';
  if (apptPageOk) {
    const ascMatch = apptHtml.match(/<select[^>]+asc_appointment_facility_id[^>]*>[\s\S]*?<option[^>]+value="(\d+)"/);
    if (ascMatch?.[1]) ascFacilityId = ascMatch[1];
  }
  // Fallback: known facilities
  if (!ascFacilityId) {
    const knownFacility = KNOWN_FACILITIES[locale];
    if (knownFacility?.asc) ascFacilityId = knownFacility.asc;
  }

  // Biometrics/ASC is required if an ASC facility section exists in the form.
  // The data-collects-biometrics attribute on the consular option is unreliable
  // (Colombia has "false" but still requires ASC).
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
    if (e instanceof InvalidCredentialsError) throw e;
    console.warn(`[login] IV failed: ${e instanceof Error ? e.message : e}`);
  }

  // Level 2: NIV sign_in
  const result = await pureFetchLogin(creds, { visaType: 'niv' });
  console.log(`[login] NIV succeeded — cookie=${result.cookie.length}chars hasTokens=${result.hasTokens} csrf=${result.csrfToken?.substring(0, 10) || '(none)'}`);
  return result;
}

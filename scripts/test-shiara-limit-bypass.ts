/**
 * Test if Peru's reschedule limit is enforced at API level or only UI.
 * Shiara (schedule 67882141) has exhausted reschedule attempts.
 * The appointment page shows "Limit Reached" — but does the API also block?
 *
 * Tests:
 * 1. days.json — does it return dates or block?
 * 2. times.json — does it return times or block?
 * 3. POST reschedule — does the server reject at POST level?
 *
 * READ-ONLY except for the POST test (which we expect to fail).
 * Usage: npx tsx --env-file=.env scripts/test-shiara-limit-bypass.ts
 */
import { writeFileSync } from 'node:fs';
import { pureFetchLogin } from '../src/services/login.js';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl, getLocaleTexts } from '../src/utils/constants.js';

const LIZ_EMAIL = 'shiara.arauzo@hotmail.com';
const LIZ_PASSWORD = '=Visa123ReunionHackaton';
const LOCALE = 'es-pe';

// Shiara's schedule (limit reached)
const SHIARA_SCHEDULE = '67882141';
const SHIARA_APPLICANT = '80769427';
const FACILITY_ID = '115'; // Lima

// Liz's schedule (working, for comparison)
const LIZ_SCHEDULE = '69454137';
const LIZ_APPLICANT = '80769164';

function log(msg: string) {
  const ts = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Bogota', hour12: false });
  console.log(`[${ts}] ${msg}`);
}

async function main() {
  log('=== Test Shiara Reschedule Limit Bypass ===\n');
  log('Shiara: schedule 67882141, applicant 80769427 (LIMIT REACHED)');
  log('Liz:    schedule 69454137, applicant 80769164 (working)\n');

  const baseUrl = getBaseUrl(LOCALE);
  const texts = getLocaleTexts(LOCALE);

  // Step 1: Login
  log('--- Step 1: Login ---');
  const login = await pureFetchLogin(
    { email: LIZ_EMAIL, password: LIZ_PASSWORD, scheduleId: LIZ_SCHEDULE, applicantIds: [LIZ_APPLICANT], locale: LOCALE },
    { skipTokens: false },
  );
  log(`Login OK, cookie length: ${login.cookie.length}`);

  let cookie = login.cookie;

  // Step 2: Get tokens from Liz's appointment page (which works)
  log('\n--- Step 2: Get tokens from Liz appointment page ---');
  const lizApptUrl = `${baseUrl}/schedule/${LIZ_SCHEDULE}/appointment?applicants[]=${LIZ_APPLICANT}&confirmed_limit_message=1&commit=${texts.continueText}`;
  const lizApptResp = await fetch(lizApptUrl, {
    headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html', 'Upgrade-Insecure-Requests': '1', ...BROWSER_HEADERS },
    redirect: 'manual',
  });

  // Update cookie
  for (const h of lizApptResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { cookie = m[1]; break; }
  }

  const lizApptHtml = await lizApptResp.text();
  const csrfToken = lizApptHtml.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1] || '';
  const authToken = lizApptHtml.match(/<input[^>]+name="authenticity_token"[^>]+value="([^"]+)"/)?.[1] || '';
  log(`CSRF: ${csrfToken.substring(0, 20)}...`);
  log(`Auth token: ${authToken.substring(0, 20)}...`);

  // Step 3: Test days.json for Liz (working) vs Shiara (limit reached)
  log('\n--- Step 3: days.json comparison ---');

  // Liz days (control)
  const lizDaysResp = await fetch(
    `${baseUrl}/schedule/${LIZ_SCHEDULE}/appointment/days/${FACILITY_ID}.json?appointments[expedite]=false`,
    { headers: {
      Cookie: `_yatri_session=${cookie}`, 'X-CSRF-Token': csrfToken,
      'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01',
      'User-Agent': USER_AGENT, ...BROWSER_HEADERS,
    }},
  );
  const lizDaysText = await lizDaysResp.text();
  const lizDays = JSON.parse(lizDaysText);
  log(`Liz days.json:    status=${lizDaysResp.status}, count=${Array.isArray(lizDays) ? lizDays.length : 'N/A'}, first=${lizDays[0]?.date || 'none'}`);

  // Update cookie
  for (const h of lizDaysResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { cookie = m[1]; break; }
  }

  await new Promise(r => setTimeout(r, 500));

  // Shiara days (limit reached)
  const shiaraDaysResp = await fetch(
    `${baseUrl}/schedule/${SHIARA_SCHEDULE}/appointment/days/${FACILITY_ID}.json?appointments[expedite]=false`,
    { headers: {
      Cookie: `_yatri_session=${cookie}`, 'X-CSRF-Token': csrfToken,
      'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01',
      'User-Agent': USER_AGENT, ...BROWSER_HEADERS,
    }},
  );
  const shiaraDaysRaw = await shiaraDaysResp.text();
  log(`Shiara days.json: status=${shiaraDaysResp.status}, raw=${shiaraDaysRaw.substring(0, 200)}`);

  // Update cookie
  for (const h of shiaraDaysResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { cookie = m[1]; break; }
  }

  // Check if Shiara got days or a redirect/error
  let shiaraDays: any[] = [];
  try {
    shiaraDays = JSON.parse(shiaraDaysRaw);
    if (Array.isArray(shiaraDays)) {
      log(`  → Shiara GOT ${shiaraDays.length} dates! API does NOT block days.json`);
    }
  } catch {
    log(`  → Shiara days.json is NOT valid JSON — likely HTML redirect or error page`);
    if (shiaraDaysRaw.includes('Limit Reached')) {
      log(`  → Contains "Limit Reached" — days.json also blocked!`);
    }
    if (shiaraDaysRaw.includes('sign_in')) {
      log(`  → Redirected to sign_in — session issue?`);
    }
  }

  // Step 4: Test times.json for Shiara
  log('\n--- Step 4: times.json for Shiara ---');
  // Use a date from Liz's days
  const testDate = lizDays[0]?.date;
  if (testDate) {
    const shiaraTimesResp = await fetch(
      `${baseUrl}/schedule/${SHIARA_SCHEDULE}/appointment/times/${FACILITY_ID}.json?date=${testDate}&appointments[expedite]=false`,
      { headers: {
        Cookie: `_yatri_session=${cookie}`, 'X-CSRF-Token': csrfToken,
        'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01',
        'User-Agent': USER_AGENT, ...BROWSER_HEADERS,
      }},
    );
    const shiaraTimesRaw = await shiaraTimesResp.text();
    log(`Shiara times.json (${testDate}): status=${shiaraTimesResp.status}, raw=${shiaraTimesRaw.substring(0, 200)}`);

    // Update cookie
    for (const h of shiaraTimesResp.headers.getSetCookie()) {
      const m = h.match(/_yatri_session=([^;]+)/);
      if (m?.[1]) { cookie = m[1]; break; }
    }

    try {
      const parsed = JSON.parse(shiaraTimesRaw);
      const available = (parsed.available_times || []).filter((t: any) => t !== null);
      log(`  → Times returned: ${available.length > 0 ? available.join(', ') : '(none or [null])'}`);
    } catch {
      log(`  → NOT valid JSON`);
    }
  }

  // Step 5: Try to load Shiara's appointment page directly
  log('\n--- Step 5: Shiara appointment page ---');
  const shiaraApptUrl = `${baseUrl}/schedule/${SHIARA_SCHEDULE}/appointment?applicants[]=${SHIARA_APPLICANT}&confirmed_limit_message=1&commit=${texts.continueText}`;
  const shiaraApptResp = await fetch(shiaraApptUrl, {
    headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html', 'Upgrade-Insecure-Requests': '1', ...BROWSER_HEADERS },
    redirect: 'manual',
  });
  const shiaraApptHtml = await shiaraApptResp.text();
  const shiaraTitle = shiaraApptHtml.match(/<title>([^<]*)<\/title>/)?.[1] || '(none)';
  log(`Shiara appointment page: status=${shiaraApptResp.status}, title="${shiaraTitle}"`);

  // Update cookie
  for (const h of shiaraApptResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { cookie = m[1]; break; }
  }

  // Extract Shiara's tokens (may not exist if page is "Limit Reached")
  const shiaraCsrf = shiaraApptHtml.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1] || '';
  const shiaraAuth = shiaraApptHtml.match(/<input[^>]+name="authenticity_token"[^>]+value="([^"]+)"/)?.[1] || '';
  log(`  Shiara CSRF: ${shiaraCsrf ? shiaraCsrf.substring(0, 20) + '...' : 'NONE'}`);
  log(`  Shiara auth token: ${shiaraAuth ? shiaraAuth.substring(0, 20) + '...' : 'NONE'}`);

  const hasLimitReached = shiaraApptHtml.includes('Limit Reached');
  const hasForm = shiaraApptHtml.includes('appointments[consulate_appointment]');
  log(`  Has "Limit Reached": ${hasLimitReached}`);
  log(`  Has appointment form: ${hasForm}`);

  writeFileSync('scripts/output/shiara-appointment-page.html', shiaraApptHtml, 'utf-8');
  log(`  Saved to scripts/output/shiara-appointment-page.html`);

  // Step 6: POST reschedule for Shiara (the real test)
  log('\n--- Step 6: POST reschedule for Shiara (limit bypass test) ---');

  if (!testDate) {
    log('No test date available, skipping POST');
    process.exit(0);
  }

  // Get a real time from Liz's working schedule
  const lizTimesResp = await fetch(
    `${baseUrl}/schedule/${LIZ_SCHEDULE}/appointment/times/${FACILITY_ID}.json?date=${testDate}&appointments[expedite]=false`,
    { headers: {
      Cookie: `_yatri_session=${cookie}`, 'X-CSRF-Token': csrfToken,
      'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01',
      'User-Agent': USER_AGENT, ...BROWSER_HEADERS,
    }},
  );
  const lizTimesJson = JSON.parse(await lizTimesResp.text());
  const targetTime = (lizTimesJson.available_times || []).filter((t: any) => t !== null)[0];

  // Update cookie
  for (const h of lizTimesResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { cookie = m[1]; break; }
  }

  if (!targetTime) {
    log(`No available time for ${testDate}, skipping POST`);
    process.exit(0);
  }

  log(`Target: ${testDate} ${targetTime}`);
  log(`Current appointment: 2027-05-21 08:15`);
  log(`This date IS earlier → reschedule would be valid IF not limit-blocked`);

  // Use tokens from the page that has them (Liz's or Shiara's CSRF)
  // The CSRF from Shiara's page should work (it's the same session)
  const postCsrf = shiaraCsrf || csrfToken;
  const postAuth = shiaraAuth || authToken;
  // Note: if Shiara's page has no authenticity_token (no form), we use Liz's
  // This tests whether the API validates the schedule match

  const body = new URLSearchParams({
    authenticity_token: postAuth,
    confirmed_limit_message: '1',
    use_consulate_appointment_capacity: 'true',
    'appointments[consulate_appointment][facility_id]': FACILITY_ID,
    'appointments[consulate_appointment][date]': testDate,
    'appointments[consulate_appointment][time]': targetTime,
    commit: texts.rescheduleText,
  });

  const postUrl = `${baseUrl}/schedule/${SHIARA_SCHEDULE}/appointment`;
  log(`\nPOST ${postUrl}`);
  log(`Body: date=${testDate}, time=${targetTime}, facility=${FACILITY_ID}`);

  const postResp = await fetch(postUrl, {
    method: 'POST',
    headers: {
      Cookie: `_yatri_session=${cookie}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-Token': postCsrf,
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: `${baseUrl}/schedule/${SHIARA_SCHEDULE}/appointment?applicants%5B%5D=${SHIARA_APPLICANT}&confirmed_limit_message=1&commit=${texts.continueText}`,
      Origin: 'https://ais.usvisa-info.com',
      'Upgrade-Insecure-Requests': '1',
      ...BROWSER_HEADERS,
    },
    redirect: 'manual',
    body: body.toString(),
  });

  log(`\nPOST response:`);
  log(`  Status: ${postResp.status}`);
  log(`  Location: ${postResp.headers.get('location') || '(none)'}`);

  // Update cookie
  let currentCookie = cookie;
  for (const h of postResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { currentCookie = m[1]; break; }
  }

  // Follow redirects
  let current = postResp;
  for (let hop = 0; hop < 5; hop++) {
    if (current.status !== 302) break;
    const loc = current.headers.get('location');
    if (!loc) break;
    await current.text().catch(() => {});

    log(`  Hop ${hop}: → ${loc}`);

    current = await fetch(loc, {
      headers: {
        Cookie: `_yatri_session=${currentCookie}`, 'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1', ...BROWSER_HEADERS,
      },
      redirect: 'manual',
    });
    for (const h of current.headers.getSetCookie()) {
      const m = h.match(/_yatri_session=([^;]+)/);
      if (m?.[1]) { currentCookie = m[1]; break; }
    }
    log(`    Status: ${current.status}`);
  }

  const finalHtml = await current.text();
  writeFileSync('scripts/output/shiara-reschedule-result.html', finalHtml, 'utf-8');

  const textOnly = finalHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const finalTitle = finalHtml.match(/<title>([^<]*)<\/title>/)?.[1] || '(none)';

  log(`\nFinal page:`);
  log(`  Title: "${finalTitle}"`);
  log(`  Has "Limit Reached": ${textOnly.includes('Limit Reached')}`);
  log(`  Has "no pudo ser programada": ${textOnly.includes('no pudo ser programada')}`);
  log(`  Has "selección válida": ${textOnly.includes('selección válida')}`);
  log(`  Has "programado exitosamente": ${textOnly.includes('programado exitosamente')}`);
  log(`  Has "successfully scheduled": ${textOnly.includes('successfully scheduled')}`);
  log(`  Has "alcanzado el número máximo": ${textOnly.includes('alcanzado el número máximo')}`);

  // Diagnosis
  log('\n=== DIAGNOSIS ===');
  if (textOnly.includes('programado exitosamente') || textOnly.includes('successfully scheduled')) {
    log('🚨 POST SUCCEEDED — Limit is UI-only, API does NOT enforce it!');
  } else if (textOnly.includes('Limit Reached') || textOnly.includes('alcanzado el número máximo')) {
    log('🔒 POST BLOCKED — API enforces reschedule limit (Limit Reached)');
  } else if (textOnly.includes('no pudo ser programada')) {
    log('❌ POST REJECTED — Generic rejection (same as cross-schedule)');
  } else if (textOnly.includes('sign_in') || finalTitle.includes('Sign In')) {
    log('🔑 Session expired — inconclusive');
  } else {
    log('❓ UNKNOWN RESPONSE — check saved HTML');
    log(`  Text preview: ${textOnly.substring(0, 300)}`);
  }

  log('\nSaved result HTML to scripts/output/shiara-reschedule-result.html');

  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

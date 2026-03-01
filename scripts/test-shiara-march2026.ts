/**
 * Test reschedule limit bypass for Shiara using March 2026 dates.
 * Shiara's days.json shows 2027+ only. Liz sees March 2026.
 * We fetch real date+time from Liz, then POST on Shiara's schedule.
 *
 * Improvement over previous attempt:
 * - Only attempts March 2026 dates
 * - Refreshes tokens on Shiara's schedule via continue_actions page
 *   (appointment page shows "Limit Reached" with no form/auth token)
 * - Tries multiple token sources to isolate what blocks the POST
 *
 * Usage: npx tsx --env-file=.env scripts/test-shiara-march2026.ts
 */
import { writeFileSync } from 'node:fs';
import { pureFetchLogin } from '../src/services/login.js';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl, getLocaleTexts } from '../src/utils/constants.js';

const LIZ_EMAIL = 'shiara.arauzo@hotmail.com';
const LIZ_PASSWORD = '=Visa123ReunionHackaton';
const LOCALE = 'es-pe';

const SHIARA_SCHEDULE = '67882141';
const SHIARA_APPLICANT = '80769427';
const LIZ_SCHEDULE = '69454137';
const LIZ_APPLICANT = '80769164';
const FACILITY_ID = '115';

function log(msg: string) {
  const ts = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Bogota', hour12: false });
  console.log(`[${ts}] ${msg}`);
}

async function updateCookie(resp: Response, current: string): Promise<string> {
  for (const h of resp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) return m[1];
  }
  return current;
}

async function main() {
  log('=== Shiara March 2026 Reschedule Limit Test ===\n');

  const baseUrl = getBaseUrl(LOCALE);
  const texts = getLocaleTexts(LOCALE);

  // 1. Login
  log('--- Login ---');
  const login = await pureFetchLogin(
    { email: LIZ_EMAIL, password: LIZ_PASSWORD, scheduleId: LIZ_SCHEDULE, applicantIds: [LIZ_APPLICANT], locale: LOCALE },
    { skipTokens: false },
  );
  let cookie = login.cookie;
  log('Login OK');

  // 2. Refresh tokens on Liz's appointment page (working schedule)
  log('\n--- Liz: appointment page (tokens) ---');
  const lizApptResp = await fetch(
    `${baseUrl}/schedule/${LIZ_SCHEDULE}/appointment?applicants[]=${LIZ_APPLICANT}&confirmed_limit_message=1&commit=${texts.continueText}`,
    { headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html', 'Upgrade-Insecure-Requests': '1', ...BROWSER_HEADERS }, redirect: 'manual' },
  );
  cookie = await updateCookie(lizApptResp, cookie);
  const lizHtml = await lizApptResp.text();
  const lizCsrf = lizHtml.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1] || '';
  const lizAuth = lizHtml.match(/<input[^>]+name="authenticity_token"[^>]+value="([^"]+)"/)?.[1] || '';
  log(`Liz CSRF: ${lizCsrf.substring(0, 25)}...`);
  log(`Liz auth: ${lizAuth.substring(0, 25)}...`);

  // 3. Get March 2026 dates from Liz
  log('\n--- Liz: fetch March 2026 dates + times ---');
  const daysResp = await fetch(
    `${baseUrl}/schedule/${LIZ_SCHEDULE}/appointment/days/${FACILITY_ID}.json?appointments[expedite]=false`,
    { headers: { Cookie: `_yatri_session=${cookie}`, 'X-CSRF-Token': lizCsrf, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01', 'User-Agent': USER_AGENT, ...BROWSER_HEADERS } },
  );
  cookie = await updateCookie(daysResp, cookie);
  const allDays: { date: string }[] = JSON.parse(await daysResp.text());
  const marchDates = allDays.filter(d => d.date.startsWith('2026-03')).map(d => d.date);
  log(`Total dates: ${allDays.length}, March 2026: ${marchDates.length}`);

  if (marchDates.length === 0) {
    log('No March 2026 dates available from Liz. Aborting.');
    process.exit(0);
  }
  log(`March dates: ${marchDates.join(', ')}`);

  // Get times for first March date
  const targetDate = marchDates[0]!;
  await new Promise(r => setTimeout(r, 300));

  const timesResp = await fetch(
    `${baseUrl}/schedule/${LIZ_SCHEDULE}/appointment/times/${FACILITY_ID}.json?date=${targetDate}&appointments[expedite]=false`,
    { headers: { Cookie: `_yatri_session=${cookie}`, 'X-CSRF-Token': lizCsrf, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01', 'User-Agent': USER_AGENT, ...BROWSER_HEADERS } },
  );
  cookie = await updateCookie(timesResp, cookie);
  const timesJson = JSON.parse(await timesResp.text());
  const availTimes = (timesJson.available_times || []).filter((t: any) => t !== null);

  if (availTimes.length === 0) {
    log(`No times for ${targetDate}. Aborting.`);
    process.exit(0);
  }
  const targetTime = availTimes[0];
  log(`Target: ${targetDate} ${targetTime}`);

  // 4. Try to get tokens from Shiara's continue_actions page (alternative to appointment page)
  log('\n--- Shiara: try continue_actions page for tokens ---');
  await new Promise(r => setTimeout(r, 300));
  const continueResp = await fetch(
    `${baseUrl}/schedule/${SHIARA_SCHEDULE}/continue_actions`,
    { headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html', 'Upgrade-Insecure-Requests': '1', ...BROWSER_HEADERS }, redirect: 'manual' },
  );
  cookie = await updateCookie(continueResp, cookie);
  const continueHtml = await continueResp.text();
  const continueTitle = continueHtml.match(/<title>([^<]*)<\/title>/)?.[1] || '(none)';
  const shiaraCsrf = continueHtml.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1] || '';
  const shiaraAuth = continueHtml.match(/<input[^>]+name="authenticity_token"[^>]+value="([^"]+)"/)?.[1] || '';
  log(`continue_actions: status=${continueResp.status}, title="${continueTitle}"`);
  log(`  CSRF: ${shiaraCsrf ? shiaraCsrf.substring(0, 25) + '...' : 'NONE'}`);
  log(`  auth token: ${shiaraAuth ? shiaraAuth.substring(0, 25) + '...' : 'NONE'}`);

  // Also try Shiara's appointment page for CSRF (even though no auth token)
  await new Promise(r => setTimeout(r, 300));
  const shiaraApptResp = await fetch(
    `${baseUrl}/schedule/${SHIARA_SCHEDULE}/appointment?applicants[]=${SHIARA_APPLICANT}&confirmed_limit_message=1&commit=${texts.continueText}`,
    { headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html', 'Upgrade-Insecure-Requests': '1', ...BROWSER_HEADERS }, redirect: 'manual' },
  );
  cookie = await updateCookie(shiaraApptResp, cookie);
  const shiaraApptHtml = await shiaraApptResp.text();
  const shiaraApptCsrf = shiaraApptHtml.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1] || '';
  log(`appointment page CSRF: ${shiaraApptCsrf ? shiaraApptCsrf.substring(0, 25) + '...' : 'NONE'}`);

  // 5. POST reschedule on Shiara's schedule
  log('\n--- POST reschedule: Shiara → March 2026 ---');
  log(`Schedule: ${SHIARA_SCHEDULE}`);
  log(`Date: ${targetDate}, Time: ${targetTime}`);
  log(`Shiara current: 2027-05-21 08:15 → attempting ${targetDate} (much earlier)`);

  // Use best available tokens
  const postCsrf = shiaraApptCsrf || shiaraCsrf || lizCsrf;
  const postAuth = shiaraAuth || lizAuth;
  log(`Using CSRF from: ${shiaraApptCsrf ? 'Shiara appt' : shiaraCsrf ? 'Shiara continue' : 'Liz'}`);
  log(`Using auth from: ${shiaraAuth ? 'Shiara continue' : 'Liz (cross-schedule)'}`);

  const body = new URLSearchParams({
    authenticity_token: postAuth,
    confirmed_limit_message: '1',
    use_consulate_appointment_capacity: 'true',
    'appointments[consulate_appointment][facility_id]': FACILITY_ID,
    'appointments[consulate_appointment][date]': targetDate,
    'appointments[consulate_appointment][time]': targetTime,
    commit: texts.rescheduleText,
  });

  const postResp = await fetch(`${baseUrl}/schedule/${SHIARA_SCHEDULE}/appointment`, {
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

  let currentCookie = await updateCookie(postResp, cookie);

  log(`\nPOST status: ${postResp.status}`);
  log(`Location: ${postResp.headers.get('location') || '(none)'}`);

  // Follow redirects
  let current = postResp;
  for (let hop = 0; hop < 5; hop++) {
    if (current.status !== 302) break;
    const loc = current.headers.get('location');
    if (!loc) break;
    await current.text().catch(() => {});
    log(`  Hop ${hop}: → ${loc}`);
    current = await fetch(loc, {
      headers: { Cookie: `_yatri_session=${currentCookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html', 'Upgrade-Insecure-Requests': '1', ...BROWSER_HEADERS },
      redirect: 'manual',
    });
    currentCookie = await updateCookie(current, currentCookie);
    log(`    Status: ${current.status}`);
  }

  const finalHtml = await current.text();
  writeFileSync('scripts/output/shiara-march2026-result.html', finalHtml, 'utf-8');

  const text = finalHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const title = finalHtml.match(/<title>([^<]*)<\/title>/)?.[1] || '(none)';

  log(`\n--- Result ---`);
  log(`Title: "${title}"`);

  const checks = {
    'Limit Reached': text.includes('Limit Reached'),
    'alcanzado el número máximo': text.includes('alcanzado el número máximo'),
    'no pudo ser programada': text.includes('no pudo ser programada'),
    'selección válida': text.includes('selección válida'),
    'programado exitosamente': text.includes('programado exitosamente'),
    'successfully scheduled': text.includes('successfully scheduled'),
  };

  for (const [label, found] of Object.entries(checks)) {
    if (found) log(`  ✓ Contains: "${label}"`);
  }

  log('\n=== VERDICT ===');
  if (checks['programado exitosamente'] || checks['successfully scheduled']) {
    log('🚨 RESCHEDULE SUCCEEDED — Limit is UI-only!');
  } else if (checks['Limit Reached'] || checks['alcanzado el número máximo']) {
    log('🔒 BLOCKED by reschedule limit at API level');
  } else if (checks['no pudo ser programada'] || checks['selección válida']) {
    log('❌ REJECTED — server rejected the date/time (not limit-related)');
    log('   This means the limit check may happen AFTER date validation');
  } else if (title.includes('Sign In')) {
    log('🔑 Session expired — inconclusive');
  } else {
    log('❓ Unknown response');
    log(`  Preview: ${text.substring(0, 400)}`);
  }

  log('\nSaved to scripts/output/shiara-march2026-result.html');
  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

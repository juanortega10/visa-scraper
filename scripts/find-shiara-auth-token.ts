/**
 * Try to find a valid authenticity_token for Shiara's schedule (67882141).
 * The appointment page shows "Limit Reached" with no form.
 * Probe other pages in the schedule that might have forms.
 *
 * Usage: npx tsx --env-file=.env scripts/find-shiara-auth-token.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
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

async function probePage(url: string, cookie: string, label: string): Promise<{ cookie: string; authToken: string | null; csrf: string | null; status: number; title: string; hasForm: boolean; html: string }> {
  const resp = await fetch(url, {
    headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html', 'Upgrade-Insecure-Requests': '1', ...BROWSER_HEADERS },
    redirect: 'manual',
  });
  const newCookie = await updateCookie(resp, cookie);

  // Follow one redirect if needed
  let finalResp = resp;
  if (resp.status === 302) {
    const loc = resp.headers.get('location');
    await resp.text().catch(() => {});
    if (loc) {
      const fullUrl = loc.startsWith('http') ? loc : `https://ais.usvisa-info.com${loc}`;
      finalResp = await fetch(fullUrl, {
        headers: { Cookie: `_yatri_session=${newCookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html', 'Upgrade-Insecure-Requests': '1', ...BROWSER_HEADERS },
        redirect: 'manual',
      });
    }
  }

  const finalCookie = await updateCookie(finalResp, newCookie);
  const html = await finalResp.text();
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] || '(none)';
  const authToken = html.match(/<input[^>]+name="authenticity_token"[^>]+value="([^"]+)"/)?.[1] || null;
  const csrf = html.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1] || null;
  const hasForm = html.includes('<form');

  log(`  ${label}`);
  log(`    status=${finalResp.status}, title="${title.substring(0, 60)}"`);
  log(`    hasForm=${hasForm}, authToken=${authToken ? authToken.substring(0, 20) + '...' : 'NONE'}`);

  return { cookie: finalCookie, authToken, csrf, status: finalResp.status, title, hasForm, html };
}

async function main() {
  log('=== Find authenticity_token for Shiara (schedule 67882141) ===\n');

  const baseUrl = getBaseUrl(LOCALE);
  const texts = getLocaleTexts(LOCALE);
  mkdirSync('scripts/output', { recursive: true });

  // Login
  log('--- Login ---');
  const login = await pureFetchLogin(
    { email: LIZ_EMAIL, password: LIZ_PASSWORD, scheduleId: LIZ_SCHEDULE, applicantIds: [LIZ_APPLICANT], locale: LOCALE },
    { skipTokens: false },
  );
  let cookie = login.cookie;
  log('OK\n');

  const base = `${baseUrl}/schedule/${SHIARA_SCHEDULE}`;

  // Probe all candidate pages
  log('--- Probing pages for Shiara schedule 67882141 ---\n');

  const pages = [
    { url: `${base}/appointment?applicants[]=${SHIARA_APPLICANT}&confirmed_limit_message=1&commit=${texts.continueText}`, label: 'appointment (main)' },
    { url: `${base}/continue_actions`, label: 'continue_actions' },
    { url: `${base}/addresses/consulate`, label: 'addresses/consulate' },
    { url: `${base}/addresses/delivery`, label: 'addresses/delivery' },
    { url: `${base}/applicants/${SHIARA_APPLICANT}`, label: `applicants/${SHIARA_APPLICANT} (show)` },
    { url: `${base}/applicants/${SHIARA_APPLICANT}/edit`, label: `applicants/${SHIARA_APPLICANT}/edit` },
    { url: `${base}/payment`, label: 'payment' },
    { url: `${base}/appointment/cancel`, label: 'appointment/cancel' },
  ];

  const results: { label: string; authToken: string | null; csrf: string | null }[] = [];

  for (const p of pages) {
    await new Promise(r => setTimeout(r, 400));
    const result = await probePage(p.url, cookie, p.label);
    cookie = result.cookie;
    results.push({ label: p.label, authToken: result.authToken, csrf: result.csrf });

    // Save HTML if it has a form or auth token
    if (result.hasForm || result.authToken) {
      const safeName = p.label.replace(/[^a-z0-9]/g, '-');
      writeFileSync(`scripts/output/shiara-${safeName}.html`, result.html, 'utf-8');
      log(`    → Saved HTML!`);
    }
    log('');
  }

  // Summary
  log('\n=== SUMMARY ===');
  log('Page                              | Auth Token | CSRF');
  log('----------------------------------|------------|-----');
  for (const r of results) {
    log(`${r.label.padEnd(34)}| ${r.authToken ? '✅ YES' : '❌ NO  '} | ${r.csrf ? '✅' : '❌'}`);
  }

  const found = results.find(r => r.authToken);
  if (found) {
    log(`\n✅ Found authenticity_token on: ${found.label}`);
    log(`Token: ${found.authToken!.substring(0, 30)}...`);

    // Now try POST with this token
    log('\n--- Attempting POST with valid Shiara token ---');

    // Get March 2026 date+time from Liz
    const lizApptResp = await fetch(
      `${baseUrl}/schedule/${LIZ_SCHEDULE}/appointment?applicants[]=${LIZ_APPLICANT}&confirmed_limit_message=1&commit=${texts.continueText}`,
      { headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html', 'Upgrade-Insecure-Requests': '1', ...BROWSER_HEADERS }, redirect: 'manual' },
    );
    cookie = await updateCookie(lizApptResp, cookie);
    const lizHtml = await lizApptResp.text();
    const lizCsrf = lizHtml.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1] || '';

    const daysResp = await fetch(
      `${baseUrl}/schedule/${LIZ_SCHEDULE}/appointment/days/${FACILITY_ID}.json?appointments[expedite]=false`,
      { headers: { Cookie: `_yatri_session=${cookie}`, 'X-CSRF-Token': lizCsrf, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01', 'User-Agent': USER_AGENT, ...BROWSER_HEADERS } },
    );
    cookie = await updateCookie(daysResp, cookie);
    const days: { date: string }[] = JSON.parse(await daysResp.text());
    const marchDates = days.filter(d => d.date.startsWith('2026-03'));

    if (marchDates.length === 0) {
      log('No March 2026 dates. Aborting POST test.');
      process.exit(0);
    }
    const targetDate = marchDates[0]!.date;

    await new Promise(r => setTimeout(r, 300));
    const timesResp = await fetch(
      `${baseUrl}/schedule/${LIZ_SCHEDULE}/appointment/times/${FACILITY_ID}.json?date=${targetDate}&appointments[expedite]=false`,
      { headers: { Cookie: `_yatri_session=${cookie}`, 'X-CSRF-Token': lizCsrf, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01', 'User-Agent': USER_AGENT, ...BROWSER_HEADERS } },
    );
    cookie = await updateCookie(timesResp, cookie);
    const timesData = JSON.parse(await timesResp.text());
    const targetTime = (timesData.available_times || []).filter((t: any) => t !== null)[0];

    if (!targetTime) {
      log(`No times for ${targetDate}. Aborting.`);
      process.exit(0);
    }

    log(`Target: ${targetDate} ${targetTime}`);
    log(`Using Shiara's own authenticity_token from: ${found.label}`);

    const postCsrf = found.csrf || lizCsrf;
    const body = new URLSearchParams({
      authenticity_token: found.authToken!,
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
    log(`POST status: ${postResp.status}, Location: ${postResp.headers.get('location') || '(none)'}`);

    let current = postResp;
    for (let hop = 0; hop < 5; hop++) {
      if (current.status !== 302) break;
      const loc = current.headers.get('location');
      if (!loc) break;
      await current.text().catch(() => {});
      log(`  Hop ${hop}: → ${loc}`);
      current = await fetch(loc.startsWith('http') ? loc : `https://ais.usvisa-info.com${loc}`, {
        headers: { Cookie: `_yatri_session=${currentCookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html', 'Upgrade-Insecure-Requests': '1', ...BROWSER_HEADERS },
        redirect: 'manual',
      });
      currentCookie = await updateCookie(current, currentCookie);
      log(`    Status: ${current.status}`);
    }

    const finalHtml = await current.text();
    writeFileSync('scripts/output/shiara-valid-token-result.html', finalHtml, 'utf-8');
    const text = finalHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const title = finalHtml.match(/<title>([^<]*)<\/title>/)?.[1] || '';

    log(`\nResult title: "${title}"`);
    if (text.includes('programado exitosamente') || text.includes('successfully')) log('🚨 SUCCESS — limit bypassed!');
    else if (text.includes('Limit Reached') || text.includes('alcanzado el número máximo')) log('🔒 BLOCKED — limit enforced even with valid token');
    else if (text.includes('no pudo ser programada')) log('❌ REJECTED — date/time invalid');
    else if (title.includes('Sign In')) log('🔑 Session expired');
    else log(`❓ Unknown: ${text.substring(0, 300)}`);

    log('Saved to scripts/output/shiara-valid-token-result.html');
  } else {
    log('\n❌ No authenticity_token found on any page for Shiara.');
    log('The server blocks the form entirely for limit-reached schedules.');
  }

  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

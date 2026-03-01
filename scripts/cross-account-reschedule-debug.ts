/**
 * Debug version: same cross-account reschedule but captures full redirect chain + HTML.
 * Shows exactly what the server returned.
 *
 * Usage: npx tsx --env-file=.env scripts/cross-account-reschedule-debug.ts
 */
import { writeFileSync } from 'node:fs';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { pureFetchLogin, performLogin } from '../src/services/login.js';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl, getLocaleTexts } from '../src/utils/constants.js';

const BOT_ID = 7;
const LIZ_EMAIL = 'shiara.arauzo@hotmail.com';
const LIZ_PASSWORD = '=Visa123ReunionHackaton';
const LOCALE = 'es-pe';
const LIZ_SCHEDULE_ID = '69454137';
const LIZ_APPLICANT_ID = '80769164';

function log(msg: string) {
  const ts = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Bogota', hour12: false });
  console.log(`[${ts}] ${msg}`);
}

async function main() {
  log('Cross-account reschedule DEBUG');

  const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
  if (!bot) throw new Error(`Bot ${BOT_ID} not found`);

  // Step 1: Get a real time from Liz
  log('\n--- Liz: fetch times for 2026-03-23 ---');
  const lizLogin = await pureFetchLogin(
    { email: LIZ_EMAIL, password: LIZ_PASSWORD, scheduleId: LIZ_SCHEDULE_ID, applicantIds: [LIZ_APPLICANT_ID], locale: LOCALE },
    { skipTokens: false },
  );

  const baseUrl = getBaseUrl(LOCALE);
  const texts = getLocaleTexts(LOCALE);

  // refreshTokens for Liz
  const lizApptUrl = `${baseUrl}/schedule/${LIZ_SCHEDULE_ID}/appointment?applicants[]=${LIZ_APPLICANT_ID}&confirmed_limit_message=1&commit=${texts.continueText}`;
  const lizApptResp = await fetch(lizApptUrl, {
    headers: { Cookie: `_yatri_session=${lizLogin.cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html', 'Upgrade-Insecure-Requests': '1', ...BROWSER_HEADERS },
    redirect: 'manual',
  });
  const lizApptHtml = await lizApptResp.text();
  const lizCsrf = lizApptHtml.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1] || '';

  // Get times
  let lizCookie = lizLogin.cookie;
  for (const h of lizApptResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { lizCookie = m[1]; break; }
  }

  const timesResp = await fetch(
    `${baseUrl}/schedule/${LIZ_SCHEDULE_ID}/appointment/times/115.json?date=2026-03-23&appointments[expedite]=false`,
    { headers: {
      Cookie: `_yatri_session=${lizCookie}`, 'X-CSRF-Token': lizCsrf,
      'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01',
      'User-Agent': USER_AGENT, ...BROWSER_HEADERS,
    }},
  );
  const timesJson = await timesResp.text();
  log(`Liz times: ${timesJson}`);

  const parsed = JSON.parse(timesJson);
  const targetTime = (parsed.available_times || []).filter((t: any) => t !== null)[0];
  if (!targetTime) { log('No time available'); process.exit(0); }
  log(`Target: 2026-03-23 ${targetTime}`);

  // Step 2: Login as Bot 7, POST reschedule with full debug
  log('\n--- Bot 7: login + POST ---');
  const bot7Login = await performLogin({
    email: decrypt(bot.visaEmail),
    password: decrypt(bot.visaPassword),
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    locale: bot.locale,
  });

  // refreshTokens
  const bot7ApptUrl = `${baseUrl}/schedule/${bot.scheduleId}/appointment?applicants[]=${bot.applicantIds[0]}&confirmed_limit_message=1&commit=${texts.continueText}`;
  const bot7ApptResp = await fetch(bot7ApptUrl, {
    headers: { Cookie: `_yatri_session=${bot7Login.cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html', 'Upgrade-Insecure-Requests': '1', ...BROWSER_HEADERS },
    redirect: 'manual',
  });
  const bot7ApptHtml = await bot7ApptResp.text();
  const bot7Csrf = bot7ApptHtml.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1] || '';
  const bot7Auth = bot7ApptHtml.match(/<input[^>]+name="authenticity_token"[^>]+value="([^"]+)"/)?.[1] || '';
  let bot7Cookie = bot7Login.cookie;
  for (const h of bot7ApptResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { bot7Cookie = m[1]; break; }
  }

  log(`Bot 7 csrf: ${bot7Csrf.substring(0, 20)}...`);
  log(`Bot 7 auth: ${bot7Auth.substring(0, 20)}...`);

  // Build POST body
  const body = new URLSearchParams({
    authenticity_token: bot7Auth,
    confirmed_limit_message: '1',
    use_consulate_appointment_capacity: 'true',
    'appointments[consulate_appointment][facility_id]': bot.consularFacilityId,
    'appointments[consulate_appointment][date]': '2026-03-23',
    'appointments[consulate_appointment][time]': targetTime,
    commit: texts.rescheduleText,
  });

  const qs = bot.applicantIds.map(id => `applicants%5B%5D=${id}`).join('&');
  const postUrl = `${baseUrl}/schedule/${bot.scheduleId}/appointment`;

  log(`\nPOST ${postUrl}`);
  log(`Body: ${body.toString().substring(0, 200)}...`);

  const postResp = await fetch(postUrl, {
    method: 'POST',
    headers: {
      Cookie: `_yatri_session=${bot7Cookie}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-Token': bot7Csrf,
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: `${baseUrl}/schedule/${bot.scheduleId}/appointment?${qs}&confirmed_limit_message=1&commit=${texts.continueText}`,
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
  log(`  Content-Type: ${postResp.headers.get('content-type') || '(none)'}`);

  // Follow redirects manually
  let current = postResp;
  let currentCookie = bot7Cookie;
  for (const h of current.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { currentCookie = m[1]; break; }
  }

  for (let hop = 0; hop < 5; hop++) {
    if (current.status !== 302) break;
    const location = current.headers.get('location');
    if (!location) break;

    log(`\n  Hop ${hop}: ${current.status} → ${location}`);

    // Read body of redirect for diagnostic
    const redirectBody = await current.text().catch(() => '');
    if (redirectBody.length > 0) {
      log(`  Body preview: ${redirectBody.substring(0, 200)}`);
    }

    current = await fetch(location, {
      headers: {
        Cookie: `_yatri_session=${currentCookie}`,
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        ...BROWSER_HEADERS,
      },
      redirect: 'manual',
    });

    for (const h of current.headers.getSetCookie()) {
      const m = h.match(/_yatri_session=([^;]+)/);
      if (m?.[1]) { currentCookie = m[1]; break; }
    }

    log(`  → Status: ${current.status}, Location: ${current.headers.get('location') || '(none)'}`);
  }

  // Final page
  const finalHtml = await current.text();
  writeFileSync('scripts/output/bot7-reschedule-result.html', finalHtml, 'utf-8');
  log(`\nFinal page (${finalHtml.length} bytes) saved to scripts/output/bot7-reschedule-result.html`);
  log(`  Status: ${current.status}`);
  log(`  URL: ${current.url}`);

  // Check for success/error indicators
  const hasSuccess = finalHtml.includes('programado exitosamente') || finalHtml.includes('successfully');
  const hasInstructions = finalHtml.includes('instructions') || finalHtml.includes('/instructions');
  const hasAppointment = finalHtml.includes('appointment');
  const hasError = finalHtml.includes('error') || finalHtml.includes('Error');
  const titleMatch = finalHtml.match(/<title>([^<]*)<\/title>/);

  log(`  Title: ${titleMatch?.[1] || '(none)'}`);
  log(`  Has success text: ${hasSuccess}`);
  log(`  Has instructions: ${hasInstructions}`);
  log(`  Has appointment: ${hasAppointment}`);
  log(`  Has error: ${hasError}`);

  // Preview relevant content
  const bodyPreview = finalHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  log(`\n  Text preview: ${bodyPreview.substring(0, 500)}`);

  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

/**
 * Retry cross-schedule reschedule: Try ALL March 2026 dates from Liz on Bot 7.
 * Captures full HTML response for each attempt.
 *
 * Usage: npx tsx --env-file=.env scripts/retry-cross-schedule.ts
 */
import { writeFileSync } from 'node:fs';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { pureFetchLogin, performLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl, getLocaleTexts } from '../src/utils/constants.js';

const BOT_ID = 7;
const LIZ_EMAIL = 'shiara.arauzo@hotmail.com';
const LIZ_PASSWORD = '=Visa123ReunionHackaton';
const LOCALE = 'es-pe';
const LIZ_SCHEDULE = '69454137';
const LIZ_APPLICANT = '80769164';

function log(msg: string) {
  const ts = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Bogota', hour12: false });
  console.log(`[${ts}] ${msg}`);
}

async function main() {
  log('=== Retry cross-schedule reschedule (Bot 7 ← Liz dates) ===\n');

  // Load Bot 7
  const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
  if (!bot) throw new Error('Bot 7 not found');
  log(`Bot 7: ${bot.currentConsularDate} ${bot.currentConsularTime}, rescheduleCount=${bot.rescheduleCount}`);

  // Step 1: Login Liz, get fresh days + times
  log('\n--- Liz: login + fetch dates ---');
  const lizLogin = await pureFetchLogin(
    { email: LIZ_EMAIL, password: LIZ_PASSWORD, scheduleId: LIZ_SCHEDULE, applicantIds: [LIZ_APPLICANT], locale: LOCALE },
    { skipTokens: false },
  );
  const lizClient = new VisaClient(lizLogin, {
    scheduleId: LIZ_SCHEDULE, applicantIds: [LIZ_APPLICANT],
    consularFacilityId: '115', ascFacilityId: '', proxyProvider: 'direct', locale: LOCALE,
  });
  await lizClient.refreshTokens();

  const lizDays = await lizClient.getConsularDays();
  const lizDates = lizDays.map(d => d.date);
  log(`Liz: ${lizDates.length} dates (earliest: ${lizDates[0]})`);

  // Get Bot 7 days to find which Liz dates are invisible
  log('\n--- Bot 7: login + fetch dates ---');
  const bot7Login = await performLogin({
    email: decrypt(bot.visaEmail), password: decrypt(bot.visaPassword),
    scheduleId: bot.scheduleId, applicantIds: bot.applicantIds, locale: bot.locale,
  });
  const bot7Client = new VisaClient(bot7Login, {
    scheduleId: bot.scheduleId, applicantIds: bot.applicantIds,
    consularFacilityId: bot.consularFacilityId, ascFacilityId: bot.ascFacilityId,
    proxyProvider: 'direct', locale: bot.locale,
  });
  await bot7Client.refreshTokens();

  const bot7Days = await bot7Client.getConsularDays();
  const bot7Dates = new Set(bot7Days.map(d => d.date));
  log(`Bot 7: ${bot7Dates.size} dates (earliest: ${bot7Days[0]?.date})`);

  // Find March 2026 dates in Liz but not Bot 7
  const marchDates = lizDates.filter(d => d.startsWith('2026-03') && !bot7Dates.has(d));
  log(`\nMarch 2026 dates in Liz but NOT Bot 7: ${marchDates.length}`);
  marchDates.forEach(d => log(`  ${d}`));

  if (marchDates.length === 0) {
    log('No invisible March dates to test');
    process.exit(0);
  }

  // Fetch times from Liz for each
  log('\n--- Fetch times from Liz ---');
  const dateTimeMap: { date: string; time: string }[] = [];
  for (const date of marchDates) {
    try {
      const times = await lizClient.getConsularTimes(date);
      const available = (times.available_times || []).filter((t): t is string => t !== null);
      log(`  ${date}: ${available.length > 0 ? available.join(', ') : '(none)'}`);
      if (available.length > 0) {
        dateTimeMap.push({ date, time: available[0]! });
      }
    } catch (err) {
      log(`  ${date}: ERROR — ${err instanceof Error ? err.message : err}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  if (dateTimeMap.length === 0) {
    log('\nNo times available for any invisible date');
    process.exit(0);
  }

  // Step 2: Try POST reschedule on Bot 7 for each date+time
  log('\n=== Attempting POST reschedule on Bot 7 ===');
  const baseUrl = getBaseUrl(LOCALE);
  const texts = getLocaleTexts(LOCALE);
  const session = bot7Client.getSession();

  const results: { date: string; time: string; status: number; location: string; finalText: string; success: boolean }[] = [];

  for (const { date, time } of dateTimeMap) {
    log(`\n  POST: ${date} ${time}`);

    const body = new URLSearchParams({
      authenticity_token: session.authenticityToken,
      confirmed_limit_message: '1',
      use_consulate_appointment_capacity: 'true',
      'appointments[consulate_appointment][facility_id]': bot.consularFacilityId,
      'appointments[consulate_appointment][date]': date,
      'appointments[consulate_appointment][time]': time,
      commit: texts.rescheduleText,
    });

    const qs = bot.applicantIds.map(id => `applicants%5B%5D=${id}`).join('&');

    let currentCookie = session.cookie;
    const postResp = await fetch(`${baseUrl}/schedule/${bot.scheduleId}/appointment`, {
      method: 'POST',
      headers: {
        Cookie: `_yatri_session=${currentCookie}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': session.csrfToken,
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

    // Update cookie
    for (const h of postResp.headers.getSetCookie()) {
      const m = h.match(/_yatri_session=([^;]+)/);
      if (m?.[1]) { currentCookie = m[1]; break; }
    }

    log(`    POST status: ${postResp.status}, location: ${postResp.headers.get('location') || '(none)'}`);

    // Follow redirects
    let current = postResp;
    for (let hop = 0; hop < 5; hop++) {
      if (current.status !== 302) break;
      const loc = current.headers.get('location');
      if (!loc) break;
      await current.text().catch(() => {});
      current = await fetch(loc, {
        headers: { Cookie: `_yatri_session=${currentCookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html', ...BROWSER_HEADERS },
        redirect: 'manual',
      });
      for (const h of current.headers.getSetCookie()) {
        const m = h.match(/_yatri_session=([^;]+)/);
        if (m?.[1]) { currentCookie = m[1]; break; }
      }
    }

    const finalHtml = await current.text();
    const textOnly = finalHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    // Check for error vs success
    const hasError = textOnly.includes('no pudo ser programada') || textOnly.includes('selección válida');
    const hasSuccess = textOnly.includes('programado exitosamente') || textOnly.includes('successfully scheduled');

    const isSuccess = hasSuccess && !hasError;
    log(`    Result: ${isSuccess ? '✅ SUCCESS' : '❌ REJECTED'}`);
    if (hasError) log(`    Error: "Su cita no pudo ser programada. Por favor, haga una selección válida."`);
    if (hasSuccess) log(`    Success text found in HTML`);

    results.push({
      date, time,
      status: postResp.status,
      location: postResp.headers.get('location') || '',
      finalText: hasError ? 'REJECTED: selección válida' : hasSuccess ? 'SUCCESS' : 'UNKNOWN',
      success: isSuccess,
    });

    // Save HTML for first attempt
    if (results.length === 1) {
      writeFileSync('scripts/output/bot7-retry-result.html', finalHtml, 'utf-8');
      log(`    Saved HTML to scripts/output/bot7-retry-result.html`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // Summary
  log('\n=== Summary ===');
  console.log('\n| Date       | Time  | POST Status | Result    |');
  console.log('|------------|-------|-------------|-----------|');
  for (const r of results) {
    console.log(`| ${r.date} | ${r.time} | ${r.status}         | ${r.finalText} |`);
  }

  const anySuccess = results.some(r => r.success);
  log(`\n${anySuccess ? '✅ At least one succeeded!' : '❌ ALL REJECTED — cross-schedule reschedule confirmed impossible'}`);

  // Verify appointment unchanged
  log('\nVerifying Bot 7 appointment unchanged...');
  const appt = await bot7Client.getCurrentAppointment();
  log(`  Live appointment: ${appt?.consularDate} ${appt?.consularTime}`);
  log(`  DB appointment:   ${bot.currentConsularDate} ${bot.currentConsularTime}`);
  log(`  ${appt?.consularDate === bot.currentConsularDate ? '✅ Unchanged' : '⚠️ CHANGED!'}`);

  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

/**
 * Diagnostic script: Compare Bot 7 (es-pe) vs Liz's account for consular days.
 *
 * READ-ONLY: No DB writes, no reschedule, no side effects.
 *
 * Usage: npx tsx --env-file=.env scripts/compare-peru-accounts.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { pureFetchLogin, performLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import {
  extractAppointments,
  extractApplicantIdsFromGroups,
  extractApplicantNames,
} from '../src/services/html-parsers.js';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl } from '../src/utils/constants.js';

const BOT_7_ID = 7;
const LIZ_EMAIL = 'shiara.arauzo@hotmail.com';
const LIZ_PASSWORD = '=Visa123ReunionHackaton';
const LOCALE = 'es-pe';
const OUTPUT_DIR = 'scripts/output';

mkdirSync(OUTPUT_DIR, { recursive: true });

function log(msg: string) {
  const ts = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Bogota', hour12: false });
  console.log(`[${ts}] ${msg}`);
}

function saveHtml(filename: string, html: string) {
  const path = `${OUTPUT_DIR}/${filename}`;
  writeFileSync(path, html, 'utf-8');
  log(`  Saved ${path} (${(html.length / 1024).toFixed(1)}KB)`);
}

// ── Phase 1: Load Bot 7 from DB ──────────────────────

async function loadBot7() {
  log('=== Phase 1: Loading Bot 7 from DB ===');
  const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_7_ID));
  if (!bot) throw new Error('Bot 7 not found');
  const [session] = await db.select().from(sessions).where(eq(sessions.botId, BOT_7_ID));

  log(`  scheduleId: ${bot.scheduleId}`);
  log(`  applicantIds: ${JSON.stringify(bot.applicantIds)}`);
  log(`  consularFacilityId: ${bot.consularFacilityId}`);
  log(`  ascFacilityId: ${bot.ascFacilityId || '(none)'}`);
  log(`  locale: ${bot.locale}`);
  log(`  status: ${bot.status}`);
  log(`  proxyProvider: ${bot.proxyProvider}`);
  log(`  currentConsularDate: ${bot.currentConsularDate || '(none)'}`);
  log(`  currentConsularTime: ${bot.currentConsularTime || '(none)'}`);
  log(`  maxReschedules: ${bot.maxReschedules}`);
  log(`  rescheduleCount: ${bot.rescheduleCount}`);
  log(`  targetDateBefore: ${bot.targetDateBefore || '(none)'}`);
  log(`  session: ${session ? `exists (created ${session.createdAt})` : 'NONE'}`);

  return { bot, session };
}

// ── Phase 2: Login to Liz's account + dump groups page ──

interface LizScheduleInfo {
  scheduleId: string;
  applicantIds: string[];
  applicantNames: string[];
  appointments: ReturnType<typeof extractAppointments>;
}

async function loginAndDiscoverLiz() {
  log('\n=== Phase 2: Login to Liz\'s account ===');

  // Login with skipTokens (we just need the cookie for groups page)
  log('  Logging in...');
  const loginResult = await pureFetchLogin(
    { email: LIZ_EMAIL, password: LIZ_PASSWORD, scheduleId: '', applicantIds: [], locale: LOCALE },
    { skipTokens: true },
  );
  let cookie = loginResult.cookie;
  log(`  Login OK — cookie=${cookie.length}chars`);

  function updateCookie(resp: Response) {
    for (const h of resp.headers.getSetCookie()) {
      const m = h.match(/_yatri_session=([^;]+)/);
      if (m?.[1]) { cookie = m[1]; break; }
    }
  }

  // GET /account → follows redirects to /groups/{userId}
  const baseUrl = getBaseUrl(LOCALE);
  log('  Fetching /account (→ groups page)...');
  const accountResp = await fetch(`${baseUrl}/account`, {
    headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html' },
    redirect: 'follow',
  });
  if (accountResp.status !== 200) throw new Error(`Account page HTTP ${accountResp.status}`);
  updateCookie(accountResp);

  const finalUrl = accountResp.url;
  const userIdMatch = finalUrl.match(/\/groups\/(\d+)/);
  const userId = userIdMatch?.[1] ?? '(unknown)';
  log(`  userId: ${userId}`);

  const groupsHtml = await accountResp.text();
  saveHtml('liz-groups.html', groupsHtml);

  // Extract ALL scheduleIds with global regex
  const scheduleRegex = /\/schedule\/(\d+)/g;
  const scheduleIds = new Set<string>();
  let m;
  while ((m = scheduleRegex.exec(groupsHtml)) !== null) {
    scheduleIds.add(m[1]!);
  }
  log(`  Schedules found: ${[...scheduleIds].join(', ') || '(none)'}`);

  // Extract applicant IDs per schedule
  // Groups page has rows with links like /schedule/{sid}/applicants/{aid}
  const schedules: LizScheduleInfo[] = [];
  for (const sid of scheduleIds) {
    const aidRegex = new RegExp(`/schedule/${sid}/applicants/(\\d+)`, 'g');
    const aids = new Set<string>();
    while ((m = aidRegex.exec(groupsHtml)) !== null) {
      aids.add(m[1]!);
    }

    // Extract appointments for this schedule (the page may have multiple)
    const appointments = extractAppointments(groupsHtml);

    // Extract names from groups page
    const applicantNames = extractApplicantNames(groupsHtml, '', false);

    schedules.push({
      scheduleId: sid,
      applicantIds: [...aids],
      applicantNames,
      appointments,
    });

    log(`  Schedule ${sid}: ${aids.size} applicant(s) [${[...aids].join(', ')}]`);
    if (applicantNames.length > 0) log(`    Names: ${applicantNames.join(', ')}`);
    if (appointments.currentConsularDate) {
      log(`    Consular: ${appointments.currentConsularDate} ${appointments.currentConsularTime}`);
    }
    if (appointments.currentCasDate) {
      log(`    CAS: ${appointments.currentCasDate} ${appointments.currentCasTime}`);
    }
  }

  return { userId, cookie, schedules };
}

// ── Phase 3: Fetch appointment page for each Liz schedule ──

async function fetchLizAppointmentPages(
  cookie: string,
  schedules: LizScheduleInfo[],
) {
  log('\n=== Phase 3: Fetch appointment pages (Liz) ===');
  const baseUrl = getBaseUrl(LOCALE);

  for (const sched of schedules) {
    const qs = sched.applicantIds.map(id => `applicants[]=${id}`).join('&');
    const url = `${baseUrl}/schedule/${sched.scheduleId}/appointment?${qs}&confirmed_limit_message=1&commit=Continuar`;

    log(`  Fetching appointment page for schedule ${sched.scheduleId}...`);
    try {
      const resp = await fetch(url, {
        headers: {
          Cookie: `_yatri_session=${cookie}`,
          'User-Agent': USER_AGENT,
          Accept: 'text/html',
          'Upgrade-Insecure-Requests': '1',
        },
        redirect: 'manual',
      });

      // Update cookie
      for (const h of resp.headers.getSetCookie()) {
        const m = h.match(/_yatri_session=([^;]+)/);
        if (m?.[1]) { cookie = m[1]; break; }
      }

      if (resp.status === 200) {
        const html = await resp.text();
        saveHtml(`liz-appointment-${sched.scheduleId}.html`, html);

        // Extract facility IDs
        const consularMatch = html.match(/<select[^>]+consulate_appointment_facility_id[^>]*>([\s\S]*?)<\/select>/);
        if (consularMatch) {
          const optMatch = consularMatch[1]!.match(/<option[^>]+value="(\d+)"/);
          if (optMatch?.[1]) log(`    Consular facility: ${optMatch[1]}`);
        }

        // Extract CSRF + authenticity tokens
        const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
        const authMatch = html.match(/<input[^>]+name="authenticity_token"[^>]+value="([^"]+)"/);
        log(`    csrfToken: ${csrfMatch?.[1] ? 'YES' : 'NO'}`);
        log(`    authenticityToken: ${authMatch?.[1] ? 'YES' : 'NO'}`);
      } else {
        log(`    HTTP ${resp.status} — location: ${resp.headers.get('location') || '(none)'}`);
        const body = await resp.text().catch(() => '');
        if (body) saveHtml(`liz-appointment-${sched.scheduleId}-error.html`, body);
      }
    } catch (err) {
      log(`    ERROR: ${err instanceof Error ? err.message : err}`);
    }
  }

  return cookie;
}

// ── Phase 4: Comparison table ──

function printComparisonTable(
  bot7: Awaited<ReturnType<typeof loadBot7>>,
  lizSchedules: LizScheduleInfo[],
) {
  log('\n=== Phase 4: Comparison Table ===');

  const headers = ['Campo', 'Bot 7'];
  for (const s of lizSchedules) headers.push(`Liz (${s.scheduleId})`);

  const rows: string[][] = [];
  rows.push(['scheduleId', bot7.bot.scheduleId, ...lizSchedules.map(s => s.scheduleId)]);
  rows.push(['applicantIds', JSON.stringify(bot7.bot.applicantIds), ...lizSchedules.map(s => JSON.stringify(s.applicantIds))]);
  rows.push(['# applicants', String(bot7.bot.applicantIds.length), ...lizSchedules.map(s => String(s.applicantIds.length))]);
  rows.push(['facilityId', bot7.bot.consularFacilityId, ...lizSchedules.map(() => '115 (Lima)')]);
  rows.push(['currentConsular', `${bot7.bot.currentConsularDate || '?'} ${bot7.bot.currentConsularTime || ''}`, ...lizSchedules.map(s => `${s.appointments.currentConsularDate || '?'} ${s.appointments.currentConsularTime || ''}`)]);
  rows.push(['locale', bot7.bot.locale, ...lizSchedules.map(() => LOCALE)]);
  rows.push(['status', bot7.bot.status, ...lizSchedules.map(() => 'external')]);

  // Print as table
  const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] || '').length)));
  const sep = colWidths.map(w => '-'.repeat(w + 2)).join('+');

  console.log('\n' + sep);
  console.log(headers.map((h, i) => ` ${h.padEnd(colWidths[i]!)} `).join('|'));
  console.log(sep);
  for (const row of rows) {
    console.log(row.map((c, i) => ` ${(c || '').padEnd(colWidths[i]!)} `).join('|'));
  }
  console.log(sep + '\n');
}

// ── Phase 5: Fetch consular days for all schedules ──

interface DaysResult {
  label: string;
  scheduleId: string;
  dates: string[];
  error?: string;
}

async function fetchConsularDays(
  bot7Data: Awaited<ReturnType<typeof loadBot7>>,
  lizCookie: string,
  lizSchedules: LizScheduleInfo[],
): Promise<DaysResult[]> {
  log('=== Phase 5: Fetch consular days ===');
  const results: DaysResult[] = [];

  // Bot 7: fresh login (don't trust stored session)
  log('  Bot 7: fresh login...');
  try {
    const bot7Login = await performLogin({
      email: decrypt(bot7Data.bot.visaEmail),
      password: decrypt(bot7Data.bot.visaPassword),
      scheduleId: bot7Data.bot.scheduleId,
      applicantIds: bot7Data.bot.applicantIds,
      locale: bot7Data.bot.locale,
    });
    log(`  Bot 7: login OK — hasTokens=${bot7Login.hasTokens}`);

    const client7 = new VisaClient(bot7Login, {
      scheduleId: bot7Data.bot.scheduleId,
      applicantIds: bot7Data.bot.applicantIds,
      consularFacilityId: bot7Data.bot.consularFacilityId,
      ascFacilityId: bot7Data.bot.ascFacilityId,
      proxyProvider: 'direct',
      locale: bot7Data.bot.locale,
    });

    // refreshTokens needed for AJAX headers
    log('  Bot 7: refreshTokens...');
    await client7.refreshTokens();

    log('  Bot 7: getConsularDays...');
    const days = await client7.getConsularDays();
    const dates = days.map(d => d.date);
    log(`  Bot 7: ${dates.length} dates${dates.length > 0 ? ` (earliest: ${dates[0]}, latest: ${dates[dates.length - 1]})` : ' (EMPTY)'}`);
    results.push({ label: 'Bot 7', scheduleId: bot7Data.bot.scheduleId, dates });

    // Also get current appointment from groups page
    const appt = await client7.getCurrentAppointment();
    if (appt) {
      log(`  Bot 7 live appointment: ${appt.consularDate} ${appt.consularTime}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  Bot 7: ERROR — ${msg}`);
    results.push({ label: 'Bot 7', scheduleId: bot7Data.bot.scheduleId, dates: [], error: msg });
  }

  // Liz: use existing cookie + refreshTokens for each schedule
  for (const sched of lizSchedules) {
    log(`\n  Liz (${sched.scheduleId}): setting up VisaClient...`);
    try {
      const client = new VisaClient(
        { cookie: lizCookie, csrfToken: '', authenticityToken: '' },
        {
          scheduleId: sched.scheduleId,
          applicantIds: sched.applicantIds,
          consularFacilityId: '115', // Lima
          ascFacilityId: '',
          proxyProvider: 'direct',
          locale: LOCALE,
        },
      );

      log(`  Liz (${sched.scheduleId}): refreshTokens...`);
      await client.refreshTokens();

      log(`  Liz (${sched.scheduleId}): getConsularDays...`);
      const days = await client.getConsularDays();
      const dates = days.map(d => d.date);
      log(`  Liz (${sched.scheduleId}): ${dates.length} dates${dates.length > 0 ? ` (earliest: ${dates[0]}, latest: ${dates[dates.length - 1]})` : ' (EMPTY)'}`);
      results.push({ label: `Liz (${sched.scheduleId})`, scheduleId: sched.scheduleId, dates });

      // Update cookie for next iteration
      const newSession = client.getSession();
      lizCookie = newSession.cookie;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  Liz (${sched.scheduleId}): ERROR — ${msg}`);
      results.push({ label: `Liz (${sched.scheduleId})`, scheduleId: sched.scheduleId, dates: [], error: msg });
    }
  }

  return results;
}

// ── Phase 6: Compare dates + fetch times ──

async function compareDates(results: DaysResult[]) {
  log('\n=== Phase 6: Compare dates ===');

  if (results.length < 2) {
    log('  Not enough results to compare');
    return;
  }

  const bot7Result = results[0]!;
  const lizResults = results.slice(1);

  for (const liz of lizResults) {
    log(`\n  Bot 7 vs ${liz.label}:`);

    const bot7Set = new Set(bot7Result.dates);
    const lizSet = new Set(liz.dates);

    const shared = bot7Result.dates.filter(d => lizSet.has(d));
    const onlyBot7 = bot7Result.dates.filter(d => !lizSet.has(d));
    const onlyLiz = liz.dates.filter(d => !bot7Set.has(d));

    log(`    Shared: ${shared.length}`);
    log(`    Only Bot 7: ${onlyBot7.length}${onlyBot7.length > 0 ? ` [${onlyBot7.slice(0, 5).join(', ')}${onlyBot7.length > 5 ? '...' : ''}]` : ''}`);
    log(`    Only ${liz.label}: ${onlyLiz.length}${onlyLiz.length > 0 ? ` [${onlyLiz.slice(0, 5).join(', ')}${onlyLiz.length > 5 ? '...' : ''}]` : ''}`);

    // List Liz's dates if Bot 7 sees empty
    if (bot7Result.dates.length === 0 && liz.dates.length > 0) {
      log(`\n  *** Bot 7 sees EMPTY but ${liz.label} sees ${liz.dates.length} dates ***`);
      log(`  Liz's dates: ${liz.dates.slice(0, 10).join(', ')}${liz.dates.length > 10 ? '...' : ''}`);
    }
  }
}

// ── Phase 7: Diagnosis ──

function diagnose(results: DaysResult[]) {
  log('\n=== Phase 7: Diagnosis ===');

  const bot7 = results[0]!;
  const lizResults = results.slice(1);

  if (bot7.error?.includes('InvalidCredentials')) {
    log('  DIAGNOSIS: Bot 7 credentials are invalid. Check email/password.');
    return;
  }

  if (bot7.error?.includes('SessionExpired') || bot7.error?.includes('session expired')) {
    log('  DIAGNOSIS: Bot 7 session expired even after fresh login. Account may be blocked.');
    return;
  }

  const anyLizHasDates = lizResults.some(r => r.dates.length > 0);

  if (bot7.dates.length === 0 && anyLizHasDates) {
    log('  DIAGNOSIS: Bot 7 sees [] but Liz sees dates.');
    log('  → SOFT BAN or ACCOUNT BLOCK on Bot 7\'s account.');
    log('  → Webshare polling likely contaminated the account.');
    log('  → Action: Wait 12-24h, or try from a different IP.');
    return;
  }

  if (bot7.dates.length === 0 && !anyLizHasDates) {
    log('  DIAGNOSIS: Both accounts see [] — no dates available in Lima right now.');
    log('  → Not a Bot 7 issue — Lima genuinely has no availability.');
    return;
  }

  if (bot7.dates.length > 0 && anyLizHasDates) {
    log('  DIAGNOSIS: Both accounts see dates. Bot 7 is NOT blocked.');
    log('  → Previous issue was likely session/proxy related (now resolved with fresh login).');
    return;
  }

  if (bot7.dates.length > 0 && !anyLizHasDates) {
    log('  DIAGNOSIS: Bot 7 sees dates but Liz doesn\'t.');
    log('  → Liz\'s account might be blocked or login issue.');
    return;
  }

  if (bot7.error) {
    log(`  DIAGNOSIS: Bot 7 errored — ${bot7.error}`);
    log('  → Investigate the specific error above.');
  }
}

// ── Main ──

async function main() {
  log('Compare Peru Accounts: Bot 7 vs Liz');
  log('READ-ONLY: No DB writes, no reschedule\n');

  // Phase 1
  const bot7Data = await loadBot7();

  // Phase 2
  const { userId: lizUserId, cookie: lizCookie, schedules: lizSchedules } = await loginAndDiscoverLiz();

  // Phase 3
  const updatedCookie = await fetchLizAppointmentPages(lizCookie, lizSchedules);

  // Phase 4
  printComparisonTable(bot7Data, lizSchedules);

  // Phase 5
  const daysResults = await fetchConsularDays(bot7Data, updatedCookie, lizSchedules);

  // Phase 6
  await compareDates(daysResults);

  // Phase 7
  diagnose(daysResults);

  log('\nDone.');
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

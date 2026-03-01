/**
 * Overnight polling loop: watch for dates in [2026-03-20, 2026-04-15] and reschedule Bot 6.
 *
 * - Polls every 60s normally, 90s after a block/error
 * - Re-login every 44min (session TTL ~88min)
 * - Auto-commits on first date found in range
 * - Exits after successful reschedule
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/reschedule-later.ts
 */

import { pureFetchLogin } from '../src/services/login.js';
import { VisaClient, SessionExpiredError } from '../src/services/visa-client.js';

const EMAIL = 'juanalbertoortega456@gmail.com';
const PASSWORD = 'Visacolombia2026.';
const SCHEDULE_ID = '72824354';
const APPLICANT_IDS = ['87117943', '87126508'];
const CONSULAR_FACILITY = '25';
const ASC_FACILITY = '26';
const LOCALE = 'es-co';

const RANGE_START = '2026-03-20';
const RANGE_END = '2026-04-15';

const POLL_INTERVAL_MS = 60_000;       // 1 min normal
const BLOCKED_INTERVAL_MS = 90_000;    // 1:30 after error/block
const RELOGIN_AFTER_MS = 44 * 60_000;  // 44 min

function ts(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/Bogota' });
}

let client: VisaClient;
let loginTime = 0;
let pollCount = 0;

async function login(): Promise<void> {
  const result = await pureFetchLogin(
    { email: EMAIL, password: PASSWORD, scheduleId: SCHEDULE_ID, applicantIds: APPLICANT_IDS, locale: LOCALE },
    { visaType: 'iv' },
  );

  client = new VisaClient(
    { cookie: result.cookie, csrfToken: result.csrfToken ?? '', authenticityToken: result.authenticityToken ?? '' },
    { scheduleId: SCHEDULE_ID, applicantIds: APPLICANT_IDS, consularFacilityId: CONSULAR_FACILITY, ascFacilityId: ASC_FACILITY, proxyProvider: 'direct', locale: LOCALE },
  );

  await client.refreshTokens();
  loginTime = Date.now();
  console.log(`[${ts()}] Login OK + tokens refreshed`);
}

async function tryReschedule(targetDate: string): Promise<boolean> {
  // Get consular times
  const timesData = await client.getConsularTimes(targetDate);
  if (timesData.available_times.length === 0) {
    console.log(`[${ts()}] No times for ${targetDate} — slot gone`);
    return false;
  }
  const consularTime = timesData.available_times[0]!;

  // Get CAS days (1-12 days before consular)
  const casDays = await client.getCasDays(targetDate, consularTime);
  const targetMs = new Date(targetDate).getTime();
  const filtered = casDays.filter(d => {
    const diff = (targetMs - new Date(d.date).getTime()) / 86400000;
    return diff >= 1 && diff <= 12;
  });

  // Fallback: any CAS day before consular
  let casDatePick = filtered[0]?.date;
  if (!casDatePick) {
    const before = casDays.filter(d => d.date < targetDate);
    casDatePick = before[before.length - 1]?.date;
  }
  if (!casDatePick) {
    console.log(`[${ts()}] No CAS dates for consular ${targetDate} ${consularTime}`);
    return false;
  }

  // Get CAS times
  const casTimesData = await client.getCasTimes(casDatePick);
  if (casTimesData.available_times.length === 0) {
    console.log(`[${ts()}] No CAS times for ${casDatePick}`);
    return false;
  }
  const casTime = casTimesData.available_times[0]!;

  console.log(`[${ts()}] RESCHEDULE: ${targetDate} ${consularTime} | CAS ${casDatePick} ${casTime}`);

  // Refresh tokens right before POST (prime server session)
  await client.refreshTokens();

  const success = await client.reschedule(targetDate, consularTime, casDatePick, casTime);
  return success;
}

async function poll(): Promise<'done' | 'empty' | 'error'> {
  pollCount++;

  // Pre-emptive re-login
  if (Date.now() - loginTime > RELOGIN_AFTER_MS) {
    console.log(`[${ts()}] Session >44min — re-login`);
    await login();
  }

  const allDays = await client.getConsularDays();
  const inRange = allDays.filter(d => d.date >= RANGE_START && d.date <= RANGE_END);

  if (inRange.length === 0) {
    const earliest = allDays[0]?.date ?? 'none';
    console.log(`[${ts()}] #${pollCount} — ${allDays.length} days, 0 in range (earliest: ${earliest})`);
    return 'empty';
  }

  // Found dates in range!
  console.log(`[${ts()}] #${pollCount} — FOUND ${inRange.length} dates in range: ${inRange.map(d => d.date).join(', ')}`);

  // Try each date in order (earliest first)
  for (const day of inRange) {
    try {
      const ok = await tryReschedule(day.date);
      if (ok) {
        console.log(`[${ts()}] SUCCESS — rescheduled to ${day.date}`);
        return 'done';
      }
    } catch (err) {
      console.log(`[${ts()}] Reschedule attempt for ${day.date} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`[${ts()}] All ${inRange.length} dates failed — will retry next poll`);
  return 'empty';
}

async function main() {
  console.log(`=== Overnight Reschedule Poller ===`);
  console.log(`Range: ${RANGE_START} → ${RANGE_END}`);
  console.log(`Normal interval: ${POLL_INTERVAL_MS / 1000}s | Blocked: ${BLOCKED_INTERVAL_MS / 1000}s`);
  console.log(`Re-login every ${RELOGIN_AFTER_MS / 60000}min\n`);

  // Initial login
  await login();

  // Show current appointment
  const current = await client.getCurrentAppointment();
  if (current) {
    console.log(`[${ts()}] Current: ${current.consularDate} ${current.consularTime} | CAS ${current.casDate} ${current.casTime}`);
  }
  console.log(`[${ts()}] Starting poll loop...\n`);

  // Poll loop
  while (true) {
    let delay = POLL_INTERVAL_MS;
    try {
      const result = await poll();
      if (result === 'done') {
        console.log(`\n[${ts()}] Done. Exiting.`);
        process.exit(0);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (err instanceof SessionExpiredError) {
        console.log(`[${ts()}] Session expired — re-login`);
        try {
          await login();
        } catch (loginErr) {
          console.log(`[${ts()}] Re-login failed: ${loginErr instanceof Error ? loginErr.message : loginErr}`);
          delay = BLOCKED_INTERVAL_MS;
        }
      } else if (msg.includes('other side closed') || msg.includes('ECONNRESET') || msg.includes('fetch failed')) {
        console.log(`[${ts()}] #${pollCount} — BLOCKED (${msg.substring(0, 60)}). Backing off to ${BLOCKED_INTERVAL_MS / 1000}s`);
        delay = BLOCKED_INTERVAL_MS;
      } else {
        console.log(`[${ts()}] #${pollCount} — ERROR: ${msg}`);
        delay = BLOCKED_INTERVAL_MS;
      }
    }

    await new Promise(r => setTimeout(r, delay));
  }
}

main().catch(err => {
  console.error(`[${ts()}] Fatal:`, err instanceof Error ? err.message : err);
  process.exit(1);
});

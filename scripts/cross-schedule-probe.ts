/**
 * Cross-schedule probe: Try to fetch times + reschedule Bot 7 to dates
 * only visible in Liz's days.json (March 2026).
 *
 * Hypothesis: days.json is filtered per-schedule, but getTimes() and POST
 * reschedule might accept any valid date regardless.
 *
 * SAFE: dry-run by default. Pass --commit to actually POST.
 * CRITICAL: Bot 7 has maxReschedules=1, rescheduleCount=0. Peru = 2 max ever.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/cross-schedule-probe.ts           # dry-run
 *   npx tsx --env-file=.env scripts/cross-schedule-probe.ts --commit  # REAL
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';
import { VisaClient, type DaySlot, type TimeSlots } from '../src/services/visa-client.js';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl } from '../src/utils/constants.js';

const BOT_ID = 7;
const LOCALE = 'es-pe';
const COMMIT = process.argv.includes('--commit');

// Dates visible to Liz but NOT to Bot 7 (from compare-peru-accounts output)
const PROBE_DATES = ['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26', '2026-03-30'];

function log(msg: string) {
  const ts = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Bogota', hour12: false });
  console.log(`[${ts}] ${msg}`);
}

async function main() {
  log(`Cross-schedule probe — Bot ${BOT_ID} — ${COMMIT ? '🔴 COMMIT MODE' : '🟢 DRY-RUN'}`);
  if (COMMIT) {
    log('⚠️  COMMIT MODE — will attempt REAL reschedule POST');
    log('⚠️  Bot 7: maxReschedules=1, rescheduleCount=0 — THIS IS THE ONLY SHOT');
  }

  // ── Load bot ──
  const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
  if (!bot) throw new Error(`Bot ${BOT_ID} not found`);

  log(`Current appointment: ${bot.currentConsularDate} ${bot.currentConsularTime}`);
  log(`maxReschedules: ${bot.maxReschedules}, rescheduleCount: ${bot.rescheduleCount}`);
  log(`targetDateBefore: ${bot.targetDateBefore}`);

  // Safety checks
  if (bot.maxReschedules !== null && bot.rescheduleCount >= bot.maxReschedules) {
    log('❌ rescheduleCount >= maxReschedules — ABORTING');
    process.exit(1);
  }

  // ── Fresh login (direct, no proxy) ──
  log('\nFresh login (direct)...');
  const loginResult = await performLogin({
    email: decrypt(bot.visaEmail),
    password: decrypt(bot.visaPassword),
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    locale: bot.locale,
  });
  log(`Login OK — hasTokens=${loginResult.hasTokens}`);

  const client = new VisaClient(loginResult, {
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    consularFacilityId: bot.consularFacilityId,
    ascFacilityId: bot.ascFacilityId,
    proxyProvider: 'direct',
    locale: bot.locale,
  });

  // refreshTokens to prime server-side session + get AJAX headers
  log('refreshTokens...');
  await client.refreshTokens();
  log('Tokens OK');

  // ── Verify: Bot 7's own days.json ──
  log('\nBot 7 days.json (verify baseline)...');
  const ownDays = await client.getConsularDays();
  const ownDates = ownDays.map(d => d.date);
  log(`  ${ownDates.length} dates (earliest: ${ownDates[0] || 'none'})`);

  const probeInOwn = PROBE_DATES.filter(d => ownDates.includes(d));
  if (probeInOwn.length > 0) {
    log(`  ✅ ${probeInOwn.length} probe dates ARE in Bot 7's days.json: ${probeInOwn.join(', ')}`);
    log('  → No need for cross-schedule trick — dates are directly visible!');
  } else {
    log(`  ❌ None of the probe dates appear in Bot 7's days.json`);
    log('  → Proceeding with cross-schedule probe (getTimes for invisible dates)');
  }

  // ── Phase 1: Probe getTimes for each date ──
  log('\n=== Probing getTimes for invisible dates ===');

  interface ProbeResult {
    date: string;
    times: string[];
    error?: string;
  }

  const results: ProbeResult[] = [];

  for (const date of PROBE_DATES) {
    log(`\n  ${date}:`);
    try {
      const times = await client.getConsularTimes(date);
      const available = times.available_times || [];
      log(`    available_times: ${available.length > 0 ? available.join(', ') : '(empty)'}`);
      results.push({ date, times: available });

      if (available.length > 0) {
        log(`    ✅ TIMES EXIST — date is bookable even though invisible in days.json!`);
      } else {
        log(`    ⚠️  No times — date might be fully booked or genuinely unavailable`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`    ❌ ERROR: ${msg}`);
      results.push({ date, times: [], error: msg });
    }

    // Small delay between probes
    await new Promise(r => setTimeout(r, 500));
  }

  // ── Summary ──
  log('\n=== Probe Summary ===');
  const bookable = results.filter(r => r.times.length > 0);
  const empty = results.filter(r => r.times.length === 0 && !r.error);
  const errored = results.filter(r => r.error);

  log(`  Bookable (have times): ${bookable.length}`);
  log(`  Empty (no times): ${empty.length}`);
  log(`  Errored: ${errored.length}`);

  if (bookable.length === 0) {
    log('\n❌ No bookable dates found. Cross-schedule trick did not work.');
    log('   The API likely enforces per-schedule visibility on times as well.');
    process.exit(0);
  }

  // ── Show bookable options ──
  log('\n=== Bookable dates ===');
  for (const r of bookable) {
    log(`  ${r.date}: ${r.times.slice(0, 5).join(', ')}${r.times.length > 5 ? ` (+${r.times.length - 5} more)` : ''}`);
  }

  // Pick best (earliest date, latest time = less competitive)
  const bestDate = bookable[0]!;
  const bestTime = bestDate.times[bestDate.times.length - 1]!; // latest time slot
  log(`\n  Best candidate: ${bestDate.date} ${bestTime}`);

  // ── Safety validation before POST ──
  const currentDate = bot.currentConsularDate;
  if (currentDate && bestDate.date >= currentDate) {
    log(`\n❌ BLOCKED: ${bestDate.date} is NOT earlier than current ${currentDate}`);
    log('   REGLA CRITICA: Never reschedule to equal or later date.');
    process.exit(1);
  }

  if (bot.targetDateBefore && bestDate.date >= bot.targetDateBefore) {
    log(`\n❌ BLOCKED: ${bestDate.date} is NOT before targetDateBefore ${bot.targetDateBefore}`);
    process.exit(1);
  }

  const improvement = currentDate
    ? Math.round((new Date(currentDate).getTime() - new Date(bestDate.date).getTime()) / 86400000)
    : 0;
  log(`  Improvement: ${improvement} days earlier`);

  if (!COMMIT) {
    log('\n🟢 DRY-RUN: Would reschedule to ' + bestDate.date + ' ' + bestTime);
    log('   Run with --commit to execute.');
    process.exit(0);
  }

  // ── COMMIT: Actual reschedule POST ──
  log('\n🔴 EXECUTING RESCHEDULE POST...');
  log(`   ${bot.currentConsularDate} ${bot.currentConsularTime} → ${bestDate.date} ${bestTime}`);
  log(`   Schedule: ${bot.scheduleId}, Applicants: ${bot.applicantIds.join(', ')}`);

  // Peru has no CAS
  const success = await client.reschedule(bestDate.date, bestTime);

  if (success) {
    log(`\n✅ RESCHEDULE SUCCESS: ${bestDate.date} ${bestTime}`);
    log(`   Moved from ${bot.currentConsularDate} — ${improvement} days earlier!`);
  } else {
    log(`\n❌ RESCHEDULE FAILED: POST returned false`);
    log('   The slot may have been taken or the API rejected the cross-schedule date.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

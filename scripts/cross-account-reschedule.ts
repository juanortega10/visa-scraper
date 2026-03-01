/**
 * Cross-account reschedule: Fetch real times from Liz's account,
 * then POST reschedule on Bot 7 using those date+time values.
 *
 * Hypothesis: The POST endpoint might accept any valid date+time,
 * even if Bot 7's days.json doesn't show them.
 *
 * DRY-RUN by default. Pass --commit to POST.
 *
 * ⚠️  Bot 7: maxReschedules=1, rescheduleCount=0. Peru = 2 max EVER.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/cross-account-reschedule.ts
 *   npx tsx --env-file=.env scripts/cross-account-reschedule.ts --commit
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { pureFetchLogin, performLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';

const BOT_ID = 7;
const LIZ_EMAIL = 'shiara.arauzo@hotmail.com';
const LIZ_PASSWORD = '=Visa123ReunionHackaton';
const LOCALE = 'es-pe';
const COMMIT = process.argv.includes('--commit');

// Dates visible to Liz but NOT Bot 7
const TARGET_DATES = ['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26'];

// Use the first Liz schedule that worked
const LIZ_SCHEDULE_ID = '69454137';
const LIZ_APPLICANT_ID = '80769164';

function log(msg: string) {
  const ts = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Bogota', hour12: false });
  console.log(`[${ts}] ${msg}`);
}

async function main() {
  log(`Cross-account reschedule — Bot ${BOT_ID} — ${COMMIT ? '🔴 COMMIT' : '🟢 DRY-RUN'}`);

  // ── Load Bot 7 ──
  const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
  if (!bot) throw new Error(`Bot ${BOT_ID} not found`);

  log(`Bot 7 current: ${bot.currentConsularDate} ${bot.currentConsularTime}`);
  log(`maxReschedules: ${bot.maxReschedules}, rescheduleCount: ${bot.rescheduleCount}`);
  log(`targetDateBefore: ${bot.targetDateBefore}`);

  if (bot.maxReschedules !== null && bot.rescheduleCount >= bot.maxReschedules) {
    log('❌ rescheduleCount >= maxReschedules — ABORTING');
    process.exit(1);
  }

  // ── Step 1: Login as Liz, fetch real times ──
  log('\n=== Step 1: Fetch real times from Liz\'s account ===');
  const lizLogin = await pureFetchLogin(
    { email: LIZ_EMAIL, password: LIZ_PASSWORD, scheduleId: LIZ_SCHEDULE_ID, applicantIds: [LIZ_APPLICANT_ID], locale: LOCALE },
    { skipTokens: false },
  );
  log(`Liz login OK — hasTokens=${lizLogin.hasTokens}`);

  const lizClient = new VisaClient(lizLogin, {
    scheduleId: LIZ_SCHEDULE_ID,
    applicantIds: [LIZ_APPLICANT_ID],
    consularFacilityId: '115',
    ascFacilityId: '',
    proxyProvider: 'direct',
    locale: LOCALE,
  });

  // refreshTokens for AJAX
  await lizClient.refreshTokens();
  log('Liz tokens OK');

  // Verify Liz sees these dates
  const lizDays = await lizClient.getConsularDays();
  const lizDates = lizDays.map(d => d.date);
  log(`Liz days.json: ${lizDates.length} dates (earliest: ${lizDates[0]})`);

  // Fetch times for each target date from Liz's account
  interface DateTimeOption {
    date: string;
    times: string[];
  }
  const options: DateTimeOption[] = [];

  for (const date of TARGET_DATES) {
    if (!lizDates.includes(date)) {
      log(`  ${date}: NOT in Liz's days.json — skip`);
      continue;
    }
    try {
      const timesResult = await lizClient.getConsularTimes(date);
      const available = (timesResult.available_times || []).filter((t): t is string => t !== null);
      log(`  ${date}: ${available.length} times → ${available.join(', ') || '(none)'}`);
      if (available.length > 0) {
        options.push({ date, times: available });
      }
    } catch (err) {
      log(`  ${date}: ERROR — ${err instanceof Error ? err.message : err}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  if (options.length === 0) {
    log('\n❌ No bookable date+time combinations found from Liz\'s account.');
    process.exit(0);
  }

  // Pick best: earliest date, latest time (less competitive)
  const bestOption = options[0]!;
  const bestTime = bestOption.times[bestOption.times.length - 1]!;
  log(`\n✅ Best candidate from Liz: ${bestOption.date} ${bestTime}`);

  // ── Step 2: Login as Bot 7 ──
  log('\n=== Step 2: Login as Bot 7 (fresh, direct) ===');
  const bot7Login = await performLogin({
    email: decrypt(bot.visaEmail),
    password: decrypt(bot.visaPassword),
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    locale: bot.locale,
  });
  log(`Bot 7 login OK — hasTokens=${bot7Login.hasTokens}`);

  const bot7Client = new VisaClient(bot7Login, {
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    consularFacilityId: bot.consularFacilityId,
    ascFacilityId: bot.ascFacilityId,
    proxyProvider: 'direct',
    locale: bot.locale,
  });

  // refreshTokens — required for POST (primes server-side session)
  await bot7Client.refreshTokens();
  log('Bot 7 tokens OK');

  // ── Safety checks ──
  const currentDate = bot.currentConsularDate;
  if (currentDate && bestOption.date >= currentDate) {
    log(`\n❌ BLOCKED: ${bestOption.date} >= current ${currentDate}`);
    process.exit(1);
  }
  if (bot.targetDateBefore && bestOption.date >= bot.targetDateBefore) {
    log(`\n❌ BLOCKED: ${bestOption.date} >= targetDateBefore ${bot.targetDateBefore}`);
    process.exit(1);
  }

  const improvement = currentDate
    ? Math.round((new Date(currentDate).getTime() - new Date(bestOption.date).getTime()) / 86400000)
    : 0;

  log(`\n=== Reschedule Plan ===`);
  log(`  From: ${bot.currentConsularDate} ${bot.currentConsularTime}`);
  log(`  To:   ${bestOption.date} ${bestTime}`);
  log(`  Improvement: ${improvement} days earlier`);
  log(`  Schedule: ${bot.scheduleId}`);
  log(`  Applicants: ${bot.applicantIds.join(', ')}`);
  log(`  Facility: ${bot.consularFacilityId} (Lima)`);
  log(`  CAS: N/A (Peru)`);

  if (!COMMIT) {
    log('\n🟢 DRY-RUN complete. Run with --commit to execute POST.');
    // Show all available options
    log('\nAll bookable options:');
    for (const opt of options) {
      for (const t of opt.times) {
        log(`  ${opt.date} ${t}`);
      }
    }
    process.exit(0);
  }

  // ── Step 3: POST reschedule ──
  log('\n🔴 POSTING RESCHEDULE...');
  log(`⚠️  This is Bot 7's ONLY reschedule attempt (maxReschedules=1)`);

  try {
    const success = await bot7Client.reschedule(bestOption.date, bestTime);

    if (success) {
      log(`\n✅✅✅ RESCHEDULE SUCCESS: ${bestOption.date} ${bestTime}`);
      log(`Moved from ${bot.currentConsularDate} — ${improvement} days earlier!`);
    } else {
      log(`\n❌ RESCHEDULE FAILED: POST returned false`);
      log('The server may have rejected the cross-account date.');
    }
  } catch (err) {
    log(`\n❌ RESCHEDULE ERROR: ${err instanceof Error ? err.message : err}`);
  }

  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

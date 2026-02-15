/**
 * E2E Reschedule Test (DRY-RUN by default)
 *
 * Walks through the FULL reschedule flow:
 *   1. refreshTokens()
 *   2. getConsularDays() → pick earliest
 *   3. getConsularTimes(date) → pick first
 *   4. getCasDays(date, time) → pick first
 *   5. getCasTimes(date) → pick first
 *   6. (Optional) reschedule() POST — ONLY if --commit flag is passed
 *
 * Usage:
 *   npm run test-reschedule           # dry-run (default)
 *   npm run test-reschedule -- --commit  # REAL reschedule POST
 *   npm run test-reschedule -- --bot-id=2
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots, sessions, excludedDates, excludedTimes } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { VisaClient } from '../src/services/visa-client.js';
import { filterDates, filterTimes, isAtLeastNDaysEarlier } from '../src/utils/date-helpers.js';
import type { ProxyProvider } from '../src/services/proxy-fetch.js';

const isCommit = process.argv.includes('--commit');
const botIdArg = process.argv.find((a) => a.startsWith('--bot-id='));
const botId = botIdArg ? parseInt(botIdArg.split('=')[1]!, 10) : 6;

function step(n: number, label: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  STEP ${n}: ${label}`);
  console.log('='.repeat(60));
}

async function main() {
  console.log(`\n🔬 E2E Reschedule Test — ${isCommit ? '⚠️  REAL (--commit)' : '🛡️  DRY-RUN'}`);
  console.log(`Bot: ${botId}\n`);

  // ── Load bot + session ──
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) { console.error(`Bot ${botId} not found`); process.exit(1); }

  const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));
  if (!session) { console.error(`No session for bot ${botId}. Run: npm run login -- --bot-id=${botId}`); process.exit(1); }

  const cookie = decrypt(session.yatriCookie);
  const exDates = await db.select().from(excludedDates).where(eq(excludedDates.botId, botId));
  const exTimes = await db.select().from(excludedTimes).where(eq(excludedTimes.botId, botId));

  console.log(`Current consular: ${bot.currentConsularDate} ${bot.currentConsularTime}`);
  console.log(`Current CAS:      ${bot.currentCasDate} ${bot.currentCasTime}`);
  console.log(`Provider:         ${bot.proxyProvider}`);
  console.log(`Excluded dates:   ${exDates.length} ranges`);
  console.log(`Excluded times:   ${exTimes.length} ranges`);

  const client = new VisaClient(
    { cookie, csrfToken: session.csrfToken ?? '', authenticityToken: session.authenticityToken ?? '' },
    {
      scheduleId: bot.scheduleId,
      applicantIds: bot.applicantIds,
      consularFacilityId: bot.consularFacilityId,
      ascFacilityId: bot.ascFacilityId,
      proxyProvider: bot.proxyProvider as ProxyProvider,
    },
  );

  // ── Step 1: Refresh tokens ──
  step(1, 'refreshTokens()');
  const t1 = Date.now();
  await client.refreshTokens();
  const sess = client.getSession();
  console.log(`  CSRF:  ${sess.csrfToken.substring(0, 40)}...`);
  console.log(`  Auth:  ${sess.authenticityToken.substring(0, 40)}...`);
  console.log(`  ⏱️  ${Date.now() - t1}ms`);

  // ── Step 2: Get consular days ──
  step(2, 'getConsularDays()');
  const t2 = Date.now();
  const days = await client.getConsularDays();
  console.log(`  Total available: ${days.length} days`);
  console.log(`  First 5: ${days.slice(0, 5).map(d => d.date).join(', ')}`);
  console.log(`  Last 5:  ${days.slice(-5).map(d => d.date).join(', ')}`);
  console.log(`  ⏱️  ${Date.now() - t2}ms`);

  // Filter
  const filteredDays = filterDates(
    days,
    exDates.map((d) => ({ startDate: d.startDate, endDate: d.endDate })),
  );
  console.log(`  After exclusion filter: ${filteredDays.length} days`);

  const candidates = filteredDays
    .filter((d) => bot.currentConsularDate ? isAtLeastNDaysEarlier(d.date, bot.currentConsularDate, 1) : true)
    .slice(0, 3);

  console.log(`  Candidates (earlier than ${bot.currentConsularDate}, max 3):`);
  if (candidates.length === 0) {
    console.log('  ❌ No candidates — all available dates are same or later than current.');
    console.log('  Showing first 3 available dates anyway for reference:');
    for (const d of filteredDays.slice(0, 3)) {
      console.log(`    📅 ${d.date} (business_day: ${d.business_day})`);
    }
  } else {
    for (const d of candidates) {
      console.log(`    📅 ${d.date} (business_day: ${d.business_day})`);
    }
  }

  // Use first available date for the flow walkthrough (even if not earlier)
  const targetDate = candidates[0]?.date ?? filteredDays[0]?.date;
  if (!targetDate) {
    console.log('\n❌ No available dates at all. Exiting.');
    process.exit(0);
  }
  console.log(`\n  → Using date: ${targetDate} for flow walkthrough`);

  // ── Step 3: Get consular times ──
  step(3, `getConsularTimes('${targetDate}')`);
  const t3 = Date.now();
  const timesData = await client.getConsularTimes(targetDate);
  const timeExclusions = exTimes.map((t) => ({ date: t.date, timeStart: t.timeStart, timeEnd: t.timeEnd }));
  const filteredTimes = filterTimes(targetDate, timesData.available_times, timeExclusions);
  console.log(`  Available: ${timesData.available_times.join(', ')}`);
  console.log(`  After filter: ${filteredTimes.join(', ')}`);
  console.log(`  ⏱️  ${Date.now() - t3}ms`);

  if (filteredTimes.length === 0) {
    console.log('  ❌ No times available after filtering');
    process.exit(0);
  }
  const consularTime = filteredTimes[0]!;
  console.log(`  → Selected: ${consularTime}`);

  // ── Step 4: Get CAS days ──
  step(4, `getCasDays('${targetDate}', '${consularTime}')`);
  const t4 = Date.now();
  const casDays = await client.getCasDays(targetDate, consularTime);
  const filteredCasDays = filterDates(
    casDays,
    exDates.map((d) => ({ startDate: d.startDate, endDate: d.endDate })),
  );
  console.log(`  Total CAS days: ${casDays.length}`);
  console.log(`  After filter:   ${filteredCasDays.length}`);
  console.log(`  First 5: ${filteredCasDays.slice(0, 5).map(d => d.date).join(', ')}`);
  console.log(`  ⏱️  ${Date.now() - t4}ms`);

  if (filteredCasDays.length === 0) {
    console.log('  ❌ No CAS days available');
    process.exit(0);
  }
  const casDate = filteredCasDays[0]!.date;
  console.log(`  → Selected CAS date: ${casDate}`);

  // ── Step 5: Get CAS times ──
  step(5, `getCasTimes('${casDate}')`);
  const t5 = Date.now();
  const casTimesData = await client.getCasTimes(casDate);
  const filteredCasTimes = filterTimes(casDate, casTimesData.available_times, timeExclusions);
  console.log(`  Available: ${casTimesData.available_times.slice(0, 10).join(', ')}${casTimesData.available_times.length > 10 ? ` ... (${casTimesData.available_times.length} total)` : ''}`);
  console.log(`  After filter: ${filteredCasTimes.length} times`);
  console.log(`  ⏱️  ${Date.now() - t5}ms`);

  if (filteredCasTimes.length === 0) {
    console.log('  ❌ No CAS times available');
    process.exit(0);
  }
  const casTime = filteredCasTimes[0]!;
  console.log(`  → Selected CAS time: ${casTime}`);

  // ── Summary ──
  console.log(`\n${'='.repeat(60)}`);
  console.log('  RESCHEDULE SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Current:  Consular ${bot.currentConsularDate} ${bot.currentConsularTime}`);
  console.log(`            CAS      ${bot.currentCasDate} ${bot.currentCasTime}`);
  console.log(`  Proposed: Consular ${targetDate} ${consularTime}`);
  console.log(`            CAS      ${casDate} ${casTime}`);

  const wouldImprove = bot.currentConsularDate ? isAtLeastNDaysEarlier(targetDate, bot.currentConsularDate, 1) : true;
  console.log(`  Improvement: ${wouldImprove ? '✅ YES — earlier date' : '❌ NO — same or later'}`);

  // ── Step 6: POST (only with --commit) ──
  if (!isCommit) {
    step(6, 'reschedule() POST — SKIPPED (dry-run)');
    console.log('  Pass --commit flag to execute the actual reschedule POST.');
    console.log('  ⚠️  This is IRREVERSIBLE — it will change your real appointment.');
  } else {
    step(6, 'reschedule() POST — EXECUTING');
    if (!wouldImprove) {
      console.log('  ⚠️  WARNING: proposed date is NOT earlier. Proceeding anyway (--commit)...');
    }
    const t6 = Date.now();
    const success = await client.reschedule(targetDate, consularTime, casDate, casTime);
    console.log(`  Result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);
    console.log(`  ⏱️  ${Date.now() - t6}ms`);

    if (success) {
      console.log(`\n  🎉 Appointment rescheduled to:`);
      console.log(`     Consular: ${targetDate} ${consularTime}`);
      console.log(`     CAS:      ${casDate} ${casTime}`);
    }
  }

  console.log(`\n✅ E2E flow completed. Total API calls: ${isCommit ? 7 : 5}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ Error:', e instanceof Error ? e.message : e);
  process.exit(1);
});

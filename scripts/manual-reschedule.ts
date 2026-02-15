/**
 * Manual reschedule attempt — bypasses Trigger.dev, runs locally.
 * Usage: npx tsx --env-file=.env scripts/manual-reschedule.ts --bot-id=6
 */
import { db } from '../src/db/client.js';
import { bots, sessions, excludedDates, excludedTimes } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { VisaClient, type DaySlot } from '../src/services/visa-client.js';
import { filterDates, filterTimes, isAtLeastNDaysEarlier } from '../src/utils/date-helpers.js';
import type { ProxyProvider } from '../src/services/proxy-fetch.js';

const args = process.argv.slice(2);
const botIdArg = args.find(a => a.startsWith('--bot-id='));
const botId = botIdArg ? parseInt(botIdArg.split('=')[1]!) : 6;
const commit = args.includes('--commit');

console.log(`\n=== Manual Reschedule for Bot ${botId} ===`);
console.log(`Mode: ${commit ? 'COMMIT (REAL reschedule)' : 'DRY CHECK (no POST)'}\n`);

const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
if (!bot) { console.error('Bot not found'); process.exit(1); }

const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));
if (!session) { console.error('No session'); process.exit(1); }

const cookie = decrypt(session.yatriCookie);
const client = new VisaClient(
  { cookie, csrfToken: session.csrfToken ?? '', authenticityToken: session.authenticityToken ?? '' },
  {
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    consularFacilityId: bot.consularFacilityId,
    ascFacilityId: bot.ascFacilityId,
    proxyProvider: bot.proxyProvider as ProxyProvider,
    userId: bot.userId,
    locale: bot.locale,
  },
);

const exDates = await db.select().from(excludedDates).where(eq(excludedDates.botId, botId));
const dateExclusions = exDates.map(d => ({ startDate: d.startDate, endDate: d.endDate }));

const exTimes = await db.select().from(excludedTimes).where(eq(excludedTimes.botId, botId));
const timeExclusions = exTimes.map(t => ({ date: t.date, timeStart: t.timeStart, timeEnd: t.timeEnd }));

// 1. Fetch consular days
console.log('Fetching consular days...');
const allDays = await client.getConsularDays();
const filteredDays = filterDates(allDays, dateExclusions);
console.log(`Total: ${allDays.length}, After filter: ${filteredDays.length}`);

const candidates = filteredDays.filter(d =>
  bot.currentConsularDate ? isAtLeastNDaysEarlier(d.date, bot.currentConsularDate, 1) : true
);
console.log(`Candidates better than ${bot.currentConsularDate}: ${candidates.length}`);

if (candidates.length === 0) {
  console.log('No dates better than current. Exiting.');
  process.exit(0);
}

const targetDate = candidates[0]!.date;
console.log(`\nTarget date: ${targetDate} (current: ${bot.currentConsularDate})`);
const daysEarlier = Math.floor((new Date(bot.currentConsularDate!).getTime() - new Date(targetDate).getTime()) / 86400000);
console.log(`This is ${daysEarlier} days earlier!\n`);

// 2. Get ALL consular times
console.log(`Fetching consular times for ${targetDate}...`);
const timesData = await client.getConsularTimes(targetDate);
const consularTimes = filterTimes(targetDate, timesData.available_times, timeExclusions);
console.log(`Available times: ${consularTimes.join(', ')}`);

if (consularTimes.length === 0) {
  console.log('No consular times available. Exiting.');
  process.exit(0);
}

// 3. Try each consular time for CAS availability
for (const time of consularTimes) {
  console.log(`\n--- Trying consular time: ${time} ---`);

  const casDays = await client.getCasDays(targetDate, time);
  const filteredCasDays = filterDates(casDays, dateExclusions);
  console.log(`CAS days: ${casDays.length} total, ${filteredCasDays.length} after filter`);

  if (filteredCasDays.length === 0) {
    console.log(`No CAS days for time ${time}. Trying next...`);
    continue;
  }

  const casDate = filteredCasDays[0]!.date;
  console.log(`Best CAS date: ${casDate}`);

  const casTimesData = await client.getCasTimes(casDate);
  const casTimes = filterTimes(casDate, casTimesData.available_times, timeExclusions);
  console.log(`CAS times: ${casTimes.length} available`);

  if (casTimes.length === 0) {
    console.log(`No CAS times for ${casDate}. Trying next consular time...`);
    continue;
  }

  const casTime = casTimes[0]!;
  console.log(`\n✓ FOUND VALID COMBO:`);
  console.log(`  Consular: ${targetDate} ${time}`);
  console.log(`  CAS:      ${casDate} ${casTime}`);

  if (!commit) {
    console.log(`\nDRY CHECK — run with --commit to actually reschedule.`);
    process.exit(0);
  }

  console.log(`\nPOSTing reschedule...`);
  const success = await client.reschedule(targetDate, time, casDate, casTime);

  if (success) {
    console.log(`\n🎉 RESCHEDULE SUCCESSFUL!`);
    console.log(`  Old: ${bot.currentConsularDate} ${bot.currentConsularTime}`);
    console.log(`  New: ${targetDate} ${time}`);

    // Update DB
    await db.update(bots).set({
      currentConsularDate: targetDate,
      currentConsularTime: time,
      currentCasDate: casDate,
      currentCasTime: casTime,
      updatedAt: new Date(),
    }).where(eq(bots.id, botId));
    console.log('DB updated.');
  } else {
    console.log(`\n✗ POST returned false — reschedule rejected.`);
  }
  process.exit(0);
}

console.log(`\n✗ ALL consular times exhausted — no CAS availability for any time slot.`);
process.exit(1);

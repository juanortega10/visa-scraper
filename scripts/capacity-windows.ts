/**
 * Estimate total windows per consular time slot.
 *
 * Strategy:
 * 1. Far-future dates (~14 months out) should have ~0 bookings → full capacity
 * 2. Near dates (Nov 2026) have partial bookings → reduced capacity
 * 3. Compare both bots to bracket the remaining capacity per slot
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { VisaClient } from '../src/services/visa-client.js';

const BOT_A_ID = 6;   // 2 applicants
const BOT_B_ID = 12;  // 4 applicants
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) { if (i === retries) throw e; await sleep(1000); }
  }
  throw new Error('unreachable');
}

async function loadClient(botId: number) {
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) throw new Error(`Bot ${botId} not found`);
  const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));
  if (!session?.yatriCookie) throw new Error(`Bot ${botId} no session`);
  return new VisaClient(
    { cookie: decrypt(session.yatriCookie), csrfToken: session.csrfToken, authenticityToken: session.authenticityToken },
    { scheduleId: bot.scheduleId, applicantIds: bot.applicantIds, consularFacilityId: bot.consularFacilityId, ascFacilityId: bot.ascFacilityId, proxyProvider: 'direct', locale: bot.locale },
  );
}

async function main() {
  console.log('=== Window Count Estimation ===\n');

  const clientA = await loadClient(BOT_A_ID);
  const clientB = await loadClient(BOT_B_ID);

  // Get all days for both bots
  const [daysA, daysB] = await Promise.all([
    withRetry(() => clientA.getConsularDays()),
    withRetry(() => clientB.getConsularDays()),
  ]);

  const datesA = new Set(daysA.map(d => d.date));
  const datesB = new Set(daysB.map(d => d.date));

  // Group dates by distance from today
  const today = new Date('2026-02-16');
  const datesByMonth: Map<string, string[]> = new Map();
  for (const d of daysA) {
    const month = d.date.substring(0, 7); // YYYY-MM
    if (!datesByMonth.has(month)) datesByMonth.set(month, []);
    datesByMonth.get(month)!.push(d.date);
  }

  console.log('Dates by month (bot 6, 2p):');
  for (const [month, dates] of [...datesByMonth.entries()].sort()) {
    console.log(`  ${month}: ${dates.length} dates`);
  }

  // Pick dates across the range: 1 near (Nov), 1 mid (Jan), 1 far (Apr)
  const sorted = daysA.map(d => d.date).sort();
  const nearDates = sorted.filter(d => d.startsWith('2026-11')).slice(0, 3);
  const midDates = sorted.filter(d => d.startsWith('2027-01')).slice(0, 3);
  const farDates = sorted.filter(d => d.startsWith('2027-04') || d.startsWith('2027-03')).slice(-3);

  const allSample = [...nearDates, ...midDates, ...farDates];

  console.log(`\nSampling: near=${nearDates}, mid=${midDates}, far=${farDates}\n`);
  console.log('Date        | Months out | 2p times | 4p times | Lost | 2p-only slots');
  console.log('------------|-----------|----------|----------|------|-------------');

  // All possible 15-min slots in the consular window
  const allSlots = new Set<string>();

  for (const date of allSample) {
    const [tA, tB] = await Promise.all([
      withRetry(() => clientA.getConsularTimes(date)),
      withRetry(() => clientB.getConsularTimes(date).catch(() => ({ available_times: [] as string[] }))),
    ]);
    await sleep(500);

    const monthsOut = ((new Date(date).getTime() - today.getTime()) / (30 * 86400000)).toFixed(1);
    const setB = new Set(tB.available_times);
    const lost = tA.available_times.filter((t: string) => !setB.has(t));
    const inB = !datesB.has(date) ? '(not in 4p)' : '';

    // Track all slots seen
    tA.available_times.forEach((t: string) => allSlots.add(t));

    console.log(`${date} | ${monthsOut.padStart(9)} | ${String(tA.available_times.length).padStart(8)} | ${String(tB.available_times.length).padStart(8)} | ${String(lost.length).padStart(4)} | ${lost.join(', ')} ${inB}`);
  }

  console.log(`\nAll unique time slots seen across all dates: ${[...allSlots].sort().join(', ')}`);
  console.log(`Total unique slots: ${allSlots.size}`);

  // For the farthest dates (presumably near-empty), the number of times ≈ total slots per day
  // Both bots should see the same → remaining capacity = total capacity for each slot
  console.log('\n━━━ Analysis ━━━');

  const farTimesA: string[][] = [];
  const farTimesB: string[][] = [];
  for (const date of farDates) {
    const [tA, tB] = await Promise.all([
      withRetry(() => clientA.getConsularTimes(date)),
      withRetry(() => clientB.getConsularTimes(date).catch(() => ({ available_times: [] as string[] }))),
    ]);
    farTimesA.push(tA.available_times);
    farTimesB.push(tB.available_times);
    await sleep(500);
  }

  const maxFarA = Math.max(...farTimesA.map(t => t.length));
  const maxFarB = Math.max(...farTimesB.map(t => t.length));

  console.log(`Far-future max times: 2p=${maxFarA}, 4p=${maxFarB}`);
  if (maxFarA === maxFarB) {
    console.log(`→ Far dates have identical capacity → slots are at full capacity`);
    console.log(`→ Total time slots per day: ~${maxFarA}`);
    console.log(`→ Each slot has AT LEAST ${4} windows (since 4p can book)`);
  }

  // For near dates with differences, we can bracket remaining capacity
  console.log('\n━━━ Remaining capacity per slot (near dates) ━━━');
  console.log('For slots that 2p sees but 4p doesn\'t: 2 ≤ remaining < 4');
  console.log('For slots both see: remaining ≥ 4');
  console.log('For slots neither sees: remaining < 2 (0 or 1)');

  // Count how many slots fall into each bucket per near date
  for (const date of nearDates) {
    const [tA, tB] = await Promise.all([
      withRetry(() => clientA.getConsularTimes(date)),
      withRetry(() => clientB.getConsularTimes(date).catch(() => ({ available_times: [] as string[] }))),
    ]);
    await sleep(500);

    const setA = new Set(tA.available_times);
    const setB = new Set(tB.available_times);
    const both = tA.available_times.filter((t: string) => setB.has(t)).length;
    const onlyA = tA.available_times.filter((t: string) => !setB.has(t)).length;
    // Slots that neither sees = maxFarA - setA.size (approximately)
    const neither = Math.max(0, maxFarA - setA.size);

    console.log(`  ${date}: ≥4 windows: ${both} slots | 2-3 windows: ${onlyA} slots | 0-1 windows: ~${neither} slots`);
  }

  console.log('\n━━━ Total windows estimation ━━━');
  console.log('We CANNOT determine exact total windows per slot with only 2 group sizes.');
  console.log('We would need a 3rd bot with a different applicant count (e.g., 1, 3, 6, or 8)');
  console.log('to narrow it further.');
  console.log('');
  console.log('Lower bound: ≥4 windows (since 4p can book far-future slots)');
  console.log('Typical for US consulate: ~10-20 interview windows running in parallel per 15-min block');

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

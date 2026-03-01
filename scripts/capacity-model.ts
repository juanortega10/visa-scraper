/**
 * Determine if consular availability differs by schedule (group size).
 * ALL fetches for bot A and bot B are done in PARALLEL (Promise.all)
 * to eliminate timing differences.
 *
 * Runs 3 iterations with 5s between each.
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { VisaClient } from '../src/services/visa-client.js';

const BOT_A_ID = 6;   // 2 applicants
const BOT_B_ID = 12;  // 4 applicants
const ITERATIONS = 3;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries) throw e;
      await sleep(1000);
    }
  }
  throw new Error('unreachable');
}

async function parallelFetch<T>(fnA: () => Promise<T>, fnB: () => Promise<T>): Promise<[T, T]> {
  return Promise.all([withRetry(fnA), withRetry(fnB)]);
}

async function loadClient(botId: number) {
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) throw new Error(`Bot ${botId} not found`);
  const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));
  if (!session?.yatriCookie) throw new Error(`Bot ${botId} no session`);
  return {
    bot,
    client: new VisaClient(
      { cookie: decrypt(session.yatriCookie), csrfToken: session.csrfToken, authenticityToken: session.authenticityToken },
      { scheduleId: bot.scheduleId, applicantIds: bot.applicantIds, consularFacilityId: bot.consularFacilityId, ascFacilityId: bot.ascFacilityId, proxyProvider: 'direct', locale: bot.locale },
    ),
  };
}

async function main() {
  console.log('=== Parallel Capacity Model Test ===\n');

  const { bot: botA, client: clientA } = await loadClient(BOT_A_ID);
  const { bot: botB, client: clientB } = await loadClient(BOT_B_ID);

  console.log(`Bot ${BOT_A_ID}: ${botA.applicantIds.length} applicants, schedule=${botA.scheduleId}`);
  console.log(`Bot ${BOT_B_ID}: ${botB.applicantIds.length} applicants, schedule=${botB.scheduleId}\n`);

  for (let iter = 1; iter <= ITERATIONS; iter++) {
    console.log(`\n════════ Iteration ${iter}/${ITERATIONS} ════════`);

    // ── 1. Consular days: PARALLEL ──
    const [daysA, daysB] = await parallelFetch(
      () => clientA.getConsularDays(),
      () => clientB.getConsularDays(),
    );

    const datesA = new Set(daysA.map(d => d.date));
    const datesB = new Set(daysB.map(d => d.date));
    const shared = [...datesA].filter(d => datesB.has(d));
    const onlyA = [...datesA].filter(d => !datesB.has(d));
    const onlyB = [...datesB].filter(d => !datesA.has(d));

    console.log(`\nCONSULAR DAYS (parallel fetch):`);
    console.log(`  2p: ${daysA.length} dates (first: ${daysA[0]?.date})`);
    console.log(`  4p: ${daysB.length} dates (first: ${daysB[0]?.date})`);
    console.log(`  Shared: ${shared.length} | Only 2p: ${onlyA.length} | Only 4p: ${onlyB.length}`);
    if (onlyA.length > 0) console.log(`  Only 2p: ${onlyA.join(', ')}`);
    if (onlyB.length > 0) console.log(`  Only 4p: ${onlyB.join(', ')}`);

    // ── 2. Consular times for 8 shared dates: PARALLEL per date ──
    console.log(`\nCONSULAR TIMES (parallel per date):`);
    const datesToCheck = shared.slice(0, 8);
    let totalA = 0, totalB = 0, subsetOk = 0, subsetFail = 0;

    for (const date of datesToCheck) {
      const [tA, tB] = await parallelFetch(
        () => clientA.getConsularTimes(date),
        () => clientB.getConsularTimes(date),
      );
      totalA += tA.available_times.length;
      totalB += tB.available_times.length;

      const setA = new Set(tA.available_times);
      const setB = new Set(tB.available_times);
      const lost = tA.available_times.filter((t: string) => !setB.has(t));
      const onlyInB = tB.available_times.filter((t: string) => !setA.has(t));

      // Check subset: every 4p time should be in 2p
      for (const t of tB.available_times) {
        if (setA.has(t)) subsetOk++;
        else subsetFail++;
      }

      const label = lost.length === 0 && onlyInB.length === 0 ? '✅' : '❌';
      console.log(`  ${date}: 2p=${tA.available_times.length} 4p=${tB.available_times.length} lost=${lost.length} onlyIn4p=${onlyInB.length} ${label}`);
      if (lost.length > 0 && lost.length <= 6) console.log(`    Only 2p: ${lost.join(', ')}`);
      if (onlyInB.length > 0) console.log(`    Only 4p: ${onlyInB.join(', ')}`);

      await sleep(300); // small delay between dates to not hammer the server
    }

    console.log(`\n  Totals (${datesToCheck.length} dates): 2p=${totalA} times, 4p=${totalB} times, loss=${totalA - totalB} (${((totalA - totalB) / totalA * 100).toFixed(1)}%)`);
    console.log(`  Subset check (4p ⊆ 2p): ${subsetOk} OK, ${subsetFail} violations`);

    // ── 3. CAS days: PARALLEL ──
    // Find a shared consular date+time first
    let casConsularDate: string | null = null;
    let casConsularTime: string | null = null;

    for (const date of shared.slice(2, 6)) {
      const [tA, tB] = await parallelFetch(
        () => clientA.getConsularTimes(date),
        () => clientB.getConsularTimes(date),
      );
      const commonTimes = tA.available_times.filter((t: string) => tB.available_times.includes(t));
      if (commonTimes.length > 0) {
        casConsularDate = date;
        casConsularTime = commonTimes[0];
        break;
      }
      await sleep(300);
    }

    if (casConsularDate && casConsularTime) {
      console.log(`\nCAS DAYS (parallel, consular=${casConsularDate} ${casConsularTime}):`);
      const [casA, casB] = await parallelFetch(
        () => clientA.getCasDays(casConsularDate!, casConsularTime!),
        () => clientB.getCasDays(casConsularDate!, casConsularTime!),
      );

      const casDatesA = new Set(casA.map(d => d.date));
      const casDatesB = new Set(casB.map(d => d.date));
      const casShared = [...casDatesA].filter(d => casDatesB.has(d));
      const casOnlyA = [...casDatesA].filter(d => !casDatesB.has(d));
      const casOnlyB = [...casDatesB].filter(d => !casDatesA.has(d));

      console.log(`  2p: ${casA.length} dates | 4p: ${casB.length} dates`);
      console.log(`  Shared: ${casShared.length} | Only 2p: ${casOnlyA.length} | Only 4p: ${casOnlyB.length}`);
      if (casOnlyA.length > 0) console.log(`  Only 2p: ${casOnlyA.join(', ')}`);
      if (casOnlyB.length > 0) console.log(`  Only 4p: ${casOnlyB.join(', ')}`);

      // CAS times for first 3 shared CAS dates
      if (casShared.length > 0) {
        console.log(`\nCAS TIMES (parallel):`);
        for (const casDate of casShared.slice(0, 3)) {
          const [ctA, ctB] = await parallelFetch(
            () => clientA.getCasTimes(casDate),
            () => clientB.getCasTimes(casDate),
          );
          const casSetA = new Set(ctA.available_times);
          const casSetB = new Set(ctB.available_times);
          const casLost = ctA.available_times.filter((t: string) => !casSetB.has(t));
          const casOnlyInB = ctB.available_times.filter((t: string) => !casSetA.has(t));
          const label = casLost.length === 0 && casOnlyInB.length === 0 ? '✅' : '❌';
          console.log(`  ${casDate}: 2p=${ctA.available_times.length} 4p=${ctB.available_times.length} lost=${casLost.length} onlyIn4p=${casOnlyInB.length} ${label}`);
          await sleep(300);
        }
      }
    }

    // ── 4. Model B (sequential 15min) strong test ──
    console.log(`\nMODEL B TEST (sequential 15min, parallel fetch):`);
    let strongTotal = 0, strongOk = 0, strongFail = 0;

    for (const date of datesToCheck) {
      const [tA, tB] = await parallelFetch(
        () => clientA.getConsularTimes(date),
        () => clientB.getConsularTimes(date),
      );
      const setA = new Set(tA.available_times);

      for (const t4 of tB.available_times) {
        // If sequential: 4p@T uses T,T+15,T+30,T+45 → T+15 should be free for 2p
        const [h, m] = t4.split(':').map(Number);
        const next = `${String(Math.floor((h! * 60 + m! + 15) / 60)).padStart(2, '0')}:${String((h! * 60 + m! + 15) % 60).padStart(2, '0')}`;
        strongTotal++;
        if (setA.has(next)) strongOk++;
        else strongFail++;
      }
      await sleep(300);
    }
    console.log(`  4p@T → 2p has T+15? ${strongOk}/${strongTotal} OK, ${strongFail} failures (${(strongFail / strongTotal * 100).toFixed(1)}%)`);

    if (iter < ITERATIONS) {
      console.log(`\nWaiting 5s...`);
      await sleep(5000);
    }
  }

  console.log('\n\n=== CONCLUSION ===');
  console.log('If results are consistent across iterations (same onlyA dates, same subset check):');
  console.log('→ Differences are schedule/group-size dependent, NOT timing artifacts.');
  console.log('→ Model is PARALLEL (windows), not sequential (minutes per person).');

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

/**
 * Analyze capacity model: compare ALL times between bot 6 (2 applicants) and bot 12 (4 applicants)
 * to infer how many time slots each applicant "costs".
 *
 * Usage: npx tsx --env-file=.env scripts/capacity-analysis.ts
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { VisaClient } from '../src/services/visa-client.js';

const BOT_A_ID = 6;   // 2 applicants
const BOT_B_ID = 12;  // 4 applicants

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function loadClient(botId: number) {
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) throw new Error(`Bot ${botId} not found`);
  const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));
  if (!session?.yatriCookie) throw new Error(`Bot ${botId} has no session`);
  return {
    bot,
    client: new VisaClient(
      { cookie: decrypt(session.yatriCookie), csrfToken: session.csrfToken, authenticityToken: session.authenticityToken },
      { scheduleId: bot.scheduleId, applicantIds: bot.applicantIds, consularFacilityId: bot.consularFacilityId, ascFacilityId: bot.ascFacilityId, proxyProvider: 'direct', locale: bot.locale },
    ),
  };
}

async function main() {
  console.log('=== Capacity Analysis: 2 vs 4 applicants ===\n');

  const { bot: botA, client: clientA } = await loadClient(BOT_A_ID);
  const { bot: botB, client: clientB } = await loadClient(BOT_B_ID);

  console.log(`Bot ${BOT_A_ID}: ${botA.applicantIds.length} applicants, schedule=${botA.scheduleId}`);
  console.log(`Bot ${BOT_B_ID}: ${botB.applicantIds.length} applicants, schedule=${botB.scheduleId}\n`);

  // Fetch days
  const daysA = await clientA.getConsularDays();
  await sleep(500);
  const daysB = await clientB.getConsularDays();

  const datesA = new Set(daysA.map(d => d.date));
  const datesB = new Set(daysB.map(d => d.date));
  const shared = [...datesA].filter(d => datesB.has(d));
  const onlyA = [...datesA].filter(d => !datesB.has(d));

  console.log(`Days: A=${daysA.length}, B=${daysB.length}, shared=${shared.length}, onlyA=${onlyA.length}\n`);

  // Sample dates: first 15 shared + all only-A dates
  const datesToCheck = [...shared.slice(0, 15), ...onlyA];

  console.log('--- Per-date time comparison ---');
  console.log('Date        | A(2p) | B(4p) | Lost | A-only times');
  console.log('------------|-------|-------|------|-------------');

  const stats: { date: string; timesA: string[]; timesB: string[]; lost: string[] }[] = [];

  for (const date of datesToCheck) {
    try {
      const tA = await clientA.getConsularTimes(date);
      await sleep(400);
      const tB = datesB.has(date) ? await clientB.getConsularTimes(date) : { available_times: [] as string[] };
      await sleep(400);

      const setB = new Set(tB.available_times);
      const lost = tA.available_times.filter((t: string) => !setB.has(t));
      const isOnlyA = onlyA.includes(date) ? ' [ONLY-A]' : '';

      stats.push({ date, timesA: tA.available_times, timesB: tB.available_times, lost });
      console.log(`${date} | ${String(tA.available_times.length).padStart(5)} | ${String(tB.available_times.length).padStart(5)} | ${String(lost.length).padStart(4)} | ${lost.join(', ')}${isOnlyA}`);
    } catch (e: any) {
      console.log(`${date} | ERROR: ${e.message}`);
      await sleep(1000);
    }
  }

  // Analysis
  console.log('\n--- Analysis ---');
  const datesWithDiff = stats.filter(s => s.lost.length > 0);
  const datesWithSame = stats.filter(s => s.lost.length === 0 && s.timesB.length > 0);

  console.log(`Dates checked: ${stats.length}`);
  console.log(`Identical times: ${datesWithSame.length}`);
  console.log(`Dates with lost times: ${datesWithDiff.length}`);
  console.log(`Dates with 0 times for B: ${stats.filter(s => s.timesB.length === 0).length}`);

  if (datesWithDiff.length > 0) {
    console.log('\n--- Lost time analysis ---');
    // For each date with differences, analyze WHERE in the day times are lost
    // If each person needs N minutes, a time slot with capacity < 4*N won't show for bot B
    // Look at the pattern of which times are lost

    // Calculate: for dates where bot A has N times and bot B has M, what's the ratio?
    console.log('\nTimes ratio (B/A) for dates with differences:');
    for (const s of datesWithDiff) {
      const ratio = s.timesB.length / s.timesA.length;
      console.log(`  ${s.date}: A=${s.timesA.length} B=${s.timesB.length} ratio=${ratio.toFixed(2)} lost=${s.lost.length} (${s.lost.join(', ')})`);
    }

    // Look at which specific times are most often lost
    const lostTimeFreq = new Map<string, number>();
    for (const s of datesWithDiff) {
      for (const t of s.lost) {
        lostTimeFreq.set(t, (lostTimeFreq.get(t) || 0) + 1);
      }
    }
    console.log('\nMost frequently lost times:');
    [...lostTimeFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([t, c]) => console.log(`  ${t}: lost on ${c}/${datesWithDiff.length} dates`));

    // For the "only A" dates: how many times does A have?
    const onlyAStats = stats.filter(s => onlyA.includes(s.date));
    if (onlyAStats.length > 0) {
      console.log('\n--- Dates only visible to A (2 applicants) ---');
      console.log('These dates have so few slots that 4 applicants cannot fit at all:');
      for (const s of onlyAStats) {
        console.log(`  ${s.date}: A has ${s.timesA.length} times: ${s.timesA.join(', ')}`);
      }
    }
  }

  // Inference: can we estimate capacity per slot?
  console.log('\n--- Capacity inference ---');
  console.log('Assumption: each time slot has fixed capacity C (number of interview slots).');
  console.log('A date appears if >= 1 time slot has capacity >= N_applicants.');
  console.log('A time appears if its remaining capacity >= N_applicants.');
  console.log('');

  // For only-A dates: A sees 2 times, B sees 0
  // This means those times have capacity >= 2 but < 4
  // So each slot: 2 <= remaining_capacity < 4
  // Each interview needs: capacity / applicants... but we need to know total capacity

  // For Nov 17: A=[07:30, 08:15], B=[07:30]
  // 08:15 has capacity >= 2 but < 4 → remaining is 2 or 3
  // 07:30 has capacity >= 4

  // Standard consular interview: 15 min per person?
  // If so: 2 people = 30 min, 4 people = 60 min
  // A slot might be a 15-min window. Capacity = 1 interview group per slot.
  // Then the question is: can a 4-person group fit in a single 15-min slot?
  // More likely: each person gets their own slot, so 4 people need 4 consecutive slots.

  console.log('From the data:');
  console.log('- Dates only in A: bot A (2p) sees 2 times, bot B (4p) sees 0');
  console.log('  → Those times have remaining capacity for 2 but not 4 people');
  console.log('- Nov 17: A=2 times, B=1 time. Lost: 08:15');
  console.log('  → 08:15 has capacity ≥2 but <4');
  console.log('  → 07:30 has capacity ≥4');
  console.log('');
  console.log('If slots are individual (1 person per slot, e.g. 15-min each):');
  console.log('  2 applicants need 2 slots, 4 need 4 slots');
  console.log('  A "time" shows if enough CONSECUTIVE slots exist from that start time');
  console.log('  → For 12 people: need 12 consecutive slots = ~3 hours');
  console.log('  → Much fewer times/dates would be available');
  console.log('');
  console.log('If slots are per-group (1 group per slot regardless of size):');
  console.log('  Each slot has fixed max group size');
  console.log('  → For 12 people: only slots with capacity ≥12 would show');
  console.log('  → Even fewer options than 4 people');

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

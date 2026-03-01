/**
 * Compare CAS availability between bot 6 (2 applicants) and bot 12 (4 applicants).
 * Also compute per-person loss rate for consular to extrapolate to 12 people.
 *
 * Usage: npx tsx --env-file=.env scripts/capacity-analysis-cas.ts
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
  console.log('=== Capacity Analysis: Consular + CAS (2p vs 4p) ===\n');

  const { bot: botA, client: clientA } = await loadClient(BOT_A_ID);
  const { bot: botB, client: clientB } = await loadClient(BOT_B_ID);

  console.log(`Bot ${BOT_A_ID}: ${botA.applicantIds.length} applicants`);
  console.log(`Bot ${BOT_B_ID}: ${botB.applicantIds.length} applicants\n`);

  // ── 1. Consular days comparison (full) ──
  console.log('━━━ CONSULAR DAYS ━━━');
  const daysA = await clientA.getConsularDays();
  await sleep(500);
  const daysB = await clientB.getConsularDays();

  const datesA = new Set(daysA.map(d => d.date));
  const datesB = new Set(daysB.map(d => d.date));
  const shared = [...datesA].filter(d => datesB.has(d));
  const onlyA = [...datesA].filter(d => !datesB.has(d));
  const onlyB = [...datesB].filter(d => !datesA.has(d));

  console.log(`Bot 6 (2p): ${daysA.length} dates`);
  console.log(`Bot 12 (4p): ${daysB.length} dates`);
  console.log(`Shared: ${shared.length} | Only 2p: ${onlyA.length} | Only 4p: ${onlyB.length}`);
  if (onlyA.length > 0) console.log(`  Only 2p: ${onlyA.join(', ')}`);
  if (onlyB.length > 0) console.log(`  Only 4p: ${onlyB.join(', ')}`);

  // Per-person loss rate
  const dateLoss = daysA.length - daysB.length;
  const extraPeople = botB.applicantIds.length - botA.applicantIds.length; // 2
  const lossPerPerson = dateLoss / extraPeople;
  console.log(`\nDate loss: ${dateLoss} dates for +${extraPeople} people = ${lossPerPerson.toFixed(1)} dates/person`);
  console.log(`Extrapolation to 12p: ~${daysA.length} - ${(lossPerPerson * (12 - botA.applicantIds.length)).toFixed(0)} = ~${Math.round(daysA.length - lossPerPerson * (12 - botA.applicantIds.length))} dates (linear, likely optimistic)`);

  // ── 2. Consular times comparison (sample 10 shared dates) ──
  console.log('\n━━━ CONSULAR TIMES (10 shared dates) ━━━');
  let totalTimesA = 0, totalTimesB = 0;
  for (const date of shared.slice(0, 10)) {
    const tA = await clientA.getConsularTimes(date);
    await sleep(400);
    const tB = await clientB.getConsularTimes(date);
    await sleep(400);
    totalTimesA += tA.available_times.length;
    totalTimesB += tB.available_times.length;
    const diff = tA.available_times.length - tB.available_times.length;
    console.log(`  ${date}: 2p=${tA.available_times.length} 4p=${tB.available_times.length} lost=${diff}`);
  }
  const timeLossRate = (totalTimesA - totalTimesB) / totalTimesA * 100;
  const timeLossPerPerson = (totalTimesA - totalTimesB) / extraPeople;
  console.log(`\nTotal: 2p=${totalTimesA} times, 4p=${totalTimesB} times`);
  console.log(`Loss: ${totalTimesA - totalTimesB} times (${timeLossRate.toFixed(1)}%) for +${extraPeople} people`);
  console.log(`Per person: ~${timeLossPerPerson.toFixed(1)} fewer times per +1 person (over 10 dates)`);
  const est12 = totalTimesA - timeLossPerPerson * (12 - botA.applicantIds.length);
  console.log(`Extrapolation to 12p: ~${Math.max(0, Math.round(est12))} times (over same 10 dates, from ${totalTimesA})`);

  // ── 3. CAS days comparison ──
  // Pick a shared consular date+time that both bots can access
  console.log('\n━━━ CAS DAYS ━━━');

  // Find a shared date with shared times
  let sharedConsularDate: string | null = null;
  let sharedConsularTime: string | null = null;

  for (const date of shared.slice(0, 5)) {
    const tA = await clientA.getConsularTimes(date);
    await sleep(400);
    const tB = await clientB.getConsularTimes(date);
    await sleep(400);

    const setB = new Set(tB.available_times);
    const common = tA.available_times.filter((t: string) => setB.has(t));
    if (common.length > 0) {
      sharedConsularDate = date;
      sharedConsularTime = common[0];
      break;
    }
  }

  if (!sharedConsularDate || !sharedConsularTime) {
    console.log('No shared consular date+time found for CAS comparison');
    process.exit(0);
  }

  console.log(`Using consular: ${sharedConsularDate} ${sharedConsularTime}\n`);

  // Fetch CAS days for both
  const casDaysA = await clientA.getCasDays(sharedConsularDate, sharedConsularTime);
  await sleep(500);
  const casDaysB = await clientB.getCasDays(sharedConsularDate, sharedConsularTime);

  const casDatesA = new Set(casDaysA.map(d => d.date));
  const casDatesB = new Set(casDaysB.map(d => d.date));
  const casShared = [...casDatesA].filter(d => casDatesB.has(d));
  const casOnlyA = [...casDatesA].filter(d => !casDatesB.has(d));
  const casOnlyB = [...casDatesB].filter(d => !casDatesA.has(d));

  console.log(`CAS days for 2p: ${casDaysA.length} dates (${casDaysA.map(d => d.date).join(', ')})`);
  console.log(`CAS days for 4p: ${casDaysB.length} dates (${casDaysB.map(d => d.date).join(', ')})`);
  console.log(`Shared: ${casShared.length} | Only 2p: ${casOnlyA.length} | Only 4p: ${casOnlyB.length}`);
  if (casOnlyA.length > 0) console.log(`  Only 2p: ${casOnlyA.join(', ')}`);
  if (casOnlyB.length > 0) console.log(`  Only 4p: ${casOnlyB.join(', ')}`);

  // CAS times for first 3 shared CAS dates
  if (casShared.length > 0) {
    console.log('\n━━━ CAS TIMES ━━━');
    for (const casDate of casShared.slice(0, 3)) {
      const ctA = await clientA.getCasTimes(casDate);
      await sleep(400);
      const ctB = await clientB.getCasTimes(casDate);
      await sleep(400);

      const casSetB = new Set(ctB.available_times);
      const casLost = ctA.available_times.filter((t: string) => !casSetB.has(t));
      const same = casLost.length === 0 && ctA.available_times.length === ctB.available_times.length;
      console.log(`  ${casDate}: 2p=${ctA.available_times.length} 4p=${ctB.available_times.length} lost=${casLost.length} ${same ? '✅' : '❌'}`);
      if (casLost.length > 0) console.log(`    Lost: ${casLost.join(', ')}`);
    }
  }

  // Also try a second consular date+time for CAS comparison
  console.log('\n━━━ CAS DAYS (second consular date) ━━━');
  let secondDate: string | null = null;
  let secondTime: string | null = null;
  for (const date of shared.slice(5, 10)) {
    const tA = await clientA.getConsularTimes(date);
    await sleep(400);
    const tB = await clientB.getConsularTimes(date);
    await sleep(400);
    const setB = new Set(tB.available_times);
    const common = tA.available_times.filter((t: string) => setB.has(t));
    if (common.length > 0) {
      secondDate = date;
      secondTime = common[0];
      break;
    }
  }

  if (secondDate && secondTime) {
    console.log(`Using consular: ${secondDate} ${secondTime}\n`);
    const cas2A = await clientA.getCasDays(secondDate, secondTime);
    await sleep(500);
    const cas2B = await clientB.getCasDays(secondDate, secondTime);

    const cas2DatesA = new Set(cas2A.map(d => d.date));
    const cas2DatesB = new Set(cas2B.map(d => d.date));
    const cas2Shared = [...cas2DatesA].filter(d => cas2DatesB.has(d));
    const cas2OnlyA = [...cas2DatesA].filter(d => !cas2DatesB.has(d));

    console.log(`CAS days for 2p: ${cas2A.length}`);
    console.log(`CAS days for 4p: ${cas2B.length}`);
    console.log(`Shared: ${cas2Shared.length} | Only 2p: ${cas2OnlyA.length}`);
    if (cas2OnlyA.length > 0) console.log(`  Only 2p: ${cas2OnlyA.join(', ')}`);
  }

  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

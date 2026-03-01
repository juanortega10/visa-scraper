/**
 * Compare consular days/times between two bots (different schedules, same facility).
 * Runs N iterations to check consistency.
 *
 * Usage: npx tsx --env-file=.env scripts/compare-schedules.ts
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { VisaClient } from '../src/services/visa-client.js';
import { performLogin } from '../src/services/login.js';

const BOT_A_ID = 6;
const BOT_B_ID = 12;
const ITERATIONS = 3;
const DELAY_MS = 3000;

async function loadBot(botId: number) {
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) throw new Error(`Bot ${botId} not found`);
  const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));
  return { bot, session };
}

async function ensureSession(botId: number, bot: any, session: any) {
  if (session?.yatriCookie) {
    const age = Date.now() - new Date(session.createdAt).getTime();
    if (age < 40 * 60 * 1000) {
      console.log(`  Bot ${botId}: existing session (${Math.round(age / 60000)}min old)`);
      return {
        cookie: decrypt(session.yatriCookie),
        csrfToken: session.csrfToken,
        authenticityToken: session.authenticityToken,
      };
    }
  }
  console.log(`  Bot ${botId}: logging in...`);
  const result = await performLogin({
    email: decrypt(bot.visaEmail),
    password: decrypt(bot.visaPassword),
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    locale: bot.locale,
  });
  console.log(`  Bot ${botId}: login OK`);
  return result;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('=== Compare schedules: Bot 6 vs Bot 12 ===\n');

  const dataA = await loadBot(BOT_A_ID);
  const dataB = await loadBot(BOT_B_ID);

  console.log(`Bot ${BOT_A_ID}: schedule=${dataA.bot.scheduleId}, facility=${dataA.bot.consularFacilityId}, applicants=${dataA.bot.applicantIds.length}`);
  console.log(`Bot ${BOT_B_ID}: schedule=${dataB.bot.scheduleId}, facility=${dataB.bot.consularFacilityId}, applicants=${dataB.bot.applicantIds.length}\n`);

  const sessA = await ensureSession(BOT_A_ID, dataA.bot, dataA.session);
  const sessB = await ensureSession(BOT_B_ID, dataB.bot, dataB.session);

  const clientA = new VisaClient(
    { cookie: sessA.cookie, csrfToken: sessA.csrfToken, authenticityToken: sessA.authenticityToken },
    { scheduleId: dataA.bot.scheduleId, applicantIds: dataA.bot.applicantIds, consularFacilityId: dataA.bot.consularFacilityId, ascFacilityId: dataA.bot.ascFacilityId, proxyProvider: 'direct', locale: dataA.bot.locale },
  );
  const clientB = new VisaClient(
    { cookie: sessB.cookie, csrfToken: sessB.csrfToken, authenticityToken: sessB.authenticityToken },
    { scheduleId: dataB.bot.scheduleId, applicantIds: dataB.bot.applicantIds, consularFacilityId: dataB.bot.consularFacilityId, ascFacilityId: dataB.bot.ascFacilityId, proxyProvider: 'direct', locale: dataB.bot.locale },
  );

  for (let i = 1; i <= ITERATIONS; i++) {
    console.log(`\n======== Iteration ${i}/${ITERATIONS} ========`);

    // Fetch days sequentially to avoid socket issues
    const daysA = await clientA.getConsularDays();
    const daysB = await clientB.getConsularDays();

    const datesA = new Set(daysA.map(d => d.date));
    const datesB = new Set(daysB.map(d => d.date));

    const onlyA = [...datesA].filter(d => !datesB.has(d));
    const onlyB = [...datesB].filter(d => !datesA.has(d));
    const both = [...datesA].filter(d => datesB.has(d));

    console.log(`Bot ${BOT_A_ID}: ${daysA.length} dates | first=${daysA[0]?.date} last=${daysA[daysA.length - 1]?.date}`);
    console.log(`Bot ${BOT_B_ID}: ${daysB.length} dates | first=${daysB[0]?.date} last=${daysB[daysB.length - 1]?.date}`);
    console.log(`Shared: ${both.length} | Only A: ${onlyA.length} | Only B: ${onlyB.length}`);
    if (onlyA.length > 0) console.log(`  Only A: ${onlyA.join(', ')}`);
    if (onlyB.length > 0) console.log(`  Only B: ${onlyB.join(', ')}`);

    // Check times for first 2 shared dates + any only-A dates
    const timesCheck = [...both.slice(0, 2), ...onlyA.slice(0, 2)];
    for (const date of timesCheck) {
      try {
        const tA = await clientA.getConsularTimes(date);
        await sleep(500);
        const tB = await clientB.getConsularTimes(date);
        const inA = onlyA.includes(date) ? ' [ONLY-A]' : '';
        const same = JSON.stringify(tA.available_times) === JSON.stringify(tB.available_times);
        console.log(`  ${date}${inA}: A=${tA.available_times.length} B=${tB.available_times.length} ${same ? '✅ SAME' : '❌ DIFF'}`);
        if (!same && tA.available_times.length <= 5 && tB.available_times.length <= 5) {
          console.log(`    A: ${tA.available_times.join(', ')}`);
          console.log(`    B: ${tB.available_times.join(', ')}`);
        }
        await sleep(500);
      } catch (e: any) {
        console.log(`  ${date}: ERROR — ${e.message}`);
      }
    }

    if (i < ITERATIONS) {
      console.log(`\nWaiting ${DELAY_MS / 1000}s...`);
      await sleep(DELAY_MS);
    }
  }

  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

/**
 * Bot 141 — Exact-time alignment with bot 140.
 *
 * Same-date move (2026-05-20). Currently bot 141 holds 11:30; target is
 * the exact time of bot 140 (11:15). Strictly-earlier guard is omitted
 * — atomic POST keeps 11:30 if it fails. MAX_GAP_MINUTES=0 means only
 * an exact match commits.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/_bot141-exact-sniper.ts            # dry-run
 *   npx tsx --env-file=.env scripts/_bot141-exact-sniper.ts --commit   # real POST
 */
import { db } from '../src/db/client.js';
import { bots, sessions, excludedDates, excludedTimes, pollLogs, rescheduleLogs } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '../src/services/encryption.js';
import { VisaClient, SessionExpiredError } from '../src/services/visa-client.js';
import { filterDates, filterTimes, addDays } from '../src/utils/date-helpers.js';
import { MIN_DAYS_FROM_TODAY } from '../src/utils/constants.js';
import { performLogin } from '../src/services/login.js';
import type { ProxyProvider } from '../src/services/proxy-fetch.js';

const BOT_ID = 141;
const ANCHOR_BOT_ID = 140;
const TARGET_DATE = '2026-05-20';
const MAX_GAP_MINUTES = 0;             // exact match only
const POLL_INTERVAL_MS = 30_000;

const args = process.argv.slice(2);
const commit = args.includes('--commit');

const bogota = (d = new Date()) =>
  new Date(d.getTime() - 5 * 3600_000).toISOString().slice(11, 19);

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

// Explicit projection — avoids reading columns that exist in schema.ts but not yet in production DB (e.g., agency_id).
const botCols = {
  id: bots.id,
  visaEmail: bots.visaEmail,
  visaPassword: bots.visaPassword,
  scheduleId: bots.scheduleId,
  applicantIds: bots.applicantIds,
  consularFacilityId: bots.consularFacilityId,
  ascFacilityId: bots.ascFacilityId,
  currentConsularDate: bots.currentConsularDate,
  currentConsularTime: bots.currentConsularTime,
  currentCasDate: bots.currentCasDate,
  currentCasTime: bots.currentCasTime,
  proxyProvider: bots.proxyProvider,
  userId: bots.userId,
  locale: bots.locale,
  minDaysFromToday: bots.minDaysFromToday,
  rescheduleCount: bots.rescheduleCount,
};

const [bot] = await db.select(botCols).from(bots).where(eq(bots.id, BOT_ID));
if (!bot) { console.error(`Bot ${BOT_ID} not found`); process.exit(1); }
const [anchor] = await db.select({ currentConsularTime: bots.currentConsularTime }).from(bots).where(eq(bots.id, ANCHOR_BOT_ID));
if (!anchor || !anchor.currentConsularTime) {
  console.error(`Anchor bot ${ANCHOR_BOT_ID} has no consular time`); process.exit(1);
}
const ANCHOR_TIME = anchor.currentConsularTime;
const ANCHOR_MIN = toMin(ANCHOR_TIME);

console.log('\n=== Bot 141 — EXACT-time alignment sniper ===');
console.log(`Mode:     ${commit ? 'COMMIT (real reschedule)' : 'DRY-RUN (no POST)'}`);
console.log(`Interval: ${POLL_INTERVAL_MS / 1000}s (${60_000 / POLL_INTERVAL_MS} polls/min)`);
console.log(`Target:   ${TARGET_DATE} at EXACTLY ${ANCHOR_TIME} (bot ${ANCHOR_BOT_ID} time)`);

const [session] = await db.select().from(sessions).where(eq(sessions.botId, BOT_ID));
if (!session) { console.error(`No session for bot ${BOT_ID}`); process.exit(1); }

const exDates = await db.select().from(excludedDates).where(eq(excludedDates.botId, BOT_ID));
const dateExclusions = exDates.map(d => ({ startDate: d.startDate, endDate: d.endDate }));
const exTimes = await db.select().from(excludedTimes).where(eq(excludedTimes.botId, BOT_ID));
const timeExclusions = exTimes.map(t => ({ date: t.date, timeStart: t.timeStart, timeEnd: t.timeEnd }));

console.log(`Current:  ${bot.currentConsularDate} ${bot.currentConsularTime ?? ''} (CAS ${bot.currentCasDate} ${bot.currentCasTime ?? ''})`);
console.log(`Schedule: ${bot.scheduleId} | locale ${bot.locale} | proxy ${bot.proxyProvider}`);
console.log(`Excluded: ${exDates.length} dates, ${exTimes.length} time windows\n`);

if (bot.currentConsularTime === ANCHOR_TIME && bot.currentConsularDate === TARGET_DATE) {
  console.log('Bot 141 is already at the target time. Nothing to do.');
  process.exit(0);
}

const visaConfig = {
  scheduleId: bot.scheduleId,
  applicantIds: bot.applicantIds,
  consularFacilityId: bot.consularFacilityId,
  ascFacilityId: bot.ascFacilityId,
  proxyProvider: (bot.proxyProvider ?? 'direct') as ProxyProvider,
  userId: bot.userId,
  locale: bot.locale,
};

let client = new VisaClient(
  {
    cookie: decrypt(session.yatriCookie),
    csrfToken: session.csrfToken ?? '',
    authenticityToken: session.authenticityToken ?? '',
  },
  visaConfig,
);

async function reLogin(): Promise<void> {
  console.log(`[${bogota()}] Re-logging in...`);
  const result = await performLogin({
    email: decrypt(bot.visaEmail),
    password: decrypt(bot.visaPassword),
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    locale: bot.locale,
  });
  await db.update(sessions).set({
    yatriCookie: encrypt(result.cookie),
    csrfToken: result.csrfToken,
    authenticityToken: result.authenticityToken,
    updatedAt: new Date(),
  }).where(eq(sessions.botId, BOT_ID));
  client = new VisaClient(
    { cookie: result.cookie, csrfToken: result.csrfToken, authenticityToken: result.authenticityToken },
    visaConfig,
  );
  console.log(`[${bogota()}] ✓ Re-login OK`);
}

let pollCount = 0;
let lastReloginMs = Date.now();

while (true) {
  pollCount++;
  const iterStart = Date.now();
  const minDate = addDays(
    new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Bogota' }),
    bot.minDaysFromToday ?? MIN_DAYS_FROM_TODAY,
  );

  if (commit && Date.now() - lastReloginMs > 44 * 60_000) {
    try { await reLogin(); lastReloginMs = Date.now(); }
    catch (err) { console.log(`[${bogota()}] re-login failed: ${err instanceof Error ? err.message : err}`); }
  }

  try {
    const allDays = await client.getConsularDays();
    const filtered = filterDates(allDays, dateExclusions, undefined, minDate);
    const targetDay = filtered.find(d => d.date === TARGET_DATE);
    const fetchMs = Date.now() - iterStart;
    const earliest = filtered[0]?.date ?? 'none';

    await db.insert(pollLogs).values({
      botId: BOT_ID,
      status: targetDay ? 'ok' : 'filtered_out',
      earliestDate: filtered[0]?.date ?? null,
      datesCount: filtered.length,
      rawDatesCount: allDays.length,
      responseTimeMs: fetchMs,
      topDates: filtered.slice(0, 10).map(d => d.date),
      provider: bot.proxyProvider,
      pollPhase: 'manual_sniper_exact',
      chainId: 'dev',
      fetchIndex: pollCount,
      allDates: allDays.map(d => ({ date: d.date, business_day: d.business_day })),
    }).catch((e) => console.log(`[${bogota()}]   pollLogs insert failed: ${e instanceof Error ? e.message : e}`));

    if (!targetDay) {
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | total=${allDays.length} earliest=${earliest} | no ${TARGET_DATE}`);
    } else {
      const timesData = await client.getConsularTimes(TARGET_DATE);
      const allTimes = filterTimes(TARGET_DATE, timesData.available_times, timeExclusions);
      const candidates = allTimes.filter(t => Math.abs(toMin(t) - ANCHOR_MIN) <= MAX_GAP_MINUTES);
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | 🎯 ${TARGET_DATE} times=[${allTimes.join(', ') || '(none)'}] | exact-${ANCHOR_TIME}=[${candidates.join(', ') || '(none)'}]`);

      if (candidates.length === 0) {
        // no exact match yet
      } else {
        let scheduled = false;
        for (const cTime of candidates) {
          const casDays = await client.getCasDays(TARGET_DATE, cTime);
          const filteredCas = filterDates(casDays, dateExclusions, undefined, minDate);
          if (filteredCas.length === 0) {
            console.log(`[${bogota()}]   ${cTime} → no CAS days, next`);
            continue;
          }
          const casDate = filteredCas[0]!.date;
          const casTimesData = await client.getCasTimes(casDate, TARGET_DATE, cTime);
          const casTimes = filterTimes(casDate, casTimesData.available_times, timeExclusions);
          if (casTimes.length === 0) {
            console.log(`[${bogota()}]   ${cTime} → CAS ${casDate} has no times, next`);
            continue;
          }
          const casTime = casTimes[0]!;
          console.log(`[${bogota()}]   ✓ COMBO: consular ${TARGET_DATE} ${cTime} | CAS ${casDate} ${casTime}`);

          if (!commit) {
            console.log(`[${bogota()}]   DRY-RUN — would POST. Re-run with --commit.`);
            process.exit(0);
          }

          await client.refreshTokens();
          const ok = await client.reschedule(TARGET_DATE, cTime, casDate, casTime);
          if (ok) {
            console.log(`\n🎉 EXACT MATCH OK`);
            console.log(`  Old: ${bot.currentConsularDate} ${bot.currentConsularTime ?? ''}`);
            console.log(`  New: ${TARGET_DATE} ${cTime} | CAS ${casDate} ${casTime}`);
            console.log(`  Gap vs bot ${ANCHOR_BOT_ID} (${ANCHOR_TIME}): ${Math.abs(toMin(cTime) - ANCHOR_MIN)}min`);
            await db.update(bots).set({
              currentConsularDate: TARGET_DATE,
              currentConsularTime: cTime,
              currentCasDate: casDate,
              currentCasTime: casTime,
              rescheduleCount: (bot.rescheduleCount ?? 0) + 1,
              updatedAt: new Date(),
            }).where(eq(bots.id, BOT_ID));
            await db.insert(rescheduleLogs).values({
              botId: BOT_ID,
              oldConsularDate: bot.currentConsularDate,
              oldConsularTime: bot.currentConsularTime,
              oldCasDate: bot.currentCasDate,
              oldCasTime: bot.currentCasTime,
              newConsularDate: TARGET_DATE,
              newConsularTime: cTime,
              newCasDate: casDate,
              newCasTime: casTime,
              success: true,
              provider: bot.proxyProvider,
            }).catch((e) => console.log(`rescheduleLogs insert failed: ${e instanceof Error ? e.message : e}`));
            console.log('DB updated. Exiting.');
            scheduled = true;
            process.exit(0);
          }
          console.log(`[${bogota()}]   POST returned false for ${cTime}`);
        }
        if (!scheduled) {
          console.log(`[${bogota()}]   exact time available but CAS/POST failed, will keep polling`);
        }
      }
    }
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      console.log(`[${bogota()}] #${pollCount} | session expired — re-logging`);
      try { await reLogin(); lastReloginMs = Date.now(); }
      catch (e) { console.log(`[${bogota()}] re-login failed: ${e instanceof Error ? e.message : e}`); }
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[${bogota()}] #${pollCount} | ERROR: ${msg}`);
    }
  }

  const elapsed = Date.now() - iterStart;
  const sleep = Math.max(0, POLL_INTERVAL_MS - elapsed);
  if (sleep > 0) await new Promise(r => setTimeout(r, sleep));
}

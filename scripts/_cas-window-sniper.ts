/**
 * Generic CAS-window sniper. Parameterized by bot ID and CAS date window.
 *
 * Logic: poll consular days/times, for each consular slot fetch CAS days.
 * If any CAS day falls in [CAS_START, CAS_END], commit the reschedule.
 *
 * Strategy:
 *   - If current CAS NOT in window: secure ANY valid combo
 *   - If current CAS already in window: only POST if new consular date is EARLIER
 *
 * Run forever (24/7). User stops via pkill or kill PID.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/_cas-window-sniper.ts --bot-id=140 --cas-start=2026-05-19 --cas-end=2026-05-22 [--commit]
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

// ── CLI args ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const BOT_ID = parseInt(arg('bot-id') ?? '0', 10);
const CAS_START = arg('cas-start') ?? '';
const CAS_END   = arg('cas-end') ?? '';
const POLL_INTERVAL_MS = parseInt(arg('interval') ?? '30000', 10);
const commit = args.includes('--commit');

if (!BOT_ID || !CAS_START || !CAS_END) {
  console.error('Usage: --bot-id=N --cas-start=YYYY-MM-DD --cas-end=YYYY-MM-DD [--interval=ms] [--commit]');
  process.exit(1);
}

const bogota = (d = new Date()) =>
  new Date(d.getTime() - 5 * 3600_000).toISOString().slice(11, 19);

// Explicit projection — avoids agency_id schema/DB drift.
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

const [session] = await db.select().from(sessions).where(eq(sessions.botId, BOT_ID));
if (!session) { console.error(`No session for bot ${BOT_ID}`); process.exit(1); }

const exDates = await db.select().from(excludedDates).where(eq(excludedDates.botId, BOT_ID));
const dateExclusions = exDates.map(d => ({ startDate: d.startDate, endDate: d.endDate }));
const exTimes = await db.select().from(excludedTimes).where(eq(excludedTimes.botId, BOT_ID));
const timeExclusions = exTimes.map(t => ({ date: t.date, timeStart: t.timeStart, timeEnd: t.timeEnd }));

// In-memory state
let lastConsularDate = bot.currentConsularDate!;
let lastConsularTime = bot.currentConsularTime!;
let lastCasDate = bot.currentCasDate;
let lastCasTime = bot.currentCasTime;

const inCasWindow = (d: string | null) => !!d && d >= CAS_START && d <= CAS_END;

console.log(`\n=== Bot ${BOT_ID} — CAS-window sniper ===`);
console.log(`Mode:     ${commit ? 'COMMIT (real reschedule)' : 'DRY-RUN (no POST)'}`);
console.log(`Interval: ${POLL_INTERVAL_MS / 1000}s (${(60_000 / POLL_INTERVAL_MS).toFixed(1)} polls/min)`);
console.log(`Target:   ANY consular date + CAS ∈ [${CAS_START}, ${CAS_END}]`);
console.log(`Strategy: secure ANY valid combo first, then improve toward EARLIER consular`);
console.log(`Current:  consular ${lastConsularDate} ${lastConsularTime} | CAS ${lastCasDate} ${lastCasTime ?? ''}`);
console.log(`CAS in window already? ${inCasWindow(lastCasDate) ? 'YES (only improve mode)' : 'NO (secure mode)'}`);
console.log(`Schedule: ${bot.scheduleId} | locale ${bot.locale} | proxy ${bot.proxyProvider}\n`);

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
    const fetchMs = Date.now() - iterStart;

    await db.insert(pollLogs).values({
      botId: BOT_ID,
      status: filtered.length > 0 ? 'ok' : 'filtered_out',
      earliestDate: filtered[0]?.date ?? null,
      datesCount: filtered.length,
      rawDatesCount: allDays.length,
      responseTimeMs: fetchMs,
      topDates: filtered.slice(0, 10).map(d => d.date),
      provider: bot.proxyProvider,
      pollPhase: 'sniper_cas_window',
      chainId: 'dev',
      fetchIndex: pollCount,
      allDates: allDays.map(d => ({ date: d.date, business_day: d.business_day })),
    }).catch((e) => console.log(`[${bogota()}]   pollLogs insert failed: ${e instanceof Error ? e.message : e}`));

    const casAligned = inCasWindow(lastCasDate);
    const earliest = filtered[0]?.date ?? 'none';

    // Filter consular dates: if already aligned, only consider dates EARLIER than current
    const candidates = casAligned
      ? filtered.filter(d => d.date < lastConsularDate)
      : filtered;

    if (candidates.length === 0) {
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | total=${allDays.length} earliest=${earliest} | ${casAligned ? 'no earlier dates than current' : 'no consular dates'}`);
    } else {
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | total=${allDays.length} | ${candidates.length} candidates (earliest=${candidates[0]!.date}) | ${casAligned ? 'IMPROVE mode' : 'SECURE mode'}`);

      let postedThisCycle = false;
      // Iterate candidates in chronological order (earliest first)
      for (const d of candidates.slice(0, 10)) { // cap iteration per poll
        const cDate = d.date;
        const timesData = await client.getConsularTimes(cDate);
        const allTimes = filterTimes(cDate, timesData.available_times, timeExclusions);
        if (allTimes.length === 0) continue;

        // For each consular time, check if CAS in window
        for (const cTime of allTimes) {
          const casDays = await client.getCasDays(cDate, cTime);
          const filteredCas = filterDates(casDays, dateExclusions, undefined, minDate);
          const casInWin = filteredCas.find(c => inCasWindow(c.date));
          if (!casInWin) continue;

          // Got a valid combo! Fetch CAS times.
          const casTimesData = await client.getCasTimes(casInWin.date, cDate, cTime);
          const casTimes = filterTimes(casInWin.date, casTimesData.available_times, timeExclusions);
          if (casTimes.length === 0) continue;
          const casTime = casTimes[0]!;

          console.log(`[${bogota()}]   ✓ COMBO: consular ${cDate} ${cTime} | CAS ${casInWin.date} ${casTime}`);

          if (!commit) {
            console.log(`[${bogota()}]   DRY-RUN — would POST. Re-run with --commit.`);
            process.exit(0);
          }

          await client.refreshTokens();
          const ok = await client.reschedule(cDate, cTime, casInWin.date, casTime);
          if (ok) {
            console.log(`\n🎉 POST OK`);
            console.log(`  Old: ${lastConsularDate} ${lastConsularTime} | CAS ${lastCasDate} ${lastCasTime ?? ''}`);
            console.log(`  New: ${cDate} ${cTime} | CAS ${casInWin.date} ${casTime}`);
            await db.update(bots).set({
              currentConsularDate: cDate,
              currentConsularTime: cTime,
              currentCasDate: casInWin.date,
              currentCasTime: casTime,
              rescheduleCount: (bot.rescheduleCount ?? 0) + 1,
              updatedAt: new Date(),
            }).where(eq(bots.id, BOT_ID));
            await db.insert(rescheduleLogs).values({
              botId: BOT_ID,
              oldConsularDate: lastConsularDate,
              oldConsularTime: lastConsularTime,
              oldCasDate: lastCasDate,
              oldCasTime: lastCasTime,
              newConsularDate: cDate,
              newConsularTime: cTime,
              newCasDate: casInWin.date,
              newCasTime: casTime,
              success: true,
              provider: bot.proxyProvider,
            }).catch((e) => console.log(`rescheduleLogs insert failed: ${e instanceof Error ? e.message : e}`));

            lastConsularDate = cDate;
            lastConsularTime = cTime;
            lastCasDate = casInWin.date;
            lastCasTime = casTime;
            postedThisCycle = true;
            break; // exit time loop
          }
          console.log(`[${bogota()}]   POST returned false for ${cDate} ${cTime}`);
        }
        if (postedThisCycle) break; // exit date loop
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

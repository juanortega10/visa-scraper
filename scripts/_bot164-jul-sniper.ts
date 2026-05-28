/**
 * Bot 164 — July 23-26 sniper (CAS gap ≤4 days).
 *
 * Current: 2026-07-27 09:30 / CAS 2026-07-21. We only accept consular dates
 * 2026-07-23..2026-07-26 (strict-earlier guard blocks 2026-07-27).
 *
 * CAS window: max 4 days before consular (uses bot.maxCasGapDays, currently 4).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/_bot164-jul-sniper.ts            # dry-run
 *   npx tsx --env-file=.env scripts/_bot164-jul-sniper.ts --commit   # real POST
 */
import { db } from '../src/db/client.js';
import { bots, sessions, excludedDates, excludedTimes, pollLogs, rescheduleLogs } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '../src/services/encryption.js';
import { VisaClient, SessionExpiredError } from '../src/services/visa-client.js';
import { filterDates, filterTimes, addDays, isAtLeastNDaysEarlier } from '../src/utils/date-helpers.js';
import { MIN_DAYS_FROM_TODAY } from '../src/utils/constants.js';
import { performLogin } from '../src/services/login.js';
import type { ProxyProvider } from '../src/services/proxy-fetch.js';

const BOT_ID = 164;
const POLL_INTERVAL_MS = 20_000;       // 3 polls/min
const TARGET_START = '2026-07-23';
const TARGET_END   = '2026-07-26';     // strict-earlier vs current 2026-07-27

const commit = process.argv.includes('--commit');

const bogota = (d = new Date()) =>
  new Date(d.getTime() - 5 * 3600_000).toISOString().slice(11, 19);

console.log('\n=== Bot 164 — July 23-26 sniper ===');
console.log(`Mode:     ${commit ? 'COMMIT (real reschedule)' : 'DRY-RUN (no POST)'}`);
console.log(`Interval: ${POLL_INTERVAL_MS / 1000}s`);
console.log(`Window:   ${TARGET_START} .. ${TARGET_END} (consular)`);

// ── Load bot + session ─────────────────────────────────────────
const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!bot) { console.error(`Bot ${BOT_ID} not found`); process.exit(1); }

const [session] = await db.select().from(sessions).where(eq(sessions.botId, BOT_ID));
if (!session) { console.error(`No session for bot ${BOT_ID}. Activate it first to seed a session.`); process.exit(1); }

// Safety: window end must be strictly earlier than current consular
if (!bot.currentConsularDate || !isAtLeastNDaysEarlier(TARGET_END, bot.currentConsularDate, 1)) {
  console.error(`SAFETY ABORT: window end ${TARGET_END} is not strictly earlier than current ${bot.currentConsularDate}.`);
  process.exit(1);
}

const CAS_WINDOW_DAYS = bot.maxCasGapDays ?? 8;
console.log(`CAS gap:  ≤${CAS_WINDOW_DAYS} days before consular (from bot.maxCasGapDays)`);

const exDates = await db.select().from(excludedDates).where(eq(excludedDates.botId, BOT_ID));
const dateExclusions = exDates.map(d => ({ startDate: d.startDate, endDate: d.endDate }));
const exTimes = await db.select().from(excludedTimes).where(eq(excludedTimes.botId, BOT_ID));
const timeExclusions = exTimes.map(t => ({ date: t.date, timeStart: t.timeStart, timeEnd: t.timeEnd }));

console.log(`Current:  ${bot.currentConsularDate} ${bot.currentConsularTime ?? ''} (CAS ${bot.currentCasDate} ${bot.currentCasTime ?? ''})`);
console.log(`Schedule: ${bot.scheduleId} | locale ${bot.locale} | proxy ${bot.proxyProvider}`);
console.log(`Excluded: ${exDates.length} dates, ${exTimes.length} time windows\n`);

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
    lastUsedAt: new Date(),
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

  // Pre-emptive re-login at 44min
  if (commit && Date.now() - lastReloginMs > 44 * 60_000) {
    try { await reLogin(); lastReloginMs = Date.now(); }
    catch (err) { console.log(`[${bogota()}] re-login failed: ${err instanceof Error ? err.message : err}`); }
  }

  try {
    const allDays = await client.getConsularDays();
    const filtered = filterDates(allDays, dateExclusions, undefined, minDate);
    const inWindow = filtered.filter(d => d.date >= TARGET_START && d.date <= TARGET_END);
    const fetchMs = Date.now() - iterStart;
    const earliest = filtered[0]?.date ?? 'none';

    await db.insert(pollLogs).values({
      botId: BOT_ID,
      status: inWindow.length > 0 ? 'ok' : 'filtered_out',
      earliestDate: filtered[0]?.date ?? null,
      datesCount: filtered.length,
      rawDatesCount: allDays.length,
      responseTimeMs: fetchMs,
      topDates: filtered.slice(0, 10).map(d => d.date),
      provider: bot.proxyProvider,
      pollPhase: 'manual_sniper',
      chainId: 'dev',
      fetchIndex: pollCount,
      allDates: allDays.map(d => ({ date: d.date, business_day: d.business_day })),
    }).catch((e) => console.log(`[${bogota()}]   pollLogs insert failed: ${e instanceof Error ? e.message : e}`));

    if (inWindow.length === 0) {
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | total=${allDays.length} earliest=${earliest} | no dates in window`);
    } else {
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | 🎯 ${inWindow.length} date(s) in window: [${inWindow.map(d => d.date).join(', ')}]`);

      // Try earliest date in window first (greedy)
      let scheduled = false;
      outer: for (const cand of inWindow) {
        if (!isAtLeastNDaysEarlier(cand.date, bot.currentConsularDate!, 1)) {
          console.log(`[${bogota()}]   skip ${cand.date}: not strictly earlier than current ${bot.currentConsularDate}`);
          continue;
        }
        const timesData = await client.getConsularTimes(cand.date);
        const consularTimes = filterTimes(cand.date, timesData.available_times, timeExclusions);
        console.log(`[${bogota()}]   ${cand.date}: times=[${consularTimes.join(', ') || '(none)'}]`);
        if (consularTimes.length === 0) continue;

        for (const cTime of consularTimes) {
          const casDays = await client.getCasDays(cand.date, cTime);
          // Filter: CAS must be 1..CAS_WINDOW_DAYS days BEFORE consular
          const consularMs = new Date(cand.date).getTime();
          const eligibleCas = filterDates(casDays, dateExclusions, undefined, minDate).filter(c => {
            const daysBefore = (consularMs - new Date(c.date).getTime()) / 864e5;
            return daysBefore >= 1 && daysBefore <= CAS_WINDOW_DAYS;
          });
          if (eligibleCas.length === 0) {
            console.log(`[${bogota()}]   ${cand.date} ${cTime} → no CAS within ${CAS_WINDOW_DAYS}d (got ${casDays.length} raw)`);
            continue;
          }
          // Prefer CAS closest to consular (latest CAS within window)
          eligibleCas.sort((a, b) => b.date.localeCompare(a.date));
          const casDate = eligibleCas[0]!.date;
          const casTimesData = await client.getCasTimes(casDate, cand.date, cTime);
          const casTimes = filterTimes(casDate, casTimesData.available_times, timeExclusions);
          if (casTimes.length === 0) {
            console.log(`[${bogota()}]   ${cand.date} ${cTime} → CAS ${casDate} has no times`);
            continue;
          }
          const casTime = casTimes[0]!;
          console.log(`[${bogota()}]   ✓ COMBO: consular ${cand.date} ${cTime} | CAS ${casDate} ${casTime}`);

          if (!commit) {
            console.log(`[${bogota()}]   DRY-RUN — would POST. Re-run with --commit to actually reschedule.`);
            process.exit(0);
          }

          await client.refreshTokens();
          const ok = await client.reschedule(cand.date, cTime, casDate, casTime);
          if (ok) {
            console.log(`\n🎉 RESCHEDULE OK`);
            console.log(`  Old: ${bot.currentConsularDate} ${bot.currentConsularTime ?? ''}`);
            console.log(`  New: ${cand.date} ${cTime} | CAS ${casDate} ${casTime}`);
            await db.update(bots).set({
              currentConsularDate: cand.date,
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
              newConsularDate: cand.date,
              newConsularTime: cTime,
              newCasDate: casDate,
              newCasTime: casTime,
              success: true,
              provider: bot.proxyProvider,
            }).catch((e) => console.log(`rescheduleLogs insert failed: ${e instanceof Error ? e.message : e}`));
            scheduled = true;
            process.exit(0);
          }
          console.log(`[${bogota()}]   POST returned false for ${cand.date} ${cTime} — next time`);
        }
        if (scheduled) break outer;
      }
      if (!scheduled) console.log(`[${bogota()}]   window exhausted this poll, will retry`);
    }
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      console.log(`[${bogota()}] #${pollCount} | session expired — re-logging`);
      try { await reLogin(); lastReloginMs = Date.now(); }
      catch (e) { console.log(`[${bogota()}] re-login failed: ${e instanceof Error ? e.message : e}`); }
    } else {
      console.log(`[${bogota()}] #${pollCount} | ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const elapsed = Date.now() - iterStart;
  const sleep = Math.max(0, POLL_INTERVAL_MS - elapsed);
  if (sleep > 0) await new Promise(r => setTimeout(r, sleep));
}

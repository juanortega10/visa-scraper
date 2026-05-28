/**
 * Bot 173 — Jun 17 to Jul 16, 2026 sniper (no CAS, runs on RPi).
 *
 * Two phases:
 *   PHASE 1 (current 2026-06-10 ∉ window): take any window date — forward move,
 *           loses Jun 10 slot. User authorized.
 *   PHASE 2 (current ∈ window): take only dates strictly earlier than current,
 *           still ≥ 2026-06-17. Stops when current = 2026-06-17 (earliest acceptable).
 *
 * Bot 173 has consular but no CAS. Reschedule POST omits CAS (mirrors past bot
 * behavior — see reschedule_logs history).
 *
 * Proxy: forced to `direct` (webshare on sustained es-co polling → account blocks).
 *
 * Usage on RPi:
 *   cd /home/agetrox/visa-scraper
 *   nohup npx tsx --env-file=.env scripts/_bot173-jun-jul-sniper.ts --commit > /tmp/bot173-sniper.log 2>&1 &
 *
 * Dry-run anywhere:
 *   npx tsx --env-file=.env scripts/_bot173-jun-jul-sniper.ts
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

const BOT_ID = 173;
const POLL_INTERVAL_MS = 20_000;       // 3 polls/min
const WINDOW_START = '2026-06-17';     // strictly after Jun 16
const WINDOW_END   = '2026-07-16';

const commit = process.argv.includes('--commit');

const bogota = (d = new Date()) =>
  new Date(d.getTime() - 5 * 3600_000).toISOString().slice(11, 19);

console.log('\n=== Bot 173 — Jun 17–Jul 16, 2026 sniper ===');
console.log(`Mode:     ${commit ? 'COMMIT (real reschedule — WILL LOSE current Jun 10 slot first POST)' : 'DRY-RUN (no POST)'}`);
console.log(`Interval: ${POLL_INTERVAL_MS / 1000}s`);
console.log(`Window:   ${WINDOW_START} .. ${WINDOW_END} (consular)`);
console.log(`Strategy: forward-move first POST, then progressively earlier toward ${WINDOW_START}`);

let [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!bot) { console.error(`Bot ${BOT_ID} not found`); process.exit(1); }

const [session0] = await db.select().from(sessions).where(eq(sessions.botId, BOT_ID));
if (!session0) { console.error(`No session for bot ${BOT_ID}. Activate it first to seed a session.`); process.exit(1); }

const exDates = await db.select().from(excludedDates).where(eq(excludedDates.botId, BOT_ID));
const dateExclusions = exDates.map(d => ({ startDate: d.startDate, endDate: d.endDate }));
const exTimes = await db.select().from(excludedTimes).where(eq(excludedTimes.botId, BOT_ID));
const timeExclusions = exTimes.map(t => ({ date: t.date, timeStart: t.timeStart, timeEnd: t.timeEnd }));

console.log(`Current:  ${bot.currentConsularDate} ${bot.currentConsularTime ?? ''} (CAS ${bot.currentCasDate ?? '(none)'})`);
console.log(`Schedule: ${bot.scheduleId} | locale ${bot.locale} | proxy direct (overriding bot.proxyProvider=${bot.proxyProvider})`);
console.log(`Excluded: ${exDates.length} dates, ${exTimes.length} time windows\n`);

const visaConfig = {
  scheduleId: bot.scheduleId,
  applicantIds: bot.applicantIds,
  consularFacilityId: bot.consularFacilityId,
  ascFacilityId: bot.ascFacilityId,
  proxyProvider: 'direct' as ProxyProvider,
  userId: bot.userId,
  locale: bot.locale,
};

let client = new VisaClient(
  {
    cookie: decrypt(session0.yatriCookie),
    csrfToken: session0.csrfToken ?? '',
    authenticityToken: session0.authenticityToken ?? '',
  },
  visaConfig,
);

async function reLogin(): Promise<void> {
  console.log(`[${bogota()}] Re-logging in...`);
  const result = await performLogin({
    email: decrypt(bot!.visaEmail),
    password: decrypt(bot!.visaPassword),
    scheduleId: bot!.scheduleId,
    applicantIds: bot!.applicantIds,
    locale: bot!.locale,
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

  // Reload bot from DB each iteration to track current consular date (updated by us after POST)
  [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
  if (!bot) { console.error('Bot disappeared'); process.exit(1); }

  if (bot.currentConsularDate === WINDOW_START) {
    console.log(`[${bogota()}] ✓ Reached WINDOW_START ${WINDOW_START} — earliest acceptable. Done.`);
    process.exit(0);
  }

  const inWindowAndCurrent = bot.currentConsularDate
    && bot.currentConsularDate >= WINDOW_START
    && bot.currentConsularDate <= WINDOW_END;
  // Phase 1: current is BEFORE window → accept any window date (forward move)
  // Phase 2: current IS in window → only earlier-than-current candidates
  const upperBound = inWindowAndCurrent ? bot.currentConsularDate : WINDOW_END;

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
    const inWindow = filtered.filter(d =>
      d.date >= WINDOW_START
      && d.date < upperBound!  // strict-less: Phase 2 earlier than current; Phase 1 ≤ WINDOW_END handled separately
      || (d.date === WINDOW_END && !inWindowAndCurrent),  // allow WINDOW_END in Phase 1
    ).filter(d => d.date >= WINDOW_START && d.date <= WINDOW_END);

    // Re-filter cleanly: window + (Phase 2: < current, Phase 1: any in window)
    const candidates = filtered.filter(d => {
      if (d.date < WINDOW_START || d.date > WINDOW_END) return false;
      if (inWindowAndCurrent) return d.date < bot!.currentConsularDate!;
      return true;
    });

    const fetchMs = Date.now() - iterStart;
    const earliest = filtered[0]?.date ?? 'none';
    const phase = inWindowAndCurrent ? `P2(<${bot.currentConsularDate})` : 'P1(forward)';

    await db.insert(pollLogs).values({
      botId: BOT_ID,
      status: candidates.length > 0 ? 'ok' : 'filtered_out',
      earliestDate: filtered[0]?.date ?? null,
      datesCount: filtered.length,
      rawDatesCount: allDays.length,
      responseTimeMs: fetchMs,
      topDates: filtered.slice(0, 10).map(d => d.date),
      provider: 'direct',
      pollPhase: 'manual_sniper',
      chainId: 'dev',
      fetchIndex: pollCount,
      allDates: allDays.map(d => ({ date: d.date, business_day: d.business_day })),
    }).catch((e) => console.log(`[${bogota()}]   pollLogs insert failed: ${e instanceof Error ? e.message : e}`));

    if (candidates.length === 0) {
      console.log(`[${bogota()}] #${pollCount} ${phase} | ${fetchMs}ms | total=${allDays.length} earliest=${earliest} | no candidates`);
    } else {
      console.log(`[${bogota()}] #${pollCount} ${phase} | ${fetchMs}ms | 🎯 ${candidates.length} candidates: [${candidates.slice(0,8).map(d => d.date).join(', ')}${candidates.length > 8 ? ', ...' : ''}]`);

      let scheduled = false;
      outer: for (const cand of candidates) {
        if (cand.date === bot.currentConsularDate) {
          console.log(`[${bogota()}]   skip ${cand.date}: equals current (no-op)`);
          continue;
        }
        const timesData = await client.getConsularTimes(cand.date);
        const consularTimes = filterTimes(cand.date, timesData.available_times, timeExclusions);
        console.log(`[${bogota()}]   ${cand.date}: times=[${consularTimes.join(', ') || '(none)'}]`);
        if (consularTimes.length === 0) continue;

        for (const cTime of consularTimes) {
          console.log(`[${bogota()}]   ✓ POST consular ${cand.date} ${cTime} (no CAS)`);

          if (!commit) {
            console.log(`[${bogota()}]   DRY-RUN — would POST. Re-run with --commit.`);
            process.exit(0);
          }

          await client.refreshTokens();
          const ok = await client.reschedule(cand.date, cTime);
          if (ok) {
            console.log(`\n🎉 RESCHEDULE OK`);
            console.log(`  Old: ${bot.currentConsularDate} ${bot.currentConsularTime}`);
            console.log(`  New: ${cand.date} ${cTime}`);
            await db.update(bots).set({
              currentConsularDate: cand.date,
              currentConsularTime: cTime,
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
              newCasDate: null,
              newCasTime: null,
              success: true,
              provider: 'direct',
            }).catch((e) => console.log(`rescheduleLogs insert failed: ${e instanceof Error ? e.message : e}`));
            scheduled = true;
            break outer;
          }
          console.log(`[${bogota()}]   POST returned false for ${cand.date} ${cTime} — next time`);
        }
      }
      if (!scheduled) console.log(`[${bogota()}]   candidates exhausted this poll, will retry`);
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

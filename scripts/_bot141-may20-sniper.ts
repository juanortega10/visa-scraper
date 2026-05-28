/**
 * Bot 141 — May 20 morning sniper.
 *
 * Goal: align bot 141 with bot 140 (which holds 2026-05-20 11:15).
 * Strict filter: only consular date 2026-05-20 AND time < 12:00.
 *
 * Strictly-earlier guard is preserved: 2026-05-20 < 2026-05-21 (current) ✅
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/_bot141-may20-sniper.ts            # dry-run
 *   npx tsx --env-file=.env scripts/_bot141-may20-sniper.ts --commit   # real POST
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

const BOT_ID = 141;
const POLL_INTERVAL_MS = 30_000;       // 2 polls/min — same as bot 109 (safe for webshare es-co)
const TARGET_DATE = '2026-05-20';      // exact match only
const AM_CUTOFF_HHMM = '12:00';        // strict morning (any time < 12:00)

const args = process.argv.slice(2);
const commit = args.includes('--commit');

const bogota = (d = new Date()) =>
  new Date(d.getTime() - 5 * 3600_000).toISOString().slice(11, 19);

console.log('\n=== Bot 141 — May 20 morning sniper ===');
console.log(`Mode:     ${commit ? 'COMMIT (real reschedule)' : 'DRY-RUN (no POST)'}`);
console.log(`Interval: ${POLL_INTERVAL_MS / 1000}s (${60_000 / POLL_INTERVAL_MS} polls/min)`);
console.log(`Target:   exact date ${TARGET_DATE}, time < ${AM_CUTOFF_HHMM}`);

// ── Load bot + session ─────────────────────────────────────────
const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!bot) { console.error(`Bot ${BOT_ID} not found`); process.exit(1); }

const [session] = await db.select().from(sessions).where(eq(sessions.botId, BOT_ID));
if (!session) { console.error(`No session for bot ${BOT_ID}. Run: npm run login -- --bot-id=${BOT_ID}`); process.exit(1); }

// Safety: current consular must be strictly later than target
if (!bot.currentConsularDate || !isAtLeastNDaysEarlier(TARGET_DATE, bot.currentConsularDate, 1)) {
  console.error(`SAFETY ABORT: target ${TARGET_DATE} is not strictly earlier than current ${bot.currentConsularDate}.`);
  process.exit(1);
}

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

// ── Re-login helper ────────────────────────────────────────────
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

// ── Main loop ──────────────────────────────────────────────────
let pollCount = 0;
let lastReloginMs = Date.now();

while (true) {
  pollCount++;
  const iterStart = Date.now();
  const minDate = addDays(
    new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Bogota' }),
    bot.minDaysFromToday ?? MIN_DAYS_FROM_TODAY,
  );

  // Pre-emptive re-login at 44min (half of ~1h28m TTL)
  if (commit && Date.now() - lastReloginMs > 44 * 60_000) {
    try {
      await reLogin();
      lastReloginMs = Date.now();
    } catch (err) {
      console.log(`[${bogota()}] re-login failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  try {
    const allDays = await client.getConsularDays();
    const filtered = filterDates(allDays, dateExclusions, undefined, minDate);
    const targetDay = filtered.find(d => d.date === TARGET_DATE);
    const fetchMs = Date.now() - iterStart;
    const earliest = filtered[0]?.date ?? 'none';

    // ── Persist poll_logs entry so dashboard reflects sniper activity ──
    await db.insert(pollLogs).values({
      botId: BOT_ID,
      status: targetDay ? 'ok' : 'filtered_out',
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

    if (!targetDay) {
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | total=${allDays.length} earliest=${earliest} | no ${TARGET_DATE}`);
    } else {
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | 🎯 ${TARGET_DATE} FOUND — fetching times`);

      const timesData = await client.getConsularTimes(TARGET_DATE);
      const allConsularTimes = filterTimes(TARGET_DATE, timesData.available_times, timeExclusions);
      const morningTimes = allConsularTimes.filter(t => t < AM_CUTOFF_HHMM);
      console.log(`[${bogota()}]   times: all=[${allConsularTimes.join(', ') || '(none)'}] | morning=[${morningTimes.join(', ') || '(none)'}]`);

      if (morningTimes.length === 0) {
        console.log(`[${bogota()}]   no morning slots, continuing to poll`);
      } else {
        let scheduled = false;
        for (const cTime of morningTimes) {
          const casDays = await client.getCasDays(TARGET_DATE, cTime);
          const filteredCas = filterDates(casDays, dateExclusions, undefined, minDate);
          if (filteredCas.length === 0) {
            console.log(`[${bogota()}]   ${cTime} → no CAS days, next time`);
            continue;
          }
          const casDate = filteredCas[0]!.date;
          const casTimesData = await client.getCasTimes(casDate, TARGET_DATE, cTime);
          const casTimes = filterTimes(casDate, casTimesData.available_times, timeExclusions);
          if (casTimes.length === 0) {
            console.log(`[${bogota()}]   ${cTime} → CAS ${casDate} has no times, next time`);
            continue;
          }
          const casTime = casTimes[0]!;
          console.log(`[${bogota()}]   ✓ COMBO: consular ${TARGET_DATE} ${cTime} | CAS ${casDate} ${casTime}`);

          if (!commit) {
            console.log(`[${bogota()}]   DRY-RUN — would POST. Re-run with --commit to actually reschedule.`);
            process.exit(0);
          }

          // Prime server-side state before POST
          await client.refreshTokens();
          const ok = await client.reschedule(TARGET_DATE, cTime, casDate, casTime);
          if (ok) {
            console.log(`\n🎉 RESCHEDULE OK`);
            console.log(`  Old: ${bot.currentConsularDate} ${bot.currentConsularTime ?? ''}`);
            console.log(`  New: ${TARGET_DATE} ${cTime} | CAS ${casDate} ${casTime}`);
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
          console.log(`[${bogota()}]   POST returned false for ${cTime} — trying next time`);
        }
        if (!scheduled) {
          console.log(`[${bogota()}]   all morning times exhausted for ${TARGET_DATE}, will keep polling`);
        }
      }
    }
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      console.log(`[${bogota()}] #${pollCount} | session expired — re-logging`);
      try {
        await reLogin();
        lastReloginMs = Date.now();
      } catch (e) {
        console.log(`[${bogota()}] re-login failed: ${e instanceof Error ? e.message : e}`);
      }
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[${bogota()}] #${pollCount} | ERROR: ${msg}`);
    }
  }

  const elapsed = Date.now() - iterStart;
  const sleep = Math.max(0, POLL_INTERVAL_MS - elapsed);
  if (sleep > 0) await new Promise(r => setTimeout(r, sleep));
}

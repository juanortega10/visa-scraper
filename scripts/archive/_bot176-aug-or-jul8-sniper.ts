/**
 * Bot 176 — Aug-or-Jul8 sniper.
 *
 * Two acceptable outcomes:
 *   (A) Consular in 2026-08-01..2026-08-31 (any day), CAS auto-picked 1..10 days before.
 *   (B) Consular === 2026-07-08, CAS === 2026-06-29 (specific combo — 9-day gap).
 *
 * Preference: take whichever combo is found first; iterate earliest-first
 * (Jul 8 → Aug 1 → Aug 2 → ...).
 *
 * Current state: consular 2026-06-05 / CAS 2026-06-01 — none attendable.
 * User authorized losing Jun 5 slot.
 *
 * CAS gap raised to 10 days (default is 8) to enable the Jun 29 → Jul 8 combo.
 *
 * Proxy: forced to `direct` (webshare on sustained es-co polling has caused
 * account-level blocks).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/_bot176-jun-jul-sniper.ts            # dry-run
 *   npx tsx --env-file=.env scripts/_bot176-jun-jul-sniper.ts --commit   # real POST
 */
import { db } from '../src/db/client.js';
import { bots, sessions, excludedDates, excludedTimes, pollLogs, rescheduleLogs } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '../src/services/encryption.js';
import { VisaClient, SessionExpiredError } from '../src/services/visa-client.js';
import { filterDates, filterTimes, addDays, isDateExcluded } from '../src/utils/date-helpers.js';
import { MIN_DAYS_FROM_TODAY } from '../src/utils/constants.js';
import { performLogin } from '../src/services/login.js';
import type { ProxyProvider } from '../src/services/proxy-fetch.js';

const BOT_ID = 176;
const POLL_INTERVAL_MS = 20_000;       // 3 polls/min
const AUG_START = '2026-08-01';
const AUG_END   = '2026-08-31';
const SPECIFIC_CONSULAR = '2026-07-08';
const SPECIFIC_CAS = '2026-06-29';
const CAS_WINDOW_DAYS = 10;            // raised from default 8 to enable Jun 29 → Jul 8 (9d gap)

const commit = process.argv.includes('--commit');

const bogota = (d = new Date()) =>
  new Date(d.getTime() - 5 * 3600_000).toISOString().slice(11, 19);

console.log('\n=== Bot 176 — Aug-or-Jul8 sniper ===');
console.log(`Mode:     ${commit ? 'COMMIT (real reschedule — WILL LOSE current Jun 5 slot)' : 'DRY-RUN (no POST)'}`);
console.log(`Interval: ${POLL_INTERVAL_MS / 1000}s`);
console.log(`Targets:  (A) consular ${AUG_START}..${AUG_END} + CAS auto`);
console.log(`          (B) consular ${SPECIFIC_CONSULAR} + CAS ${SPECIFIC_CAS}`);
console.log(`CAS gap:  ≤${CAS_WINDOW_DAYS} days before consular`);

const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!bot) { console.error(`Bot ${BOT_ID} not found`); process.exit(1); }

const [session] = await db.select().from(sessions).where(eq(sessions.botId, BOT_ID));
if (!session) { console.error(`No session for bot ${BOT_ID}. Activate it briefly to seed a session.`); process.exit(1); }

const exDates = await db.select().from(excludedDates).where(eq(excludedDates.botId, BOT_ID));
const dateExclusions = exDates.map(d => ({ startDate: d.startDate, endDate: d.endDate }));
const exTimes = await db.select().from(excludedTimes).where(eq(excludedTimes.botId, BOT_ID));
const timeExclusions = exTimes.map(t => ({ date: t.date, timeStart: t.timeStart, timeEnd: t.timeEnd }));

// Defensive: Jun 29 must NOT be excluded since path (B) needs it as CAS
if (isDateExcluded(SPECIFIC_CAS, dateExclusions)) {
  console.error(`SAFETY ABORT: ${SPECIFIC_CAS} is in excluded_dates but path (B) requires it as CAS. Remove that exclusion first.`);
  process.exit(1);
}

console.log(`Current:  ${bot.currentConsularDate} ${bot.currentConsularTime ?? ''} (CAS ${bot.currentCasDate} ${bot.currentCasTime ?? ''})`);
console.log(`Schedule: ${bot.scheduleId} | locale ${bot.locale} | proxy direct (overriding bot.proxyProvider=${bot.proxyProvider} for safety)`);
console.log(`Excluded: ${exDates.length} dates [${dateExclusions.map(d => d.startDate === d.endDate ? d.startDate : `${d.startDate}..${d.endDate}`).join(', ')}], ${exTimes.length} time windows`);
console.log(`⚠️  No strict-earlier guard — sniper WILL move forward (user authorized loss of Jun 5)\n`);

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

async function commitReschedule(
  consularDate: string,
  consularTime: string,
  casDate: string,
  casTime: string,
): Promise<boolean> {
  await client.refreshTokens();
  const ok = await client.reschedule(consularDate, consularTime, casDate, casTime);
  if (!ok) return false;
  console.log(`\n🎉 RESCHEDULE OK`);
  console.log(`  Old: ${bot!.currentConsularDate} ${bot!.currentConsularTime ?? ''} (CAS ${bot!.currentCasDate} ${bot!.currentCasTime ?? ''})`);
  console.log(`  New: ${consularDate} ${consularTime} | CAS ${casDate} ${casTime}`);
  await db.update(bots).set({
    currentConsularDate: consularDate,
    currentConsularTime: consularTime,
    currentCasDate: casDate,
    currentCasTime: casTime,
    rescheduleCount: (bot!.rescheduleCount ?? 0) + 1,
    updatedAt: new Date(),
  }).where(eq(bots.id, BOT_ID));
  await db.insert(rescheduleLogs).values({
    botId: BOT_ID,
    oldConsularDate: bot!.currentConsularDate,
    oldConsularTime: bot!.currentConsularTime,
    oldCasDate: bot!.currentCasDate,
    oldCasTime: bot!.currentCasTime,
    newConsularDate: consularDate,
    newConsularTime: consularTime,
    newCasDate: casDate,
    newCasTime: casTime,
    success: true,
    provider: 'direct',
  }).catch((e) => console.log(`rescheduleLogs insert failed: ${e instanceof Error ? e.message : e}`));
  return true;
}

/** Try the specific Jul 8 + Jun 29 combo. Returns true if scheduled (and exits). */
async function tryPathB(): Promise<boolean> {
  // Verify Jul 8 is in available days
  const timesData = await client.getConsularTimes(SPECIFIC_CONSULAR);
  const consularTimes = filterTimes(SPECIFIC_CONSULAR, timesData.available_times, timeExclusions);
  if (consularTimes.length === 0) return false;

  // Verify Jun 29 is in CAS days for Jul 8
  for (const cTime of consularTimes) {
    const casDays = await client.getCasDays(SPECIFIC_CONSULAR, cTime);
    const hasCas = casDays.some(c => c.date === SPECIFIC_CAS);
    if (!hasCas) {
      console.log(`[${bogota()}]   path-B: Jul 8 ${cTime} → CAS days don't include ${SPECIFIC_CAS}`);
      continue;
    }
    const casTimesData = await client.getCasTimes(SPECIFIC_CAS, SPECIFIC_CONSULAR, cTime);
    const casTimes = filterTimes(SPECIFIC_CAS, casTimesData.available_times, timeExclusions);
    if (casTimes.length === 0) {
      console.log(`[${bogota()}]   path-B: ${SPECIFIC_CAS} has no times`);
      continue;
    }
    const casTime = casTimes[0]!;
    console.log(`[${bogota()}]   ✓ PATH-B COMBO: consular ${SPECIFIC_CONSULAR} ${cTime} | CAS ${SPECIFIC_CAS} ${casTime}`);

    if (!commit) {
      console.log(`[${bogota()}]   DRY-RUN — would POST path-B. Re-run with --commit.`);
      process.exit(0);
    }
    const ok = await commitReschedule(SPECIFIC_CONSULAR, cTime, SPECIFIC_CAS, casTime);
    if (ok) process.exit(0);
  }
  return false;
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

    const hasJul8 = filtered.some(d => d.date === SPECIFIC_CONSULAR);
    const augDates = filtered.filter(d => d.date >= AUG_START && d.date <= AUG_END);
    const totalCandidates = (hasJul8 ? 1 : 0) + augDates.length;
    const earliest = filtered[0]?.date ?? 'none';

    await db.insert(pollLogs).values({
      botId: BOT_ID,
      status: totalCandidates > 0 ? 'ok' : 'filtered_out',
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

    if (totalCandidates === 0) {
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | total=${allDays.length} earliest=${earliest} | no path-A or path-B candidates`);
    } else {
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | 🎯 path-B(jul8)=${hasJul8} path-A(aug)=${augDates.length} [${augDates.slice(0,8).map(d => d.date).join(', ')}${augDates.length > 8 ? ', ...' : ''}]`);

      // Path B first (Jul 8 earlier than any Aug date)
      if (hasJul8) {
        const scheduled = await tryPathB();
        if (scheduled) break;
      }

      // Path A: iterate Aug earliest-first
      let scheduled = false;
      outer: for (const cand of augDates) {
        if (cand.date === bot.currentConsularDate) {
          console.log(`[${bogota()}]   skip ${cand.date}: equals current (no-op)`);
          continue;
        }
        const timesData = await client.getConsularTimes(cand.date);
        const consularTimes = filterTimes(cand.date, timesData.available_times, timeExclusions);
        console.log(`[${bogota()}]   ${cand.date}: times=[${consularTimes.join(', ') || '(none)'}]`);
        if (consularTimes.length === 0) continue;

        for (const cTime of consularTimes) {
          const casDays = await client.getCasDays(cand.date, cTime);
          const consularMs = new Date(cand.date).getTime();
          const eligibleCas = filterDates(casDays, dateExclusions, undefined, minDate).filter(c => {
            const daysBefore = (consularMs - new Date(c.date).getTime()) / 864e5;
            return daysBefore >= 1 && daysBefore <= CAS_WINDOW_DAYS;
          });
          if (eligibleCas.length === 0) {
            console.log(`[${bogota()}]   ${cand.date} ${cTime} → no CAS within ${CAS_WINDOW_DAYS}d (got ${casDays.length} raw)`);
            continue;
          }
          eligibleCas.sort((a, b) => b.date.localeCompare(a.date)); // latest CAS within window
          const casDate = eligibleCas[0]!.date;
          const casTimesData = await client.getCasTimes(casDate, cand.date, cTime);
          const casTimes = filterTimes(casDate, casTimesData.available_times, timeExclusions);
          if (casTimes.length === 0) {
            console.log(`[${bogota()}]   ${cand.date} ${cTime} → CAS ${casDate} has no times`);
            continue;
          }
          const casTime = casTimes[0]!;
          console.log(`[${bogota()}]   ✓ PATH-A COMBO: consular ${cand.date} ${cTime} | CAS ${casDate} ${casTime}`);

          if (!commit) {
            console.log(`[${bogota()}]   DRY-RUN — would POST path-A. Re-run with --commit.`);
            process.exit(0);
          }
          const ok = await commitReschedule(cand.date, cTime, casDate, casTime);
          if (ok) { scheduled = true; process.exit(0); }
          console.log(`[${bogota()}]   POST returned false for ${cand.date} ${cTime} — next time`);
        }
        if (scheduled) break outer;
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

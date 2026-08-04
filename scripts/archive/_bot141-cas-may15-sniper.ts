/**
 * Bot 141 — CAS-May-15 + consular alignment sniper.
 *
 * Goal: bring bot 141 to (consular ∈ [10:15, 12:15] on 2026-05-20, CAS on 2026-05-15)
 * with consular as close as possible to bot 140 (11:15).
 *
 * Every POST changes BOTH consular and CAS. Atomic — failure preserves current state.
 * Strategy: "secure then improve"
 *   - Secure: first valid (consular, May 15) combo, even if consular == current 11:30.
 *   - Improve: keep polling, POST only if new candidate has smaller |consular-11:15| gap.
 *   - Stop when CAS==May 15 AND gap <= 15min (= 11:00 or 11:30, best achievable since 11:15 doesn't exist in this pool).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/_bot141-cas-may15-sniper.ts            # dry-run
 *   npx tsx --env-file=.env scripts/_bot141-cas-may15-sniper.ts --commit   # real POST
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
const TARGET_CONSULAR_DATE = '2026-05-20';
const TARGET_CAS_DATE = '2026-05-15';
const MAX_GAP_MINUTES = 60;             // hard window for consular
const STOP_GAP_MINUTES = 15;            // exit when gap <= this AND CAS aligned
const POLL_INTERVAL_MS = 20_000;        // 3 polls/min

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

console.log('\n=== Bot 141 — CAS-May-15 alignment sniper ===');
console.log(`Mode:     ${commit ? 'COMMIT (real reschedule)' : 'DRY-RUN (no POST)'}`);
console.log(`Interval: ${POLL_INTERVAL_MS / 1000}s (${(60_000 / POLL_INTERVAL_MS).toFixed(1)} polls/min)`);
console.log(`Target:   consular=${TARGET_CONSULAR_DATE} time∈[${Math.floor((ANCHOR_MIN-MAX_GAP_MINUTES)/60).toString().padStart(2,'0')}:${((ANCHOR_MIN-MAX_GAP_MINUTES)%60).toString().padStart(2,'0')},${Math.floor((ANCHOR_MIN+MAX_GAP_MINUTES)/60).toString().padStart(2,'0')}:${((ANCHOR_MIN+MAX_GAP_MINUTES)%60).toString().padStart(2,'0')}], CAS=${TARGET_CAS_DATE}, anchor=${ANCHOR_TIME}`);
console.log(`Stop:     CAS=${TARGET_CAS_DATE} AND |consular-${ANCHOR_TIME}| <= ${STOP_GAP_MINUTES}min`);

const [session] = await db.select().from(sessions).where(eq(sessions.botId, BOT_ID));
if (!session) { console.error(`No session for bot ${BOT_ID}`); process.exit(1); }

const exDates = await db.select().from(excludedDates).where(eq(excludedDates.botId, BOT_ID));
const dateExclusions = exDates.map(d => ({ startDate: d.startDate, endDate: d.endDate }));
const exTimes = await db.select().from(excludedTimes).where(eq(excludedTimes.botId, BOT_ID));
const timeExclusions = exTimes.map(t => ({ date: t.date, timeStart: t.timeStart, timeEnd: t.timeEnd }));

// In-memory state — tracks latest successful reschedule
let lastConsularDate = bot.currentConsularDate!;
let lastConsularTime = bot.currentConsularTime!;
let lastCasDate = bot.currentCasDate;
let lastCasTime = bot.currentCasTime;
let failedSameConsular = false;

console.log(`Current:  ${lastConsularDate} ${lastConsularTime} (CAS ${lastCasDate} ${lastCasTime ?? ''})`);
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

function currentGap(): number {
  return Math.abs(toMin(lastConsularTime) - ANCHOR_MIN);
}

function isAtTarget(): boolean {
  return lastCasDate === TARGET_CAS_DATE && currentGap() <= STOP_GAP_MINUTES;
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
    const targetDay = filtered.find(d => d.date === TARGET_CONSULAR_DATE);
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
      pollPhase: 'manual_sniper_cas',
      chainId: 'dev',
      fetchIndex: pollCount,
      allDates: allDays.map(d => ({ date: d.date, business_day: d.business_day })),
    }).catch((e) => console.log(`[${bogota()}]   pollLogs insert failed: ${e instanceof Error ? e.message : e}`));

    if (!targetDay) {
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | total=${allDays.length} earliest=${earliest} | no ${TARGET_CONSULAR_DATE}`);
    } else {
      const timesData = await client.getConsularTimes(TARGET_CONSULAR_DATE);
      const allTimes = filterTimes(TARGET_CONSULAR_DATE, timesData.available_times, timeExclusions);
      // Filter to window [10:15, 12:15] and sort by proximity to 11:15
      const windowTimes = allTimes
        .filter(t => Math.abs(toMin(t) - ANCHOR_MIN) <= MAX_GAP_MINUTES)
        .sort((a, b) => Math.abs(toMin(a) - ANCHOR_MIN) - Math.abs(toMin(b) - ANCHOR_MIN));

      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | 🎯 ${TARGET_CONSULAR_DATE} times=[${allTimes.join(', ') || '(none)'}] | window=[${windowTimes.join(', ') || '(none)'}] | state=(${lastConsularTime}, ${lastCasDate}, gap=${currentGap()}min)`);

      let postedThisCycle = false;
      for (const cTime of windowTimes) {
        // Skip if this is the current consular AND we already know same-consular POST fails
        if (cTime === lastConsularTime && failedSameConsular) {
          console.log(`[${bogota()}]   ${cTime} → skipping (same as current + previously failed)`);
          continue;
        }

        const newGap = Math.abs(toMin(cTime) - ANCHOR_MIN);

        // Improvement guard: if CAS already aligned, only POST if new is strictly better
        if (lastCasDate === TARGET_CAS_DATE && newGap >= currentGap()) {
          // Stop iteration — remaining candidates are equal or worse (sorted by proximity)
          break;
        }

        // Fetch CAS days for this consular slot
        const casDays = await client.getCasDays(TARGET_CONSULAR_DATE, cTime);
        const filteredCas = filterDates(casDays, dateExclusions, undefined, minDate);
        const hasTargetCas = filteredCas.some(d => d.date === TARGET_CAS_DATE);
        if (!hasTargetCas) {
          console.log(`[${bogota()}]   ${cTime} → ${TARGET_CAS_DATE} not in CAS pool (got ${filteredCas.slice(0, 3).map(d => d.date).join(',')}...)`);
          continue;
        }

        // Fetch CAS times for May 15
        const casTimesData = await client.getCasTimes(TARGET_CAS_DATE, TARGET_CONSULAR_DATE, cTime);
        const casTimes = filterTimes(TARGET_CAS_DATE, casTimesData.available_times, timeExclusions);
        if (casTimes.length === 0) {
          console.log(`[${bogota()}]   ${cTime} → CAS ${TARGET_CAS_DATE} has no times, skip`);
          continue;
        }
        const casTime = casTimes[0]!;
        console.log(`[${bogota()}]   ✓ COMBO: consular ${TARGET_CONSULAR_DATE} ${cTime} (gap=${newGap}min) | CAS ${TARGET_CAS_DATE} ${casTime}`);

        if (!commit) {
          console.log(`[${bogota()}]   DRY-RUN — would POST. Re-run with --commit.`);
          process.exit(0);
        }

        await client.refreshTokens();
        const ok = await client.reschedule(TARGET_CONSULAR_DATE, cTime, TARGET_CAS_DATE, casTime);
        if (ok) {
          console.log(`\n🎉 POST OK`);
          console.log(`  Old: ${lastConsularDate} ${lastConsularTime} | CAS ${lastCasDate} ${lastCasTime ?? ''}`);
          console.log(`  New: ${TARGET_CONSULAR_DATE} ${cTime} (gap=${newGap}min) | CAS ${TARGET_CAS_DATE} ${casTime}`);
          await db.update(bots).set({
            currentConsularDate: TARGET_CONSULAR_DATE,
            currentConsularTime: cTime,
            currentCasDate: TARGET_CAS_DATE,
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
            newConsularDate: TARGET_CONSULAR_DATE,
            newConsularTime: cTime,
            newCasDate: TARGET_CAS_DATE,
            newCasTime: casTime,
            success: true,
            provider: bot.proxyProvider,
          }).catch((e) => console.log(`rescheduleLogs insert failed: ${e instanceof Error ? e.message : e}`));

          // Update in-memory state
          lastConsularTime = cTime;
          lastCasDate = TARGET_CAS_DATE;
          lastCasTime = casTime;
          postedThisCycle = true;

          if (isAtTarget()) {
            console.log(`\n✅ TARGET REACHED — CAS=${TARGET_CAS_DATE} and gap=${currentGap()}min <= ${STOP_GAP_MINUTES}min. Exiting.`);
            process.exit(0);
          }
          console.log(`[${bogota()}]   secured at gap=${currentGap()}min, continuing to improve...`);
          break; // exit cTime loop, wait for next poll cycle
        }

        // POST failed
        console.log(`[${bogota()}]   POST returned false for ${cTime}`);
        if (cTime === lastConsularTime) {
          failedSameConsular = true;
          console.log(`[${bogota()}]   marking same-consular as failed; will skip ${cTime} in future polls`);
        }
      }

      if (!postedThisCycle && windowTimes.length > 0) {
        console.log(`[${bogota()}]   no improving combo this cycle`);
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

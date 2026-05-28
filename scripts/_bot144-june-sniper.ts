/**
 * Bot 144 — June 23+ sniper with ≤5-day CAS gap.
 *
 * Goal: land on any consular date >= 2026-06-23 where the CAS slot is:
 *   (a) >= 2026-06-23 (client + family available from that date only), AND
 *   (b) no more than 5 calendar days before the consular date.
 *
 * INTENTIONAL FORWARD MOVE — the strictly-earlier guard is bypassed
 * intentionally. The hard safety is: only dates >= CONSULAR_MIN are
 * accepted, so we can never accidentally land on an earlier date.
 *
 * Picks the earliest qualifying consular date first, then the earliest
 * qualifying CAS date for that consular date.
 *
 * Polls 3x/min (every 20s).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/_bot144-june-sniper.ts            # dry-run
 *   npx tsx --env-file=.env scripts/_bot144-june-sniper.ts --commit   # real POST
 */
import { db } from '../src/db/client.js';
import { bots, sessions, excludedDates, excludedTimes, pollLogs, rescheduleLogs } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '../src/services/encryption.js';
import { VisaClient, SessionExpiredError } from '../src/services/visa-client.js';
import { filterTimes } from '../src/utils/date-helpers.js';
import { performLogin } from '../src/services/login.js';
import type { ProxyProvider } from '../src/services/proxy-fetch.js';

const BOT_ID = 144;
const POLL_INTERVAL_MS = 20_000;       // 3 polls/min
const CONSULAR_MIN = '2026-06-23';     // earliest acceptable consular date
const CONSULAR_MAX = '2026-07-31';     // latest acceptable consular date (June + July only)
const CAS_MIN = '2026-06-23';          // earliest acceptable CAS date (family availability)
const MAX_CAS_GAP_DAYS = 5;            // CAS must be ≤5 days before consular

const args = process.argv.slice(2);
const commit = args.includes('--commit');

const bogota = (d = new Date()) =>
  new Date(d.getTime() - 5 * 3600_000).toISOString().slice(11, 19);

/** Returns true iff casDate is valid for the given consularDate. */
function casValid(consularDate: string, casDate: string): boolean {
  if (casDate < CAS_MIN) return false;
  const gapDays = Math.round(
    (new Date(consularDate).getTime() - new Date(casDate).getTime()) / 86_400_000,
  );
  // CAS must come before consular (gap ≥ 1) and within 5 days (gap ≤ 5)
  return gapDays >= 1 && gapDays <= MAX_CAS_GAP_DAYS;
}

// ── Load bot ──────────────────────────────────────────────────
const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!bot) { console.error(`Bot ${BOT_ID} not found`); process.exit(1); }

const [session] = await db.select().from(sessions).where(eq(sessions.botId, BOT_ID));
if (!session) { console.error(`No session for bot ${BOT_ID}. Run: npm run login -- --bot-id=${BOT_ID}`); process.exit(1); }

const exDates = await db.select().from(excludedDates).where(eq(excludedDates.botId, BOT_ID));
const dateExclusions = exDates.map(d => ({ startDate: d.startDate, endDate: d.endDate }));
const exTimes = await db.select().from(excludedTimes).where(eq(excludedTimes.botId, BOT_ID));
const timeExclusions = exTimes.map(t => ({ date: t.date, timeStart: t.timeStart, timeEnd: t.timeEnd }));

// ── Mutable best-slot state (updated on each successful reschedule) ────
let bestConsularDate: string = bot.currentConsularDate ?? CONSULAR_MAX;
let bestConsularTime: string | null = bot.currentConsularTime ?? null;
let bestCasDate: string | null = bot.currentCasDate ?? null;
let bestCasTime: string | null = bot.currentCasTime ?? null;
let rescheduleCount = bot.rescheduleCount ?? 0;
// secured = true once we hold a slot >= CONSULAR_MIN; until then upper bound = CONSULAR_MAX
let secured = bot.currentConsularDate != null && bot.currentConsularDate >= CONSULAR_MIN;

console.log('\n=== Bot 144 — June 23+ sniper (secure-then-improve, ≤5-day CAS gap) ===');
console.log(`Mode:     ${commit ? 'COMMIT (real reschedule)' : 'DRY-RUN (no POST)'}`);
console.log(`Interval: ${POLL_INTERVAL_MS / 1000}s (${60_000 / POLL_INTERVAL_MS} polls/min)`);
console.log(`Target:   consular ${CONSULAR_MIN}–${CONSULAR_MAX}, CAS >= ${CAS_MIN}, gap ≤ ${MAX_CAS_GAP_DAYS} days`);
console.log(`Strategy: secure first slot in range, then keep improving toward ${CONSULAR_MIN}`);
console.log(`Current:  consular ${bot.currentConsularDate} ${bot.currentConsularTime ?? ''} | CAS ${bot.currentCasDate} ${bot.currentCasTime ?? ''}`);
console.log(`Secured:  ${secured ? `yes (${bestConsularDate})` : 'no — first slot anywhere in range'}`);
console.log(`Schedule: ${bot.scheduleId} | locale ${bot.locale} | proxy ${bot.proxyProvider}`);
console.log(`Excluded: ${exDates.length} date ranges, ${exTimes.length} time windows\n`);

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

// ── Re-login helper ───────────────────────────────────────────
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

// ── Main loop ─────────────────────────────────────────────────
let pollCount = 0;
let lastReloginMs = Date.now();

while (true) {
  pollCount++;
  const iterStart = Date.now();

  // Pre-emptive re-login at 44min (half of ~1h28m session TTL)
  if (commit && Date.now() - lastReloginMs > 44 * 60_000) {
    try { await reLogin(); lastReloginMs = Date.now(); }
    catch (err) { console.log(`[${bogota()}] re-login failed: ${err instanceof Error ? err.message : err}`); }
  }

  try {
    const allDays = await client.getConsularDays();

    // Upper bound: before securing = CONSULAR_MAX; after securing = strictly earlier than current best
    const upperBound = secured ? bestConsularDate : CONSULAR_MAX;
    const candidates = allDays.filter(d => {
      if (d.date < CONSULAR_MIN) return false;
      if (secured ? d.date >= upperBound : d.date > upperBound) return false;
      if (dateExclusions.some(ex => d.date >= ex.startDate && d.date <= ex.endDate)) return false;
      return true;
    });

    const fetchMs = Date.now() - iterStart;
    const earliest = allDays[0]?.date ?? 'none';

    await db.insert(pollLogs).values({
      botId: BOT_ID,
      status: candidates.length > 0 ? 'ok' : 'filtered_out',
      earliestDate: allDays[0]?.date ?? null,
      datesCount: candidates.length,
      rawDatesCount: allDays.length,
      responseTimeMs: fetchMs,
      topDates: candidates.slice(0, 10).map(d => d.date),
      provider: bot.proxyProvider,
      pollPhase: 'manual_sniper_june23',
      chainId: 'dev',
      fetchIndex: pollCount,
      allDates: allDays.map(d => ({ date: d.date, business_day: d.business_day })),
    }).catch(e => console.log(`[${bogota()}]   pollLogs insert failed: ${e instanceof Error ? e.message : e}`));

    const phase = secured ? `improving (best=${bestConsularDate})` : 'securing';
    if (candidates.length === 0) {
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | total=${allDays.length} earliest=${earliest} | [${phase}] no candidates in [${CONSULAR_MIN}, ${upperBound}${secured ? ')' : ']'}`);
    } else {
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | 🎯 [${phase}] candidates (${candidates.length}): ${candidates.slice(0, 5).map(d => d.date).join(', ')}${candidates.length > 5 ? '...' : ''}`);

      let scheduled = false;
      outer: for (const cand of candidates) {
        const timesData = await client.getConsularTimes(cand.date);
        const consularTimes = filterTimes(
          cand.date,
          timesData.available_times?.filter((t): t is string => !!t) ?? [],
          timeExclusions,
        );
        if (consularTimes.length === 0) {
          console.log(`[${bogota()}]   ${cand.date}: no consular times`);
          continue;
        }
        console.log(`[${bogota()}]   ${cand.date} times: [${consularTimes.join(', ')}]`);

        for (const cTime of consularTimes) {
          const casDays = await client.getCasDays(cand.date, cTime);
          const validCasDays = casDays.filter(d => casValid(cand.date, d.date));

          if (validCasDays.length === 0) {
            const preview = casDays.slice(0, 4).map(d => d.date).join(',');
            console.log(`[${bogota()}]     ${cTime} → CAS days: [${preview}${casDays.length > 4 ? '...' : ''}] — none pass (>= ${CAS_MIN}, gap ≤ ${MAX_CAS_GAP_DAYS}d)`);
            continue;
          }

          const casDay = validCasDays[0]!;
          const casTimesData = await client.getCasTimes(casDay.date, cand.date, cTime);
          const casTimes = filterTimes(
            casDay.date,
            casTimesData.available_times?.filter((t): t is string => !!t) ?? [],
            timeExclusions,
          );
          if (casTimes.length === 0) {
            console.log(`[${bogota()}]     ${cTime} → CAS ${casDay.date} has no times — skip`);
            continue;
          }

          const gapDays = Math.round(
            (new Date(cand.date).getTime() - new Date(casDay.date).getTime()) / 86_400_000,
          );
          const casTime = casTimes[0]!;
          console.log(`[${bogota()}]     ✓ COMBO: consular ${cand.date} ${cTime} | CAS ${casDay.date} ${casTime} (gap ${gapDays}d)`);

          if (!commit) {
            console.log(`[${bogota()}]     DRY-RUN — would POST. Re-run with --commit.`);
            process.exit(0);
          }

          await client.refreshTokens();
          const ok = await client.reschedule(cand.date, cTime, casDay.date, casTime);
          if (ok) {
            const prevDate = bestConsularDate;
            console.log(`\n🎉 RESCHEDULE OK (#${rescheduleCount + 1})`);
            console.log(`  Old: consular ${prevDate} ${bestConsularTime ?? ''} | CAS ${bestCasDate ?? ''} ${bestCasTime ?? ''}`);
            console.log(`  New: consular ${cand.date} ${cTime} | CAS ${casDay.date} ${casTime} (gap ${gapDays}d)`);
            if (cand.date === CONSULAR_MIN) {
              console.log(`  ✅ Reached target ${CONSULAR_MIN} — optimal! Exiting.`);
            } else {
              console.log(`  Continuing to improve toward ${CONSULAR_MIN}...`);
            }
            await db.update(bots).set({
              currentConsularDate: cand.date,
              currentConsularTime: cTime,
              currentCasDate: casDay.date,
              currentCasTime: casTime,
              rescheduleCount: rescheduleCount + 1,
              updatedAt: new Date(),
            }).where(eq(bots.id, BOT_ID));
            await db.insert(rescheduleLogs).values({
              botId: BOT_ID,
              oldConsularDate: prevDate,
              oldConsularTime: bestConsularTime,
              oldCasDate: bestCasDate,
              oldCasTime: bestCasTime,
              newConsularDate: cand.date,
              newConsularTime: cTime,
              newCasDate: casDay.date,
              newCasTime: casTime,
              success: true,
              provider: bot.proxyProvider,
            }).catch(e => console.log(`rescheduleLogs insert failed: ${e instanceof Error ? e.message : e}`));
            // Update local state for next iteration
            bestConsularDate = cand.date;
            bestConsularTime = cTime;
            bestCasDate = casDay.date;
            bestCasTime = casTime;
            rescheduleCount += 1;
            secured = true;
            scheduled = true;
            if (cand.date === CONSULAR_MIN) process.exit(0);
            break outer;
          }
          console.log(`[${bogota()}]     POST returned false for ${cTime} — trying next time`);
        }
      }
      if (!scheduled) {
        console.log(`[${bogota()}]   all candidates exhausted for this poll, keep polling`);
      }
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

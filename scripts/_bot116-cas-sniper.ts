/**
 * Bot 116 — CAS sniper.
 *
 * Goal: move CAS to 2026-04-29 (time >= 08:30) OR 2026-04-30 (any time).
 *
 * Strategy:
 * - The goal is the CAS date — consular can land on or after current (05-07).
 *   Critical "strictly earlier" rule is bypassed for this script.
 * - Consular range derived from CAS window (1-8 days before consular):
 *     CAS=04-29 → consular in [04-30, 05-07]
 *     CAS=04-30 → consular in [05-01, 05-08]
 *   Union: [04-30, 05-08].
 * - Iterates candidates in chronological order (API default), so earlier
 *   consular dates are tried first.
 *
 * Polls 2x/minute (every 30s) indefinitely.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/_bot116-cas-sniper.ts            # dry-run
 *   npx tsx --env-file=.env scripts/_bot116-cas-sniper.ts --commit   # real reschedule
 */
import { db } from '../src/db/client.js';
import { bots, sessions, excludedDates, excludedTimes } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '../src/services/encryption.js';
import { VisaClient, SessionExpiredError } from '../src/services/visa-client.js';
import { filterTimes } from '../src/utils/date-helpers.js';
import { performLogin } from '../src/services/login.js';
import type { ProxyProvider } from '../src/services/proxy-fetch.js';

const BOT_ID = 116;
const POLL_INTERVAL_MS = 30_000;            // 2 polls/min
const CONSULAR_MIN = '2026-04-30';
const CONSULAR_MAX = '2026-05-08';          // CAS=04-30 needs consular up to 05-08
const ALLOWED_CAS_DATES = new Set(['2026-04-29', '2026-04-30']);
const CAS_29_MIN_TIME = '08:30';            // for 04-29 only
const args = process.argv.slice(2);
const commit = args.includes('--commit');

const bogota = (d = new Date()) =>
  new Date(d.getTime() - 5 * 3600_000).toISOString().slice(11, 19);

console.log('\n=== Bot 116 — CAS sniper ===');
console.log(`Mode:     ${commit ? 'COMMIT (real reschedule)' : 'DRY-RUN (no POST)'}`);
console.log(`Interval: ${POLL_INTERVAL_MS / 1000}s (${60_000 / POLL_INTERVAL_MS} polls/min)`);
console.log(`Goal:     CAS on 2026-04-29 (>= ${CAS_29_MIN_TIME}) OR 2026-04-30 (any time)`);
console.log(`Consular: ${CONSULAR_MIN} to ${CONSULAR_MAX} (strict-earlier bypassed — CAS time fix is the goal)\n`);

const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!bot) { console.error('Bot 116 not found'); process.exit(1); }
let [session] = await db.select().from(sessions).where(eq(sessions.botId, BOT_ID));
if (!session) { console.error('No session. Run: npm run login -- --bot-id=116'); process.exit(1); }

const exDates = await db.select().from(excludedDates).where(eq(excludedDates.botId, BOT_ID));
const dateExclusions = exDates.map(d => ({ startDate: d.startDate, endDate: d.endDate }));
const exTimes = await db.select().from(excludedTimes).where(eq(excludedTimes.botId, BOT_ID));
const timeExclusions = exTimes.map(t => ({ date: t.date, timeStart: t.timeStart, timeEnd: t.timeEnd }));

console.log(`Current consular: ${bot.currentConsularDate} ${bot.currentConsularTime ?? ''}`);
console.log(`Current CAS:      ${bot.currentCasDate} ${bot.currentCasTime ?? ''}\n`);

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

function casPasses(casDate: string, casTime: string): boolean {
  if (!ALLOWED_CAS_DATES.has(casDate)) return false;
  if (casDate === '2026-04-29' && casTime < CAS_29_MIN_TIME) return false;
  return true;
}

let pollCount = 0;
let lastReloginMs = Date.now();

while (true) {
  pollCount++;
  const iterStart = Date.now();

  if (commit && Date.now() - lastReloginMs > 44 * 60_000) {
    try { await reLogin(); lastReloginMs = Date.now(); }
    catch (err) { console.log(`[${bogota()}] re-login failed: ${err instanceof Error ? err.message : err}`); }
  }

  try {
    const allDays = await client.getConsularDays();
    // Apply: dateExclusions + must be in window. NO strict-earlier (goal is CAS).
    const candidates = allDays.filter(d => {
      if (d.date < CONSULAR_MIN || d.date > CONSULAR_MAX) return false;
      if (dateExclusions.some(ex => d.date >= ex.startDate && d.date <= ex.endDate)) return false;
      return true;
    });

    const fetchMs = Date.now() - iterStart;
    const earliest = allDays[0]?.date ?? 'none';

    if (candidates.length === 0) {
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | total=${allDays.length} earliest=${earliest} | no candidates in [${CONSULAR_MIN},${CONSULAR_MAX}]`);
    } else {
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | 🎯 candidates: ${candidates.map(c => c.date).join(', ')}`);

      // Try each candidate consular date
      let scheduled = false;
      outer: for (const cand of candidates) {
        const timesData = await client.getConsularTimes(cand.date);
        const consularTimes = filterTimes(cand.date, timesData.available_times?.filter((t): t is string => !!t) ?? [], timeExclusions);
        if (consularTimes.length === 0) {
          console.log(`[${bogota()}]   ${cand.date}: no consular times`);
          continue;
        }
        console.log(`[${bogota()}]   ${cand.date} times: ${consularTimes.join(', ')}`);

        for (const cTime of consularTimes) {
          const casDays = await client.getCasDays(cand.date, cTime);
          // Only keep CAS dates we want
          const validCasDays = casDays.filter(d => ALLOWED_CAS_DATES.has(d.date));
          if (validCasDays.length === 0) {
            console.log(`[${bogota()}]     ${cTime} → CAS days: ${casDays.map(d => d.date).slice(0, 5).join(',')}... — none match 04-29/04-30`);
            continue;
          }

          // Prefer 04-30 (any time) over 04-29 (time-restricted)
          const preferred = validCasDays.find(d => d.date === '2026-04-30') ?? validCasDays[0]!;
          const casTimesData = await client.getCasTimes(preferred.date, cand.date, cTime);
          const casTimes = filterTimes(preferred.date, casTimesData.available_times?.filter((t): t is string => !!t) ?? [], timeExclusions);
          // Apply time gate for 04-29
          const validCasTimes = casTimes.filter(t => casPasses(preferred.date, t));
          if (validCasTimes.length === 0) {
            console.log(`[${bogota()}]     ${cTime} → CAS ${preferred.date} times: ${casTimes.join(',') || '(none)'} — none pass gate`);
            continue;
          }
          // Pick the EARLIEST valid CAS time (lexically smallest passing time)
          const casTime = validCasTimes.sort()[0]!;
          console.log(`[${bogota()}]     ✓ COMBO: consular ${cand.date} ${cTime} | CAS ${preferred.date} ${casTime}`);

          if (!commit) {
            console.log(`[${bogota()}]     DRY-RUN — would POST. Run with --commit to actually reschedule.`);
            process.exit(0);
          }

          await client.refreshTokens();
          const ok = await client.reschedule(cand.date, cTime, preferred.date, casTime);
          if (ok) {
            console.log(`\n🎉 RESCHEDULE OK`);
            console.log(`  Old: consular ${bot.currentConsularDate} ${bot.currentConsularTime ?? ''} | CAS ${bot.currentCasDate} ${bot.currentCasTime ?? ''}`);
            console.log(`  New: consular ${cand.date} ${cTime} | CAS ${preferred.date} ${casTime}`);
            await db.update(bots).set({
              currentConsularDate: cand.date,
              currentConsularTime: cTime,
              currentCasDate: preferred.date,
              currentCasTime: casTime,
              rescheduleCount: (bot.rescheduleCount ?? 0) + 1,
              updatedAt: new Date(),
            }).where(eq(bots.id, BOT_ID));
            scheduled = true;
            break outer;
          }
          console.log(`[${bogota()}]     POST returned false — trying next time`);
        }
      }
      if (scheduled) {
        console.log('DB updated. Exiting.');
        process.exit(0);
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

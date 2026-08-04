/**
 * Bot 109 — June 2026 sniper.
 *
 * INTENTIONAL FORWARD MOVE: bot 109 currently holds 2026-05-07. The owner
 * wants a *later* date (June 2026) because May is too close. This script
 * deliberately bypasses the "strictly earlier" guard — only allows dates
 * matching ^2026-06- so it can never accidentally land on a different month.
 *
 * Polls 2x/minute (every 30s) indefinitely. On the first successful POST
 * it updates DB and exits.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/_bot109-june-sniper.ts            # dry-run
 *   npx tsx --env-file=.env scripts/_bot109-june-sniper.ts --commit   # real reschedule
 */
import { db } from '../src/db/client.js';
import { bots, sessions, excludedDates, excludedTimes } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '../src/services/encryption.js';
import { VisaClient, SessionExpiredError } from '../src/services/visa-client.js';
import { filterDates, filterTimes, addDays } from '../src/utils/date-helpers.js';
import { MIN_DAYS_FROM_TODAY } from '../src/utils/constants.js';
import { performLogin } from '../src/services/login.js';
import type { ProxyProvider } from '../src/services/proxy-fetch.js';

const BOT_ID = 109;
const POLL_INTERVAL_MS = 30_000;          // 2 polls/min
const TARGET_MONTH_PREFIX = '2026-06-';   // hard filter — only June 2026
const args = process.argv.slice(2);
const commit = args.includes('--commit');

const bogota = (d = new Date()) =>
  new Date(d.getTime() - 5 * 3600_000).toISOString().slice(11, 19);

console.log('\n=== Bot 109 — June 2026 sniper ===');
console.log(`Mode:     ${commit ? 'COMMIT (real reschedule)' : 'DRY-RUN (no POST)'}`);
console.log(`Interval: ${POLL_INTERVAL_MS / 1000}s (${60_000 / POLL_INTERVAL_MS} polls/min)`);
console.log(`Target:   any date matching ${TARGET_MONTH_PREFIX}*`);
console.log(`Note:     this is a forward move (May 7 → June). May 7 slot will be lost.\n`);

// ── Load bot + session ─────────────────────────────────────────
const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!bot) { console.error('Bot 109 not found'); process.exit(1); }

let [session] = await db.select().from(sessions).where(eq(sessions.botId, BOT_ID));
if (!session) { console.error('No session for bot 109. Run: npm run login -- --bot-id=109'); process.exit(1); }

const exDates = await db.select().from(excludedDates).where(eq(excludedDates.botId, BOT_ID));
const dateExclusions = exDates.map(d => ({ startDate: d.startDate, endDate: d.endDate }));
const exTimes = await db.select().from(excludedTimes).where(eq(excludedTimes.botId, BOT_ID));
const timeExclusions = exTimes.map(t => ({ date: t.date, timeStart: t.timeStart, timeEnd: t.timeEnd }));

console.log(`Current consular: ${bot.currentConsularDate} ${bot.currentConsularTime ?? ''}`);
console.log(`Schedule:         ${bot.scheduleId} | locale ${bot.locale} | proxy ${bot.proxyProvider}`);
console.log(`Excluded dates:   ${exDates.length} | excluded times: ${exTimes.length}\n`);

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
  const minDate = addDays(new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Bogota' }), bot.minDaysFromToday ?? MIN_DAYS_FROM_TODAY);

  // Pre-emptive re-login at 44min (half of 1h28m TTL)
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
    const juneDates = filtered.filter(d => d.date.startsWith(TARGET_MONTH_PREFIX));

    const fetchMs = Date.now() - iterStart;
    const earliest = filtered[0]?.date ?? 'none';

    if (juneDates.length === 0) {
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | total=${allDays.length} earliest=${earliest} | no June dates`);
    } else {
      const target = juneDates[0]!.date;
      console.log(`[${bogota()}] #${pollCount} | ${fetchMs}ms | 🎯 JUNE FOUND: ${juneDates.map(d => d.date).join(', ')}`);

      // ── Try every consular time for the target June date ─────
      const timesData = await client.getConsularTimes(target);
      const consularTimes = filterTimes(target, timesData.available_times, timeExclusions);
      console.log(`[${bogota()}]   times for ${target}: ${consularTimes.join(', ') || '(none)'}`);

      let scheduled = false;
      for (const cTime of consularTimes) {
        const casDays = await client.getCasDays(target, cTime);
        const filteredCas = filterDates(casDays, dateExclusions, undefined, minDate);
        if (filteredCas.length === 0) {
          console.log(`[${bogota()}]   ${cTime} → no CAS days, next time`);
          continue;
        }
        const casDate = filteredCas[0]!.date;
        const casTimesData = await client.getCasTimes(casDate, target, cTime);
        const casTimes = filterTimes(casDate, casTimesData.available_times, timeExclusions);
        if (casTimes.length === 0) {
          console.log(`[${bogota()}]   ${cTime} → CAS ${casDate} has no times, next`);
          continue;
        }
        const casTime = casTimes[0]!;
        console.log(`[${bogota()}]   ✓ COMBO: consular ${target} ${cTime} | CAS ${casDate} ${casTime}`);

        if (!commit) {
          console.log(`[${bogota()}]   DRY-RUN — would POST. Run with --commit to actually reschedule.`);
          process.exit(0);
        }

        // Prime server-side state before POST
        await client.refreshTokens();
        const ok = await client.reschedule(target, cTime, casDate, casTime);
        if (ok) {
          console.log(`\n🎉 RESCHEDULE OK`);
          console.log(`  Old: ${bot.currentConsularDate} ${bot.currentConsularTime ?? ''}`);
          console.log(`  New: ${target} ${cTime} | CAS ${casDate} ${casTime}`);
          await db.update(bots).set({
            currentConsularDate: target,
            currentConsularTime: cTime,
            currentCasDate: casDate,
            currentCasTime: casTime,
            rescheduleCount: (bot.rescheduleCount ?? 0) + 1,
            updatedAt: new Date(),
          }).where(eq(bots.id, BOT_ID));
          console.log('DB updated. Exiting.');
          scheduled = true;
          process.exit(0);
        }
        console.log(`[${bogota()}]   POST returned false for ${cTime} — trying next time`);
      }
      if (!scheduled) {
        console.log(`[${bogota()}]   all times exhausted for ${target}, will keep polling`);
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

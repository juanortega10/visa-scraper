/**
 * Bot 212 — Jun 15 to Jul 15, 2026 consular-window sniper (WITH CAS, runs on RPi).
 *
 * Context: the applicant CANNOT attend Jun 21–24 (the current consular date, Jun 23,
 * is inside that blocked range). We want ANY consular slot in [2026-06-15, 2026-07-15]
 * OUTSIDE 2026-06-21..2026-06-24. Because the current date sits inside the window but
 * is unattendable, the first move may go FORWARD (e.g. to July) — that is authorized:
 * the blocked range is useless to the applicant.
 *
 * BOTH appointments (consular AND CAS) must land inside the window, outside the blocked
 * range. Since CAS must be 1–8 days BEFORE the consular, the earliest feasible consular
 * is Jun 16 (with CAS Jun 15) — a Jun 15 consular has no in-window CAS and is skipped.
 *
 * Two phases:
 *   PHASE 1 (current combo NOT both-in-range, e.g. CAS before Jun 15): secure ANY valid
 *           both-in-range combo, even moving the consular FORWARD. Authorized.
 *   PHASE 2 (current combo both-in-range): only take a strictly EARLIER consular that
 *           still has an in-window CAS. Keeps improving. Never self-exits; runs 24/7.
 *
 * The blocked range lives in the bots' excluded_dates table, so filterDates() drops it
 * from BOTH consular and CAS candidates (and it stays auditable in the DB).
 *
 * CAS: this account has biometrics (asc 26). For each consular candidate we fetch CAS
 * days and pick one that is 1–8 days before the consular AND inside the window (closest
 * first). A consular with no in-window CAS is skipped.
 *
 * Proxy: forced to `direct` — webshare on sustained es-co polling → account block
 * in ~20min (see CLAUDE.md). Login is always direct anyway.
 *
 * Auditable: writes poll_logs (pollPhase='manual_sniper') and reschedule_logs, the
 * same tables the dashboard reads → visible at /dashboard/212.
 *
 * Usage on RPi (systemd: scripts/bot212-sniper.service):
 *   cd /home/agetrox/visa-scraper
 *   nohup npx tsx --env-file=.env scripts/_bot212-jun-jul-sniper.ts --commit > /tmp/bot212-sniper.log 2>&1 &
 *
 * Dry-run anywhere:
 *   npx tsx --env-file=.env scripts/_bot212-jun-jul-sniper.ts
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

const BOT_ID = 212;
const POLL_INTERVAL_MS = 20_000;        // 3 polls/min — polite on the shared RPi IP
const WINDOW_START = '2026-06-15';      // inclusive
const WINDOW_END   = '2026-07-15';      // inclusive
// Blocked range (applicant cannot attend) lives in the bots' excluded_dates table —
// currently 2026-06-21..2026-06-24. filterDates() drops it from BOTH consular and CAS
// candidates; isExcluded() (below) applies the same ranges to the phase logic.
const CAS_GAP_MAX_DAYS = 8;             // CAS must be 1..8 days before consular

const commit = process.argv.includes('--commit');

const bogota = (d = new Date()) =>
  new Date(d.getTime() - 5 * 3600_000).toISOString().slice(11, 19);

let [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!bot) { console.error(`Bot ${BOT_ID} not found`); process.exit(1); }

const [session0] = await db.select().from(sessions).where(eq(sessions.botId, BOT_ID));
if (!session0) { console.error(`No session for bot ${BOT_ID}. Activate it once to seed a session.`); process.exit(1); }

const exDates = await db.select().from(excludedDates).where(eq(excludedDates.botId, BOT_ID));
const dateExclusions = exDates.map(d => ({ startDate: d.startDate, endDate: d.endDate }));
const exTimes = await db.select().from(excludedTimes).where(eq(excludedTimes.botId, BOT_ID));
const timeExclusions = exTimes.map(t => ({ date: t.date, timeStart: t.timeStart, timeEnd: t.timeEnd }));

// Blocked if it falls inside any excluded_dates range (e.g. 2026-06-21..2026-06-24).
const isExcluded = (d: string) => dateExclusions.some(r => d >= r.startDate && d <= r.endDate);
// Acceptable consular slot: within the window AND not in a blocked range.
const acceptable = (d: string) => d >= WINDOW_START && d <= WINDOW_END && !isExcluded(d);
const daysBetween = (a: string, b: string) =>
  Math.round((new Date(a).getTime() - new Date(b).getTime()) / 864e5);

console.log('\n=== Bot 212 — Jun 15–Jul 15, 2026 sniper (CAS) ===');
console.log(`Mode:     ${commit ? 'COMMIT (real reschedule — first POST may move FORWARD off the blocked range)' : 'DRY-RUN (no POST)'}`);
console.log(`Interval: ${POLL_INTERVAL_MS / 1000}s`);
console.log(`Window:   [${WINDOW_START} .. ${WINDOW_END}]`);
console.log(`Blocked:  ${exDates.map(d => d.startDate === d.endDate ? d.startDate : `${d.startDate}..${d.endDate}`).join(', ') || '(none)'}`);
console.log(`Current:  consular ${bot.currentConsularDate} ${bot.currentConsularTime ?? ''} | CAS ${bot.currentCasDate ?? '(none)'} ${bot.currentCasTime ?? ''}`);
console.log(`Proxy:    direct (overriding bot.proxyProvider=${bot.proxyProvider})\n`);

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
// TCP-block backoff (mirrors poll-visa.ts): consecutive "other side closed" /
// "fetch failed" errors mean the embassy is TCP-resetting us. Retrying every 20s
// ESCALATES the ban (CLAUDE.md), so back off hard: 3-4 fails → 10m, 5+ → 30m.
let tcpBlockCount = 0;
const TCP_BACKOFF_MS = (n: number) => (n >= 5 ? 30 * 60_000 : n >= 3 ? 10 * 60_000 : 0);
const isTcpBlock = (e: unknown) => {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  const cause = ((e as { cause?: { code?: string; message?: string } })?.cause);
  const cm = `${cause?.code ?? ''} ${cause?.message ?? ''}`.toLowerCase();
  return m.includes('fetch failed') || m.includes('other side closed')
    || cm.includes('und_err_socket') || cm.includes('other side closed');
};

while (true) {
  pollCount++;
  const iterStart = Date.now();

  // Reload bot each iteration — currentConsularDate is updated by us after each POST.
  [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
  if (!bot) { console.error('Bot disappeared'); process.exit(1); }

  const current = bot.currentConsularDate!;
  const currentCas = bot.currentCasDate;
  // BOTH appointments must land in the window (outside the blocked range). The current
  // state is "satisfied" only if consular AND CAS are both acceptable. If not (e.g. CAS
  // before WINDOW_START), Phase 1 secures any valid both-in-range combo — even moving the
  // consular FORWARD. Once satisfied, Phase 2 only improves to an earlier consular.
  // No self-exit: run 24/7 and keep holding the best valid combo.
  const currentSatisfied = acceptable(current) && !!currentCas && acceptable(currentCas);
  const phase = currentSatisfied ? `P2(<${current})` : 'P1(secure-both-in-range)';

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

    // Acceptable consular candidates: in window, outside the blocked range.
    // Phase 2 (already satisfied) additionally requires strictly earlier than current.
    const candidates = filtered.filter(d =>
      acceptable(d.date) && (!currentSatisfied || d.date < current),
    );

    const fetchMs = Date.now() - iterStart;
    const earliest = filtered[0]?.date ?? 'none';

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
      console.log(`[${bogota()}] #${pollCount} ${phase} | ${fetchMs}ms | total=${allDays.length} earliest=${earliest} | no window candidates`);
    } else {
      console.log(`[${bogota()}] #${pollCount} ${phase} | ${fetchMs}ms | 🎯 ${candidates.length} candidates: [${candidates.slice(0, 8).map(d => d.date).join(', ')}${candidates.length > 8 ? ', ...' : ''}]`);

      let posted = false;
      outer: for (const cand of candidates) {       // earliest first
        const timesData = await client.getConsularTimes(cand.date);
        const consularTimes = filterTimes(cand.date, timesData.available_times, timeExclusions);
        if (consularTimes.length === 0) { console.log(`[${bogota()}]   ${cand.date}: no consular times`); continue; }

        for (const cTime of consularTimes) {
          // Find a CAS day that is (a) 1..8 days before this consular date AND
          // (b) itself inside the window [WINDOW_START, WINDOW_END] outside the blocked
          // range — both appointments must be in range. Closest-to-consular first.
          const casDays = await client.getCasDays(cand.date, cTime);
          const casFiltered = filterDates(casDays, dateExclusions, undefined, minDate)
            .filter(c => {
              const gap = daysBetween(cand.date, c.date);
              return gap >= 1 && gap <= CAS_GAP_MAX_DAYS && acceptable(c.date);
            })
            .sort((a, b) => (a.date < b.date ? 1 : -1));  // closest-to-consular first

          let casPicked: { date: string; time: string } | null = null;
          for (const cas of casFiltered) {
            const casTimesData = await client.getCasTimes(cas.date, cand.date, cTime);
            const casTimes = filterTimes(cas.date, casTimesData.available_times, timeExclusions);
            if (casTimes.length > 0) { casPicked = { date: cas.date, time: casTimes[0]! }; break; }
          }
          if (!casPicked) { console.log(`[${bogota()}]   ${cand.date} ${cTime}: no in-window CAS in 1-${CAS_GAP_MAX_DAYS}d gap`); continue; }

          console.log(`[${bogota()}]   ✓ COMBO: consular ${cand.date} ${cTime} | CAS ${casPicked.date} ${casPicked.time}`);

          if (!commit) {
            console.log(`[${bogota()}]   DRY-RUN — would POST. Re-run with --commit.`);
            process.exit(0);
          }

          await client.refreshTokens();
          const ok = await client.reschedule(cand.date, cTime, casPicked.date, casPicked.time);
          if (!ok) {
            console.log(`[${bogota()}]   POST returned false for ${cand.date} ${cTime} — next`);
            continue;
          }

          // POST redirect chain said success — VERIFY against the live portal before
          // committing. The redirect chain has documented false positives (slot taken
          // by someone else in the same instant; server silently rejects). Mirrors
          // reschedule-logic.ts: re-read the real appointment and confirm BOTH the
          // consular AND CAS dates actually changed to what we asked for.
          let verified = false;
          try {
            const live = await client.getCurrentAppointment();
            verified = !!live
              && live.consularDate === cand.date
              && live.casDate === casPicked.date;
            if (!verified) {
              console.log(`[${bogota()}]   ⚠️ FALSE POSITIVE: POST ok but portal shows consular=${live?.consularDate ?? 'null'} CAS=${live?.casDate ?? 'null'} (wanted ${cand.date}/${casPicked.date}) — NOT committing`);
              await db.insert(rescheduleLogs).values({
                botId: BOT_ID,
                oldConsularDate: current, oldConsularTime: bot.currentConsularTime,
                oldCasDate: bot.currentCasDate, oldCasTime: bot.currentCasTime,
                newConsularDate: cand.date, newConsularTime: cTime,
                newCasDate: casPicked.date, newCasTime: casPicked.time,
                success: false, error: 'false_positive_verification', provider: 'direct',
              }).catch((e) => console.log(`rescheduleLogs insert failed: ${e instanceof Error ? e.message : e}`));
            }
          } catch (e) {
            // Could not verify — do NOT assume success (the whole point of this fix).
            console.log(`[${bogota()}]   verification fetch failed (${e instanceof Error ? e.message : e}) — NOT committing, will retry`);
            verified = false;
          }

          if (verified) {
            console.log(`\n🎉 RESCHEDULE VERIFIED ON PORTAL`);
            console.log(`  Old: ${current} ${bot.currentConsularTime} | CAS ${bot.currentCasDate} ${bot.currentCasTime ?? ''}`);
            console.log(`  New: ${cand.date} ${cTime} | CAS ${casPicked.date} ${casPicked.time}`);
            await db.update(bots).set({
              currentConsularDate: cand.date,
              currentConsularTime: cTime,
              currentCasDate: casPicked.date,
              currentCasTime: casPicked.time,
              rescheduleCount: (bot.rescheduleCount ?? 0) + 1,
              updatedAt: new Date(),
            }).where(eq(bots.id, BOT_ID));
            await db.insert(rescheduleLogs).values({
              botId: BOT_ID,
              oldConsularDate: current,
              oldConsularTime: bot.currentConsularTime,
              oldCasDate: bot.currentCasDate,
              oldCasTime: bot.currentCasTime,
              newConsularDate: cand.date,
              newConsularTime: cTime,
              newCasDate: casPicked.date,
              newCasTime: casPicked.time,
              success: true,
              provider: 'direct',
            }).catch((e) => console.log(`rescheduleLogs insert failed: ${e instanceof Error ? e.message : e}`));
            posted = true;
            break outer;
          }
          // Not verified → treat this slot as taken; move on to next time/candidate.
          continue;
        }
      }
      if (!posted) console.log(`[${bogota()}]   candidates exhausted this poll, will retry`);
    }
    tcpBlockCount = 0; // reached here without throwing → connection healthy, reset backoff
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      console.log(`[${bogota()}] #${pollCount} | session expired — re-logging`);
      tcpBlockCount = 0;
      try { await reLogin(); lastReloginMs = Date.now(); }
      catch (e) { console.log(`[${bogota()}] re-login failed: ${e instanceof Error ? e.message : e}`); }
    } else if (isTcpBlock(err)) {
      tcpBlockCount++;
      console.log(`[${bogota()}] #${pollCount} | TCP block (other side closed) — consecutive=${tcpBlockCount}`);
    } else {
      console.log(`[${bogota()}] #${pollCount} | ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const elapsed = Date.now() - iterStart;
  const backoff = TCP_BACKOFF_MS(tcpBlockCount);
  if (backoff > 0) {
    console.log(`[${bogota()}]   backing off ${backoff / 60_000}m (tcpBlockCount=${tcpBlockCount}) — not hammering the block`);
    await new Promise(r => setTimeout(r, backoff));
  } else {
    const sleep = Math.max(0, POLL_INTERVAL_MS - elapsed);
    if (sleep > 0) await new Promise(r => setTimeout(r, sleep));
  }
}

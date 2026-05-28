/**
 * Dual-bot 3-phase sniper for bot 140 + bot 141 family alignment.
 *
 * Goal:
 *   1. Both bots' CAS ∈ [CAS_START, CAS_END]
 *   2. Both bots same consular date
 *   3. Consular times within GAP_LIMIT minutes
 *
 * Phases auto-detect from in-memory state:
 *   PHASE_1: any bot CAS not in window → each bot looks for any valid combo
 *   PHASE_2: both in window, different dates → laggard aligns to anchor (earlier)
 *   PHASE_3: same date, gap > limit → laggard aligns time within ±limit
 *   DONE   : same date, gap ≤ limit → exit
 *
 * Every POST is atomic (consular + CAS together). Each candidate is rejected
 * if applying it would lose any HARD constraint (CAS in window, anchor date, etc.).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/_dual-sniper.ts            # dry-run
 *   npx tsx --env-file=.env scripts/_dual-sniper.ts --commit   # real POSTs
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

// ── Configuration ─────────────────────────────────────────────
const BOT_IDS = [140, 141] as const;
const CAS_START = '2026-05-19';
const CAS_END   = '2026-05-22';
const GAP_LIMIT_MIN = 15;         // Phase 3 target
const POLL_INTERVAL_MS = 30_000;  // 30s between cycles (each cycle polls both bots)

const commit = process.argv.slice(2).includes('--commit');

const bogota = (d = new Date()) =>
  new Date(d.getTime() - 5 * 3600_000).toISOString().slice(11, 19);

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const inCasWindow = (d: string | null) => !!d && d >= CAS_START && d <= CAS_END;

// ── Explicit projection — avoids agency_id drift ──────────────
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

type BotRow = typeof botCols extends Record<string, infer V> ? { [K in keyof typeof botCols]: NonNullable<V> extends { _: { data: infer D } } ? D : unknown } : never;
type BotData = Awaited<ReturnType<typeof db.select<typeof botCols>>>[number];

const COOLDOWN_THRESHOLD = 5;          // consecutive errors before cooldown
const COOLDOWN_MS = 6 * 60 * 60_000;  // 6 hours

interface BotState {
  id: number;
  bot: BotData;
  client: VisaClient;
  dateExclusions: { startDate: string; endDate: string }[];
  timeExclusions: { date: string | null; timeStart: string | null; timeEnd: string | null }[];
  // mutable state — updated after each successful POST
  lastConsularDate: string;
  lastConsularTime: string;
  lastCasDate: string | null;
  lastCasTime: string | null;
  rescheduleCount: number;
  lastReloginMs: number;
  consecutiveErrors: number;
  cooldownUntilMs: number;
}

const state: Map<number, BotState> = new Map();

// ── Initialize both bots ──────────────────────────────────────
for (const id of BOT_IDS) {
  const [bot] = await db.select(botCols).from(bots).where(eq(bots.id, id));
  if (!bot) { console.error(`Bot ${id} not found`); process.exit(1); }
  const [session] = await db.select().from(sessions).where(eq(sessions.botId, id));
  if (!session) { console.error(`No session for bot ${id}`); process.exit(1); }
  const exD = await db.select().from(excludedDates).where(eq(excludedDates.botId, id));
  const exT = await db.select().from(excludedTimes).where(eq(excludedTimes.botId, id));

  const client = new VisaClient(
    {
      cookie: decrypt(session.yatriCookie),
      csrfToken: session.csrfToken ?? '',
      authenticityToken: session.authenticityToken ?? '',
    },
    {
      scheduleId: bot.scheduleId,
      applicantIds: bot.applicantIds,
      consularFacilityId: bot.consularFacilityId,
      ascFacilityId: bot.ascFacilityId,
      proxyProvider: (bot.proxyProvider ?? 'direct') as ProxyProvider,
      userId: bot.userId,
      locale: bot.locale,
    },
  );

  state.set(id, {
    id,
    bot,
    client,
    dateExclusions: exD.map(d => ({ startDate: d.startDate, endDate: d.endDate })),
    timeExclusions: exT.map(t => ({ date: t.date, timeStart: t.timeStart, timeEnd: t.timeEnd })),
    lastConsularDate: bot.currentConsularDate!,
    lastConsularTime: bot.currentConsularTime!,
    lastCasDate: bot.currentCasDate,
    lastCasTime: bot.currentCasTime,
    rescheduleCount: bot.rescheduleCount ?? 0,
    lastReloginMs: Date.now(),
    consecutiveErrors: 0,
    cooldownUntilMs: 0,
  });
}

console.log(`\n=== Dual-bot sniper — bot 140 + 141 family alignment ===`);
console.log(`Mode:     ${commit ? 'COMMIT' : 'DRY-RUN'}`);
console.log(`Interval: ${POLL_INTERVAL_MS / 1000}s per bot per cycle (${(60_000 / POLL_INTERVAL_MS).toFixed(1)} cycles/min)`);
console.log(`Target:   CAS ∈ [${CAS_START}, ${CAS_END}], same consular date, gap ≤ ${GAP_LIMIT_MIN}min`);
for (const id of BOT_IDS) {
  const s = state.get(id)!;
  console.log(`  Bot ${id}: consular ${s.lastConsularDate} ${s.lastConsularTime} | CAS ${s.lastCasDate} ${s.lastCasTime ?? ''} (CAS in window: ${inCasWindow(s.lastCasDate) ? 'YES' : 'no'})`);
}
console.log('');

// ── Phase detection ────────────────────────────────────────────
type Phase = 'PHASE_1' | 'PHASE_2' | 'PHASE_3' | 'DONE';

function detectPhase(): Phase {
  const arr = BOT_IDS.map(id => state.get(id)!);
  const allInWindow = arr.every(s => inCasWindow(s.lastCasDate));
  if (!allInWindow) return 'PHASE_1';
  const sameDate = arr[0]!.lastConsularDate === arr[1]!.lastConsularDate;
  if (!sameDate) return 'PHASE_2';
  const gap = Math.abs(toMin(arr[0]!.lastConsularTime) - toMin(arr[1]!.lastConsularTime));
  if (gap > GAP_LIMIT_MIN) return 'PHASE_3';
  return 'DONE';
}

// ── Target computation per bot per phase ───────────────────────
interface Target {
  /** Required consular date. null = any. */
  consularDate: string | null;
  /** Window for consular time around target. null = any time, undefined = no constraint */
  consularTimeAnchor?: string;
  consularTimeWindowMin?: number;
  /** Required CAS date range */
  casStart: string;
  casEnd: string;
  /** Improvement check — only POST if new is strictly better than current */
  requireConsularEarlierThanCurrent?: boolean;
}

function getTarget(bot: BotState, phase: Phase, peer: BotState): Target | null {
  // No-op if this bot already satisfies the phase's requirements
  switch (phase) {
    case 'PHASE_1': {
      if (inCasWindow(bot.lastCasDate)) {
        // already secured — improve only (earlier consular)
        return {
          consularDate: null,
          casStart: CAS_START, casEnd: CAS_END,
          requireConsularEarlierThanCurrent: true,
        };
      }
      // not secured — any combo with CAS in window
      return {
        consularDate: null,
        casStart: CAS_START, casEnd: CAS_END,
      };
    }
    case 'PHASE_2': {
      // peer is the anchor (earlier consular date)
      const anchor = peer.lastConsularDate < bot.lastConsularDate ? peer : bot;
      if (bot.id === anchor.id) return null; // we are the anchor, stay put
      return {
        consularDate: anchor.lastConsularDate,
        casStart: CAS_START, casEnd: CAS_END,
      };
    }
    case 'PHASE_3': {
      // both same date. Pick anchor = the one closer to the middle? Use peer's time as anchor.
      // Whoever has lower applicantIds count is more flexible — bot 141 (2 aplicantes).
      // Simpler: keep the one with current time, target the other.
      // Anchor: bot whose consular time stays. Pick peer arbitrarily.
      const anchor = peer; // arbitrary but stable
      if (bot.id === anchor.id) return null;
      return {
        consularDate: anchor.lastConsularDate,
        consularTimeAnchor: anchor.lastConsularTime,
        consularTimeWindowMin: GAP_LIMIT_MIN,
        casStart: CAS_START, casEnd: CAS_END,
      };
    }
    case 'DONE':
      return null;
  }
}

// ── Re-login helper ────────────────────────────────────────────
async function reLogin(s: BotState): Promise<void> {
  console.log(`[${bogota()}] [bot${s.id}] Re-logging in...`);
  const result = await performLogin({
    email: decrypt(s.bot.visaEmail),
    password: decrypt(s.bot.visaPassword),
    scheduleId: s.bot.scheduleId,
    applicantIds: s.bot.applicantIds,
    locale: s.bot.locale,
  });
  await db.update(sessions).set({
    yatriCookie: encrypt(result.cookie),
    csrfToken: result.csrfToken,
    authenticityToken: result.authenticityToken,
    updatedAt: new Date(),
  }).where(eq(sessions.botId, s.id));
  s.client = new VisaClient(
    { cookie: result.cookie, csrfToken: result.csrfToken, authenticityToken: result.authenticityToken },
    {
      scheduleId: s.bot.scheduleId,
      applicantIds: s.bot.applicantIds,
      consularFacilityId: s.bot.consularFacilityId,
      ascFacilityId: s.bot.ascFacilityId,
      proxyProvider: (s.bot.proxyProvider ?? 'direct') as ProxyProvider,
      userId: s.bot.userId,
      locale: s.bot.locale,
    },
  );
  s.lastReloginMs = Date.now();
  console.log(`[${bogota()}] [bot${s.id}] ✓ Re-login OK`);
}

// ── Per-bot poll cycle ─────────────────────────────────────────
async function pollBot(s: BotState, target: Target | null, phase: Phase): Promise<void> {
  if (target === null) {
    console.log(`[${bogota()}] [bot${s.id}] no-op (target met for this phase)`);
    return;
  }

  // Cooldown check — skip if in backoff window
  if (s.cooldownUntilMs > Date.now()) {
    const remainMin = Math.ceil((s.cooldownUntilMs - Date.now()) / 60_000);
    console.log(`[${bogota()}] [bot${s.id}] 💤 cooldown ${remainMin}min remaining`);
    return;
  }

  if (commit && Date.now() - s.lastReloginMs > 44 * 60_000) {
    try { await reLogin(s); }
    catch (err) { console.log(`[${bogota()}] [bot${s.id}] re-login failed: ${err instanceof Error ? err.message : err}`); }
  }

  const minDate = addDays(
    new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Bogota' }),
    s.bot.minDaysFromToday ?? MIN_DAYS_FROM_TODAY,
  );
  const iterStart = Date.now();

  try {
    const allDays = await s.client.getConsularDays();
    const filtered = filterDates(allDays, s.dateExclusions, undefined, minDate);
    const fetchMs = Date.now() - iterStart;

    // Apply target filters to candidate consular dates
    let candidates = filtered;
    if (target.consularDate) {
      candidates = candidates.filter(d => d.date === target.consularDate);
    }
    if (target.requireConsularEarlierThanCurrent) {
      candidates = candidates.filter(d => d.date < s.lastConsularDate);
    }

    // Persist poll_logs
    await db.insert(pollLogs).values({
      botId: s.id,
      status: filtered.length > 0 ? 'ok' : 'filtered_out',
      earliestDate: filtered[0]?.date ?? null,
      datesCount: filtered.length,
      rawDatesCount: allDays.length,
      responseTimeMs: fetchMs,
      topDates: filtered.slice(0, 10).map(d => d.date),
      provider: s.bot.proxyProvider,
      pollPhase: `dual_${phase.toLowerCase()}`,
      chainId: 'dev',
      allDates: allDays.map(d => ({ date: d.date, business_day: d.business_day })),
    }).catch((e) => console.log(`[${bogota()}] [bot${s.id}] pollLogs insert failed: ${e instanceof Error ? e.message : e}`));

    // Successful fetch — reset error counter
    s.consecutiveErrors = 0;

    if (candidates.length === 0) {
      console.log(`[${bogota()}] [bot${s.id}] #_ | ${fetchMs}ms | ${phase} | total=${allDays.length} earliest=${filtered[0]?.date ?? 'none'} | no candidates`);
      return;
    }

    console.log(`[${bogota()}] [bot${s.id}] | ${fetchMs}ms | ${phase} | candidates=${candidates.length} (earliest=${candidates[0]!.date})`);

    // Walk candidates (cap iteration to 10 per cycle to avoid blowing time budget)
    for (const d of candidates.slice(0, 10)) {
      const cDate = d.date;
      const timesData = await s.client.getConsularTimes(cDate);
      let allTimes = filterTimes(cDate, timesData.available_times, s.timeExclusions);

      // Apply time window if specified
      if (target.consularTimeAnchor !== undefined && target.consularTimeWindowMin !== undefined) {
        const anchorMin = toMin(target.consularTimeAnchor);
        allTimes = allTimes
          .filter(t => Math.abs(toMin(t) - anchorMin) <= target.consularTimeWindowMin!)
          .sort((a, b) => Math.abs(toMin(a) - anchorMin) - Math.abs(toMin(b) - anchorMin));
      }
      if (allTimes.length === 0) continue;

      for (const cTime of allTimes) {
        const casDays = await s.client.getCasDays(cDate, cTime);
        const filteredCas = filterDates(casDays, s.dateExclusions, undefined, minDate);
        const casMatch = filteredCas.find(c => c.date >= target.casStart && c.date <= target.casEnd);
        if (!casMatch) continue;

        const casTimesData = await s.client.getCasTimes(casMatch.date, cDate, cTime);
        const casTimes = filterTimes(casMatch.date, casTimesData.available_times, s.timeExclusions);
        if (casTimes.length === 0) continue;
        const casTime = casTimes[0]!;

        console.log(`[${bogota()}] [bot${s.id}]   ✓ COMBO: consular ${cDate} ${cTime} | CAS ${casMatch.date} ${casTime}`);

        if (!commit) {
          console.log(`[${bogota()}] [bot${s.id}]   DRY-RUN — would POST.`);
          return;
        }

        await s.client.refreshTokens();
        const ok = await s.client.reschedule(cDate, cTime, casMatch.date, casTime);
        if (ok) {
          console.log(`[${bogota()}] [bot${s.id}] 🎉 POST OK`);
          console.log(`[${bogota()}] [bot${s.id}]   ${s.lastConsularDate} ${s.lastConsularTime} | CAS ${s.lastCasDate} ${s.lastCasTime ?? ''}`);
          console.log(`[${bogota()}] [bot${s.id}]    → ${cDate} ${cTime} | CAS ${casMatch.date} ${casTime}`);
          await db.update(bots).set({
            currentConsularDate: cDate,
            currentConsularTime: cTime,
            currentCasDate: casMatch.date,
            currentCasTime: casTime,
            rescheduleCount: s.rescheduleCount + 1,
            updatedAt: new Date(),
          }).where(eq(bots.id, s.id));
          await db.insert(rescheduleLogs).values({
            botId: s.id,
            oldConsularDate: s.lastConsularDate,
            oldConsularTime: s.lastConsularTime,
            oldCasDate: s.lastCasDate,
            oldCasTime: s.lastCasTime,
            newConsularDate: cDate,
            newConsularTime: cTime,
            newCasDate: casMatch.date,
            newCasTime: casTime,
            success: true,
            provider: s.bot.proxyProvider,
          }).catch((e) => console.log(`rescheduleLogs insert failed: ${e instanceof Error ? e.message : e}`));

          s.lastConsularDate = cDate;
          s.lastConsularTime = cTime;
          s.lastCasDate = casMatch.date;
          s.lastCasTime = casTime;
          s.rescheduleCount += 1;
          return;
        }
        console.log(`[${bogota()}] [bot${s.id}]   POST returned false`);
      }
    }
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      s.consecutiveErrors = 0; // session errors are transient — don't count toward cooldown
      console.log(`[${bogota()}] [bot${s.id}] session expired — re-logging`);
      try { await reLogin(s); }
      catch (e) { console.log(`[${bogota()}] [bot${s.id}] re-login failed: ${e instanceof Error ? e.message : e}`); }
    } else {
      s.consecutiveErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      if (s.consecutiveErrors >= COOLDOWN_THRESHOLD) {
        s.cooldownUntilMs = Date.now() + COOLDOWN_MS;
        console.log(`[${bogota()}] [bot${s.id}] ERROR #${s.consecutiveErrors}: ${msg} — entering 3h cooldown`);
        s.consecutiveErrors = 0;
      } else {
        console.log(`[${bogota()}] [bot${s.id}] ERROR #${s.consecutiveErrors}: ${msg}`);
      }
    }
  }
}

// ── Main loop ──────────────────────────────────────────────────
let cycleCount = 0;
while (true) {
  cycleCount++;
  const cycleStart = Date.now();
  const phase = detectPhase();

  if (phase === 'DONE') {
    console.log(`\n✅ ALL TARGETS MET`);
    for (const id of BOT_IDS) {
      const s = state.get(id)!;
      console.log(`  Bot ${id}: ${s.lastConsularDate} ${s.lastConsularTime} | CAS ${s.lastCasDate} ${s.lastCasTime}`);
    }
    process.exit(0);
  }

  console.log(`\n--- Cycle ${cycleCount} | Phase: ${phase} ---`);

  // Poll bots sequentially
  for (const id of BOT_IDS) {
    const s = state.get(id)!;
    const peer = state.get(BOT_IDS.find(p => p !== id)!)!;
    const target = getTarget(s, phase, peer);
    await pollBot(s, target, phase);
  }

  const elapsed = Date.now() - cycleStart;
  const sleepMs = Math.max(0, POLL_INTERVAL_MS - elapsed);
  if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));
}

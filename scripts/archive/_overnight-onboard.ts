/**
 * Overnight onboarding orchestrator for the 19 VisasOK paid bots.
 * Goal: leave all 19 (178,194-211) functioning (active + polling ok). Keep 190 paused.
 *
 * Strategy (no bursts): initial cooldown, then activate 2 fresh accounts per ~6min cycle,
 * mark "working" (>=2 ok polls / 8min), pause "stuck" ones (0 ok after settle) and retry
 * them after a rest. Login is via the RPi (direct, residential) — Mac IP is blocked.
 * Robust: never throws out of the loop; DB is the state. Caps at 8h.
 */
import { db } from '../src/db/client.js';
import { bots, pollLogs } from '../src/db/schema.js';
import { inArray, eq, gte, and, sql } from 'drizzle-orm';

const TARGETS = [178,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211];
const REST_BEFORE_START_MS = 60 * 60_000;
const CYCLE_MS = 6 * 60_000;
const BATCH = 2;                 // new activations per cycle
const SETTLE_MS = 12 * 60_000;   // min active time before judging stuck (login can be slow)
const RETRY_REST_MS = 40 * 60_000;
const MAX_MS = 8 * 60 * 60_000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);
const log = (m: string) => console.log(`[${ts()}] ${m}`);

const activatedAt = new Map<number, number>();   // botId -> last activation ts
const lastTriedAt = new Map<number, number>();   // botId -> last attempt ts (for retry rest)

async function pause(ids: number[]) {
  if (!ids.length) return;
  await db.update(bots).set({ status: 'paused', activeRunId: null, activeCloudRunId: null, updatedAt: new Date() }).where(inArray(bots.id, ids));
}
async function activate(ids: number[]) {
  if (!ids.length) return;
  await db.update(bots).set({ status: 'active', activeRunId: null, activeCloudRunId: null, consecutiveErrors: 0, updatedAt: new Date() }).where(inArray(bots.id, ids));
  const now = Date.now();
  for (const id of ids) { activatedAt.set(id, now); lastTriedAt.set(id, now); }
}

/** per-target poll health in the last 8 min: ok/tcp counts */
async function pollHealth(): Promise<Map<number, { ok: number; tcp: number }>> {
  const since = new Date(Date.now() - 8 * 60_000);
  const rows = await db.select({ botId: pollLogs.botId, s: pollLogs.status, n: sql<number>`count(*)::int` })
    .from(pollLogs).where(and(gte(pollLogs.createdAt, since), inArray(pollLogs.botId, TARGETS)))
    .groupBy(pollLogs.botId, pollLogs.status);
  const m = new Map<number, { ok: number; tcp: number }>();
  for (const id of TARGETS) m.set(id, { ok: 0, tcp: 0 });
  for (const r of rows) {
    const e = m.get(r.botId)!;
    if (r.s === 'ok' || r.s === 'filtered_out') e.ok += r.n;
    else if (r.s === 'tcp_blocked') e.tcp += r.n;
  }
  return m;
}

async function statusMap(): Promise<Map<number, string>> {
  const rows = await db.select({ id: bots.id, s: bots.status }).from(bots).where(inArray(bots.id, TARGETS));
  return new Map(rows.map(r => [r.id, r.s]));
}

log(`Overnight onboarding START. ${TARGETS.length} targets. Resting ${REST_BEFORE_START_MS/60000}min first…`);
// keep 190 stopped
await db.update(bots).set({ status: 'paused', activeRunId: null, updatedAt: new Date() }).where(eq(bots.id, 190)).catch(() => {});
await sleep(REST_BEFORE_START_MS);

const start = Date.now();
let cycle = 0;
const working = new Set<number>();

while (Date.now() - start < MAX_MS) {
  cycle++;
  try {
    // keep 190 stopped every cycle
    await db.update(bots).set({ status: 'paused', updatedAt: new Date() }).where(and(eq(bots.id, 190), eq(bots.status, 'active'))).catch(() => {});

    const health = await pollHealth();
    const status = await statusMap();
    const now = Date.now();

    // recompute working set (active + >=2 ok polls in 8min)
    working.clear();
    const stuck: number[] = [];
    for (const id of TARGETS) {
      const st = status.get(id);
      const h = health.get(id)!;
      if (st === 'active' && h.ok >= 2) { working.add(id); continue; }
      // stuck = active, past settle window, zero ok polls (hanging/blocked)
      if (st === 'active' && (now - (activatedAt.get(id) ?? 0)) > SETTLE_MS && h.ok === 0) stuck.push(id);
    }

    if (stuck.length) { await pause(stuck); log(`cycle ${cycle}: paused stuck (rest+retry later): ${stuck.join(',')}`); }

    if (working.size >= TARGETS.length) {
      log(`✅ ALL ${TARGETS.length} WORKING. Done at cycle ${cycle}.`);
      break;
    }

    // eligible to (re)activate: paused, not working, rested >= RETRY_REST since last try
    const eligible = TARGETS.filter(id => {
      const st = status.get(id);
      if (st !== 'paused' || working.has(id)) return false;
      const lt = lastTriedAt.get(id);
      return lt === undefined || (now - lt) >= RETRY_REST_MS;
    });
    const toActivate = eligible.slice(0, BATCH);
    if (toActivate.length) { await activate(toActivate); log(`cycle ${cycle}: activated ${toActivate.join(',')} (working=${working.size}/${TARGETS.length})`); }
    else log(`cycle ${cycle}: working=${working.size}/${TARGETS.length}, none eligible yet (resting). inflight=${[...status].filter(([,s])=>s==='active').length}`);
  } catch (e) {
    log(`cycle ${cycle}: ERROR ${e instanceof Error ? e.message : e} (continuing)`);
  }
  await sleep(CYCLE_MS);
}

const finalStatus = await statusMap();
const finalHealth = await pollHealth();
const okBots = TARGETS.filter(id => finalStatus.get(id) === 'active' && (finalHealth.get(id)?.ok ?? 0) >= 2);
log(`FINISHED. working=${okBots.length}/${TARGETS.length}: [${okBots.join(',')}]`);
log(`not-working: [${TARGETS.filter(id => !okBots.includes(id)).join(',')}]`);
process.exit(0);

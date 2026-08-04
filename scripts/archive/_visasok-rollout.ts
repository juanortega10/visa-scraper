/**
 * Staggered activation for VisasOK paid bots, to avoid login storms on the RPi IP.
 * cooldown -> probe 1 -> batches of 3 every ~2min. Aborts if IP still blocked.
 * Activation = set status=active (RPi poll-cron-local picks up on odd minutes).
 */
import { db } from '../src/db/client.js';
import { bots, sessions, pollLogs } from '../src/db/schema.js';
import { eq, desc, inArray } from 'drizzle-orm';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (m: string) => console.log(`[${ts()}] ${m}`);

const PROBE = 194;
const BATCHES = [
  [178, 195, 196],
  [197, 198, 199],
  [200, 201, 202],
  [203, 204, 205],
  [206, 207, 208],
  [209, 210, 211],
];

async function activate(ids: number[]) {
  await db.update(bots).set({ status: 'active', activeRunId: null, activeCloudRunId: null, consecutiveErrors: 0, updatedAt: new Date() }).where(inArray(bots.id, ids));
}
async function probeState(id: number): Promise<'ok' | 'blocked' | 'pending'> {
  const [s] = await db.select({ botId: sessions.botId }).from(sessions).where(eq(sessions.botId, id));
  if (s) return 'ok';
  const [p] = await db.select().from(pollLogs).where(eq(pollLogs.botId, id)).orderBy(desc(pollLogs.createdAt)).limit(1);
  if (p && p.status === 'ok') return 'ok';
  if (p && ['tcp_blocked', 'soft_ban'].includes(p.status)) return 'blocked';
  return 'pending';
}
async function sessionCount(ids: number[]): Promise<number> {
  const ss = await db.select({ botId: sessions.botId }).from(sessions).where(inArray(sessions.botId, ids));
  return ss.length;
}

// ── Phase 0: cooldown ──
log('Phase 0: cooldown 10min for RPi IP to recover...');
await sleep(600_000);

// ── Phase 1: probe with 1 cold-start bot ──
log(`Phase 1: probe bot ${PROBE} (cold login).`);
await activate([PROBE]);
let probe: 'ok' | 'blocked' | 'pending' = 'pending';
for (let i = 0; i < 18; i++) { // up to 6 min
  await sleep(20_000);
  probe = await probeState(PROBE);
  log(`  probe ${PROBE}: ${probe}`);
  if (probe === 'ok' || probe === 'blocked') break;
}
if (probe !== 'ok') {
  log(`ABORT: probe result=${probe}. IP not recovered / still blocked. Bot ${PROBE} left active (will retry via backoff). Re-run rollout later.`);
  process.exit(0);
}
log(`Probe OK — IP recovered. Proceeding with batches.`);

// ── Phase 2: batches of 3 every ~2.5min ──
const allBatchIds: number[] = [];
for (let b = 0; b < BATCHES.length; b++) {
  const batch = BATCHES[b]!;
  allBatchIds.push(...batch);
  log(`Batch ${b + 1}/${BATCHES.length}: activating ${batch.join(',')}`);
  await activate(batch);
  await sleep(150_000); // 2.5min: allow cron pickup + login
  const got = await sessionCount(batch);
  // check for blocks in this batch
  let blocked = 0;
  for (const id of batch) { if ((await probeState(id)) === 'blocked') blocked++; }
  log(`  batch ${b + 1} result: sessions=${got}/${batch.length} blocked=${blocked}`);
  if (blocked >= 2) {
    log(`  WARNING: ${blocked} blocked in batch — backing off extra 4min before continuing.`);
    await sleep(240_000);
  }
}

// ── Final summary ──
const ALL = [PROBE, ...allBatchIds];
const totalSessions = await sessionCount(ALL);
const states: Record<string, number> = { ok: 0, blocked: 0, pending: 0 };
for (const id of ALL) states[await probeState(id)]++;
log(`DONE. ${ALL.length} bots activated. sessions=${totalSessions}/${ALL.length}  states=${JSON.stringify(states)}`);
process.exit(0);

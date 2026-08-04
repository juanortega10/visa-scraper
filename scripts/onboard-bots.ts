/**
 * Safe staggered onboarding for many bots — avoids the login storm + account TCP-block
 * that happens when you mass-activate.
 *
 * Why this exists: login is ALWAYS direct (not webshare). Activating N session-less bots
 * at once makes N simultaneous direct logins from one IP -> TCP block at the ACCOUNT level
 * (webshare's IP rotation does NOT save you — the block follows the account). So we:
 *   1. Pre-create sessions from THIS machine, spaced out (login load off the RPi).
 *   2. Activate in small batches, verifying each batch polls `ok` before the next.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/onboard-bots.ts <ids...> [options]
 *   npx tsx --env-file=.env scripts/onboard-bots.ts 194 195 196 ... --batch=3
 *
 * Options:
 *   --batch=N         bots per activation batch (default 3)
 *   --gap=SECONDS     spacing between pre-logins (default 12)
 *   --wait=SECONDS    wait after activating a batch before health-check (default 150)
 *   --prelogin-only   only create sessions, do not activate
 *   --activate-only   skip pre-login (bots already have sessions), just batch-activate
 *   --abort-on-block  stop if a batch comes back majority tcp_blocked (default ON)
 *   --dry             show the plan, do nothing
 */
import { db } from '../src/db/client.js';
import { bots, sessions, pollLogs } from '../src/db/schema.js';
import { eq, desc, inArray } from 'drizzle-orm';
import { decrypt, encrypt } from '../src/services/encryption.js';
import { pureFetchLogin } from '../src/services/login.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace('T', ' ').slice(11, 19);
const log = (m: string) => console.log(`[${ts()}] ${m}`);
const argv = process.argv.slice(2);
const num = (flag: string, def: number) => { const a = argv.find(x => x.startsWith(flag + '=')); return a ? parseInt(a.split('=')[1]!, 10) : def; };
const has = (flag: string) => argv.includes(flag);

const IDS = argv.filter(a => /^\d+$/.test(a)).map(Number);
const BATCH = num('--batch', 3);
const GAP = num('--gap', 12) * 1000;
const WAIT = num('--wait', 150) * 1000;
const PRELOGIN_ONLY = has('--prelogin-only');
const ACTIVATE_ONLY = has('--activate-only');
const ABORT_ON_BLOCK = !argv.includes('--no-abort-on-block');
const DRY = has('--dry');

if (IDS.length === 0) { console.error('No bot IDs given.'); process.exit(1); }

const rows = await db.select().from(bots).where(inArray(bots.id, IDS));
const byId = new Map(rows.map(b => [b.id, b]));
const present = IDS.filter(id => byId.has(id));
log(`Onboarding ${present.length} bots: ${present.join(',')}`);
log(`batch=${BATCH} preloginGap=${GAP/1000}s batchWait=${WAIT/1000}s prelogin=${!ACTIVATE_ONLY} activate=${!PRELOGIN_ONLY} abortOnBlock=${ABORT_ON_BLOCK}${DRY?' [DRY]':''}`);
if (DRY) { log('DRY — no changes.'); process.exit(0); }

// ── Phase 1: pre-login (sessions from local, staggered) ──
const loggedIn = new Set<number>();
if (!ACTIVATE_ONLY) {
  log('Phase 1: pre-login (sessions from this machine)...');
  for (let i = 0; i < present.length; i++) {
    const id = present[i]!; const b = byId.get(id)!;
    try {
      const r = await pureFetchLogin(
        { email: decrypt(b.visaEmail), password: decrypt(b.visaPassword), scheduleId: b.scheduleId, applicantIds: b.applicantIds, locale: b.locale ?? 'es-co' },
        { visaType: 'iv' },
      );
      if (!r.cookie) throw new Error('no cookie');
      await db.insert(sessions).values({ botId: id, yatriCookie: encrypt(r.cookie), csrfToken: r.csrfToken || null, authenticityToken: r.authenticityToken || null, lastUsedAt: new Date(), createdAt: new Date() })
        .onConflictDoUpdate({ target: sessions.botId, set: { yatriCookie: encrypt(r.cookie), csrfToken: r.csrfToken || null, authenticityToken: r.authenticityToken || null, lastUsedAt: new Date(), createdAt: new Date() } });
      loggedIn.add(id);
      log(`  ✓ ${id} session (tokens=${r.hasTokens})`);
    } catch (e) {
      log(`  ✗ ${id} login FAILED: ${e instanceof Error ? e.message : e} (will skip)`);
    }
    if (i < present.length - 1) await sleep(GAP);
  }
  log(`Pre-login done: ${loggedIn.size}/${present.length} ok`);
} else {
  present.forEach(id => loggedIn.add(id));
}
if (PRELOGIN_ONLY) { log('--prelogin-only: stopping (bots NOT activated).'); process.exit(0); }

// ── Phase 2: batched activation with health gate ──
const targets = present.filter(id => loggedIn.has(id));
async function lastStatus(id: number): Promise<string> {
  const [p] = await db.select({ s: pollLogs.status }).from(pollLogs).where(eq(pollLogs.botId, id)).orderBy(desc(pollLogs.createdAt)).limit(1);
  return p?.s ?? 'none';
}
const summary: Record<string, number[]> = { ok: [], tcp_blocked: [], other: [], none: [] };
for (let i = 0; i < targets.length; i += BATCH) {
  const batch = targets.slice(i, i + BATCH);
  log(`Batch ${Math.floor(i/BATCH)+1}: activating ${batch.join(',')}`);
  await db.update(bots).set({ status: 'active', activeRunId: null, activeCloudRunId: null, consecutiveErrors: 0, updatedAt: new Date() }).where(inArray(bots.id, batch));
  await sleep(WAIT);
  let blocked = 0;
  for (const id of batch) {
    const s = await lastStatus(id);
    const bucket = s === 'ok' || s === 'filtered_out' ? 'ok' : s === 'tcp_blocked' ? 'tcp_blocked' : s === 'none' ? 'none' : 'other';
    summary[bucket]!.push(id);
    if (bucket === 'tcp_blocked') blocked++;
    log(`    ${id}: ${s}`);
  }
  if (ABORT_ON_BLOCK && blocked > batch.length / 2) {
    log(`  ⛔ ABORT: ${blocked}/${batch.length} tcp_blocked in this batch. Pausing remaining (not yet activated) and stopping.`);
    const remaining = targets.slice(i + BATCH);
    if (remaining.length) await db.update(bots).set({ status: 'paused', updatedAt: new Date() }).where(inArray(bots.id, remaining));
    break;
  }
}
log(`DONE. ok=${summary.ok!.length} tcp_blocked=${summary.tcp_blocked!.length} other=${summary.other!.length} none=${summary.none!.length}`);
if (summary.tcp_blocked!.length) log(`  blocked: ${summary.tcp_blocked!.join(',')}`);
if (summary.none!.length) log(`  no poll yet (queued): ${summary.none!.join(',')}`);
process.exit(0);

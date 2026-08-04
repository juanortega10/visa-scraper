/**
 * DB-only fleet recovery watcher. No portal load. Exits when the established fleet
 * is mostly healthy (>=75% ok over 5min, >=15 ok polls), or after a max wait.
 */
import { db } from '../src/db/client.js';
import { pollLogs } from '../src/db/schema.js';
import { gte, and, notInArray, sql } from 'drizzle-orm';

const BATCH = [178,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);
const MAX_MIN = 45;
const start = Date.now();

while ((Date.now() - start) / 60000 < MAX_MIN) {
  const since = new Date(Date.now() - 5 * 60_000);
  const rows = await db.select({ s: pollLogs.status, n: sql<number>`count(*)::int` })
    .from(pollLogs).where(and(gte(pollLogs.createdAt, since), notInArray(pollLogs.botId, BATCH)))
    .groupBy(pollLogs.status);
  let ok = 0, tcp = 0, other = 0;
  for (const r of rows) {
    if (r.s === 'ok' || r.s === 'filtered_out') ok += r.n;
    else if (r.s === 'tcp_blocked') tcp += r.n;
    else other += r.n;
  }
  const total = ok + tcp + other;
  const ratio = total ? ok / total : 0;
  console.log(`[${ts()}] ok=${ok} tcp=${tcp} other=${other} okRatio=${(ratio*100).toFixed(0)}%`);
  if (ok >= 15 && ratio >= 0.75) {
    console.log(`[${ts()}] ✅ RECOVERED — fleet healthy (ok=${ok}, ${(ratio*100).toFixed(0)}% ok). Ready to deploy.`);
    process.exit(0);
  }
  await sleep(60_000);
}
console.log(`[${ts()}] ⏱ max wait (${MAX_MIN}min) reached — not fully recovered yet.`);
process.exit(2);

/**
 * 3-hour fleet monitor — samples every 15 min (12 cycles). DB-only, zero portal load.
 * Watches: overall fleet health, the 19 VisasOK paid, the 3 new bots (214/215/216),
 * confirms 212 & 190 stay paused, counts reschedules, flags anomalies + backoff behavior.
 */
import { db } from '../src/db/client.js';
import { bots, pollLogs, rescheduleLogs } from '../src/db/schema.js';
import { inArray, eq, gte, and, notInArray, sql } from 'drizzle-orm';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 16) + 'Z';
const VISASOK = [178,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211];
const NEW3 = [214,215,216];
const PAUSED_MUST = [212, 190];
const CYCLES = 12;
const GAP_MS = 15 * 60_000;

console.log(`[${ts()}] === 3h MONITOR START (every 15min, ${CYCLES} cycles) ===`);

for (let c = 1; c <= CYCLES; c++) {
  try {
    const since = new Date(Date.now() - 15 * 60_000);
    const alerts: string[] = [];

    // overall fleet (exclude our special/paused set)
    const excl = [...VISASOK, ...NEW3, ...PAUSED_MUST];
    const fr = await db.select({ s: pollLogs.status, n: sql<number>`count(*)::int`, d: sql<number>`count(distinct ${pollLogs.botId})::int` })
      .from(pollLogs).where(and(gte(pollLogs.createdAt, since), notInArray(pollLogs.botId, excl))).groupBy(pollLogs.status);
    let fok = 0, ftcp = 0, fbots = 0;
    for (const r of fr) { if (r.s === 'ok' || r.s === 'filtered_out') { fok += r.n; fbots = Math.max(fbots, r.d); } else if (r.s === 'tcp_blocked') ftcp += r.n; }
    const fRatio = fok + ftcp ? Math.round(fok / (fok + ftcp) * 100) : 0;

    // VisasOK 19
    const stAll = new Map((await db.select({ id: bots.id, s: bots.status }).from(bots).where(inArray(bots.id, [...VISASOK, ...NEW3, ...PAUSED_MUST]))).map(r => [r.id, r.s]));
    const okBy = new Map<number, number>();
    const okRows = await db.select({ b: pollLogs.botId, n: sql<number>`count(*)::int` })
      .from(pollLogs).where(and(gte(pollLogs.createdAt, since), inArray(pollLogs.botId, [...VISASOK, ...NEW3]), inArray(pollLogs.status, ['ok', 'filtered_out']))).groupBy(pollLogs.botId);
    for (const r of okRows) okBy.set(r.b, r.n);
    const vWorking = VISASOK.filter(id => stAll.get(id) === 'active' && (okBy.get(id) || 0) >= 2).length;

    // new 3
    const new3str = NEW3.map(id => `${id}:${stAll.get(id)}/${(okBy.get(id) || 0) >= 2 ? 'ok' : (okBy.get(id) || 0) > 0 ? 'partial' : 'no-poll'}`).join(' ');

    // paused-must check
    for (const id of PAUSED_MUST) if (stAll.get(id) === 'active') alerts.push(`⚠ bot ${id} is ACTIVE (must be paused!)`);
    if (fRatio < 40 && fok + ftcp > 10) alerts.push(`⚠ fleet ok=${fRatio}% (possible block episode)`);

    // reschedules last 15min (VisasOK + new)
    const rs = await db.select({ ok: rescheduleLogs.success })
      .from(rescheduleLogs).where(and(gte(rescheduleLogs.createdAt, since), inArray(rescheduleLogs.botId, [...VISASOK, ...NEW3])));
    const succ = rs.filter(r => r.ok).length;

    console.log(`[${ts()}] cyc${c}/${CYCLES} | fleet ${fRatio}%ok (${fok}/${ftcp}tcp,${fbots}bots) | VisasOK ${vWorking}/19 working | new3 ${new3str} | resched15m=${succ} | ${alerts.length ? alerts.join('; ') : 'OK'}`);
  } catch (e) {
    console.log(`[${ts()}] cyc${c}: ERROR ${e instanceof Error ? e.message : e}`);
  }
  if (c < CYCLES) await sleep(GAP_MS);
}
console.log(`[${ts()}] === 3h MONITOR DONE ===`);
process.exit(0);

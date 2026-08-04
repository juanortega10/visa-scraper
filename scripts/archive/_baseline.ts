/** Steady-state baseline: sample fleet poll health over ~6 min (my batch excluded). DB-only. */
import { db } from '../src/db/client.js';
import { pollLogs } from '../src/db/schema.js';
import { gte, and, notInArray, sql } from 'drizzle-orm';
const BATCH = [178,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ratios: number[] = []; const okRates: number[] = [];
for (let i = 0; i < 6; i++) {
  const since = new Date(Date.now() - 5*60_000);
  const rows = await db.select({ s: pollLogs.status, n: sql<number>`count(*)::int`, d: sql<number>`count(distinct ${pollLogs.botId})::int` }).from(pollLogs).where(and(gte(pollLogs.createdAt, since), notInArray(pollLogs.botId, BATCH))).groupBy(pollLogs.status);
  let ok=0,tcp=0,bots=0; for(const r of rows){ if(r.s==='ok'||r.s==='filtered_out'){ok+=r.n;bots=Math.max(bots,r.d);} else if(r.s==='tcp_blocked')tcp+=r.n; }
  const ratio = ok+tcp? ok/(ok+tcp):0; ratios.push(ratio); okRates.push(ok/5);
  console.log(`[${new Date().toISOString().slice(11,19)}] ok=${ok} tcp=${tcp} okRatio=${(ratio*100).toFixed(0)}% okPolls/min=${(ok/5).toFixed(1)} distinctOkBots=${bots}`);
  if (i < 5) await sleep(60_000);
}
const avg = (a:number[]) => a.reduce((s,x)=>s+x,0)/a.length;
console.log(`\nBASELINE avg okRatio=${(avg(ratios)*100).toFixed(0)}%  avg okPolls/min=${avg(okRates).toFixed(1)}`);
process.exit(0);

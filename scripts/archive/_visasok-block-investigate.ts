import { db } from '../src/db/client.js';
import { bots, pollLogs } from '../src/db/schema.js';
import { eq, and, gte, inArray, desc, asc } from 'drizzle-orm';

const ag5 = await db.select({id:bots.id,prov:bots.proxyProvider,status:bots.status}).from(bots).where(eq(bots.agencyId,5));
const activeIds = ag5.filter(b=>b.status==='active').map(b=>b.id);
const since = new Date(Date.now() - 6*3600*1000);
const logs = await db.select({id:pollLogs.botId,s:pollLogs.status,t:pollLogs.createdAt})
  .from(pollLogs).where(and(inArray(pollLogs.botId,activeIds),gte(pollLogs.createdAt,since))).orderBy(asc(pollLogs.createdAt));

// 30-min buckets: ok vs tcp_blocked vs other, across the whole active cohort
const buckets = new Map<string,{ok:number,tcp:number,other:number}>();
for(const l of logs){
  const d=new Date(l.t); const key=`${String(d.getUTCHours()).padStart(2,'0')}:${d.getUTCMinutes()<30?'00':'30'}`;
  const b=buckets.get(key)??{ok:0,tcp:0,other:0};
  if(l.s==='ok'||l.s==='filtered_out')b.ok++; else if(l.s==='tcp_blocked')b.tcp++; else b.other++;
  buckets.set(key,b);
}
console.log('=== cohort polls by 30min bucket (UTC) — ok / tcp_blocked / other ===');
for(const[k,v]of[...buckets.entries()].sort())console.log(`${k}  ok=${String(v.ok).padStart(3)} tcp=${String(v.tcp).padStart(3)} other=${v.other}`);

// per-bot: last OK and first tcp_blocked of the current block streak
console.log('\n=== per-bot: last ok vs last tcp, in last 6h ===');
const now=Date.now();
for(const id of activeIds.sort((a,b)=>a-b)){
  const mine=logs.filter(l=>l.id===id);
  const lastOk=[...mine].reverse().find(l=>l.s==='ok'||l.s==='filtered_out');
  const lastTcp=[...mine].reverse().find(l=>l.s==='tcp_blocked');
  const total=mine.length, tcpN=mine.filter(l=>l.s==='tcp_blocked').length;
  const prov=ag5.find(b=>b.id===id)!.prov;
  const ago=(t:any)=>t?Math.round((now-new Date(t).getTime())/60000)+'m':'-';
  console.log(`${id} ${prov.padEnd(9)} polls6h=${String(total).padStart(3)} tcp%=${total?Math.round(100*tcpN/total):0}  lastOk=${ago(lastOk?.t)} lastTcp=${ago(lastTcp?.t)}`);
}
process.exit(0);

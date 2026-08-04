import { db } from '../src/db/client.js';
import { bots, sessions, pollLogs } from '../src/db/schema.js';
import { eq, desc, gte, and, notInArray, sql } from 'drizzle-orm';
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));
const ts=()=>new Date().toISOString().slice(11,19);
const BATCH=[178,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211];
console.log(`[${ts()}] watching bot 199 for 15 min...`);
for (let i=0;i<7;i++){
  const [b]=await db.select({s:bots.status,r:bots.activeRunId,c:bots.consecutiveErrors}).from(bots).where(eq(bots.id,199));
  const [se]=await db.select({at:sessions.createdAt}).from(sessions).where(eq(sessions.botId,199));
  const ps=await db.select({st:pollLogs.status,at:pollLogs.createdAt,ed:pollLogs.earliestDate}).from(pollLogs).where(eq(pollLogs.botId,199)).orderBy(desc(pollLogs.createdAt)).limit(3);
  const since=new Date(Date.now()-5*60_000);
  const fr=await db.select({s:pollLogs.status,n:sql<number>`count(*)::int`}).from(pollLogs).where(and(gte(pollLogs.createdAt,since),notInArray(pollLogs.botId,BATCH))).groupBy(pollLogs.status);
  let ok=0,tcp=0;for(const r of fr){if(r.s==='ok'||r.s==='filtered_out')ok+=r.n;else if(r.s==='tcp_blocked')tcp+=r.n;}
  const recent=ps.filter(p=>Date.now()-p.at.getTime()<300_000);
  console.log(`[${ts()}] 199: status=${b?.s} session=${se?Math.round((Date.now()-se.at.getTime())/1000)+'s':'NONE'} consec=${b?.c} | last5min polls: ${recent.length?recent.map(p=>p.st).join(','):'none'} | lastPoll=${ps[0]?`${ps[0].st} earliest=${ps[0].ed??'-'} (${Math.round((Date.now()-ps[0].at.getTime())/1000)}s)`:'NONE'} | fleet=${(ok+tcp?ok/(ok+tcp)*100:0).toFixed(0)}%`);
  if(i<6)await sleep(150_000);
}
console.log(`[${ts()}] 15-min window done.`);
process.exit(0);

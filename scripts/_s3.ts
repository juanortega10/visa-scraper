import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const l = await db.execute(sql`
  SELECT width_bucket(duration_ms/1000.0, 0, 300, 30) b, count(*) n
  FROM date_sightings ds JOIN bots b2 ON b2.id=ds.bot_id
  WHERE ds.disappeared_at IS NOT NULL AND ds.duration_ms > 0
    AND ds.days_from_now BETWEEN 8 AND 90 AND b2.locale='es-co'
    AND ds.appeared_at > now()-interval '90 days' GROUP BY 1 ORDER BY 1`);
const life:number[]=[];
for(const r of l.rows as any[]){
  const b=Number(r.b), n=Number(r.n), secs=b>30?400:(b-0.5)*10;
  for(let i=0;i<n;i++) life.push(secs);
}
const pick=()=>life[Math.floor(Math.random()*life.length)]!;
const expo=(m:number)=>-m*Math.log(1-Math.random());
const SC: Record<string,()=>number> = {
  'agudo s14'          : ()=>14,
  'disperso Exp 7s'    : ()=>(14+expo(7))%60,
  'disperso Exp 20s'   : ()=>(14+expo(20))%60,
  'sin reloj uniforme' : ()=>Math.random()*60,
};
function rate(k:number, phase:number|null, rel:()=>number, trials=120000){
  const period=60/k; let hit=0;
  for(let t=0;t<trials;t++){
    const r=rel(), L=pick();
    const first = phase===null ? Math.random()*60 : phase;
    const dt=((first-r)%period+period)%period;
    if(dt<=L) hit++;
  }
  return hit/trials;
}
for(const [name,rel] of Object.entries(SC)){
  console.log(`--- ${name} ---`);
  console.log('polls/min | mejor fase | alineado optimo | aleatorio | ganancia');
  for(const k of [0.5,1,2,3,4]){
    let best=-1,bp=0;
    for(let p=0;p<60;p+=1){ const v=rate(k,p,rel); if(v>best){best=v;bp=p;} }
    const rnd=rate(k,null,rel);
    console.log(`${String(k).padStart(9)} | ${('s'+bp).padStart(10)} | ${(best*100).toFixed(1).padStart(14)}% | ${(rnd*100).toFixed(1).padStart(8)}% | ${(best/rnd).toFixed(2)}x`);
  }
  console.log();
}
process.exit(0);

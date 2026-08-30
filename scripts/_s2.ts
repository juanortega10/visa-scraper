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
  const b=Number(r.b), n=Number(r.n), secs = b>30?400:(b-0.5)*10;
  for(let i=0;i<n;i++) life.push(secs);
}
const pick=()=>life[Math.floor(Math.random()*life.length)]!;
const expo=(m:number)=>-m*Math.log(1-Math.random());

// Escenarios de dispersion del instante real de liberacion
const SC: Record<string,()=>number> = {
  'agudo (todo en s14)'      : ()=>14,
  'realista (s14 + Exp 7s)'  : ()=>(14+expo(7))%60,
  'ancho (s14 + Exp 20s)'    : ()=>(14+expo(20))%60,
  'sin reloj (uniforme)'     : ()=>Math.random()*60,
};
// polls colocados de forma optima: k polls repartidos, el primero en s15
function catchRate(k:number, aligned:boolean, rel:()=>number, trials=300000){
  const period=60/k; let hit=0;
  for(let t=0;t<trials;t++){
    const r=rel(), L=pick();
    const first = aligned ? 15 : Math.random()*60;
    const dt = ((first - r) % period + period) % period;
    if(dt<=L) hit++;
  }
  return hit/trials;
}
console.log(`vida util es-co (8-90 dias): n=${life.length}, mediana=${[...life].sort((a,b)=>a-b)[Math.floor(life.length/2)]}s\n`);
for(const [name,rel] of Object.entries(SC)){
  console.log(`--- ${name} ---`);
  console.log('polls/min | alineado | aleatorio | ganancia');
  for(const k of [0.5,1,2,3,4,6]){
    const a=catchRate(k,true,rel), r=catchRate(k,false,rel);
    console.log(`${String(k).padStart(9)} | ${(a*100).toFixed(1).padStart(7)}% | ${(r*100).toFixed(1).padStart(8)}% | ${(a/r).toFixed(2)}x`);
  }
  console.log();
}
process.exit(0);

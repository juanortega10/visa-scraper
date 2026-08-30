import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// Distribucion empirica de vida util (es-co, fechas utiles 8-90 dias)
const l = await db.execute(sql`
  SELECT width_bucket(duration_ms/1000.0, 0, 300, 30) b,
         count(*) n
  FROM date_sightings ds JOIN bots b2 ON b2.id=ds.bot_id
  WHERE ds.disappeared_at IS NOT NULL AND ds.duration_ms > 0
    AND ds.days_from_now BETWEEN 8 AND 90 AND b2.locale='es-co'
    AND ds.appeared_at > now()-interval '90 days'
  GROUP BY 1 ORDER BY 1`);
const rows = l.rows as any[];
const tot = rows.reduce((a,x)=>a+Number(x.n),0);
// buckets de 10s; el bucket 31 es >300s
const life: number[] = [];
for(const r of rows){
  const b = Number(r.b), n = Number(r.n);
  const secs = b>30 ? 400 : (b-0.5)*10;
  for(let i=0;i<n;i++) life.push(secs);
}
console.log(`vida util: n=${tot}, mediana=${life.sort((a,b)=>a-b)[Math.floor(life.length/2)]}s`);

// Simulacion: k polls por minuto, con fase alineada vs fase aleatoria.
// Liberacion en el segundo 14 (borde medido). Vida sorteada de la distribucion real.
function sim(k:number, aligned:boolean, trials=200000){
  let caught=0;
  const period = 60/k;
  for(let t=0;t<trials;t++){
    const life = life_[Math.floor(Math.random()*life_.length)];
    // instante de liberacion dentro del minuto
    const rel = 14;
    // fase del primer poll
    const phase = aligned ? 15 : Math.random()*60;
    // primer poll en o despues de rel
    let dt = ((phase - rel) % period + period) % period;
    if (dt <= life) caught++;
  }
  return caught/trials;
}
const life_ = life;
console.log('\n=== fraccion de liberaciones detectadas VIVAS ===');
console.log('polls/min | fase alineada | fase aleatoria | ganancia de alinear');
for(const k of [0.5,1,2,3,4,6]){
  const a=sim(k,true), r=sim(k,false);
  console.log(`${String(k).padStart(9)} | ${(a*100).toFixed(1).padStart(12)}% | ${(r*100).toFixed(1).padStart(13)}% | ${(a/r).toFixed(2)}x`);
}
process.exit(0);

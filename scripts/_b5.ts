import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const h = await db.execute(sql`
  SELECT EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::int/3*3 franja,
    count(*) filas,
    round(100.0*count(*) FILTER (WHERE p.status IN ('tcp_blocked','soft_ban'))/count(*),3) pct_bloqueo,
    round(100.0*count(*) FILTER (WHERE p.status='error')/count(*),2) pct_error
  FROM poll_logs p JOIN bots b ON b.id=p.bot_id
  WHERE p.created_at > now()-interval '30 days' AND b.locale='es-co'
  GROUP BY 1 ORDER BY 1`);
console.log('=== HB4 · riesgo por franja horaria Bogota (es-co) ===');
console.table(h.rows);

// Optimizacion: mismo presupuesto de polls, reasignado por rendimiento, con techo 4/min
const Y = [32.80,32.59,25.97,24.33,16.17,19.70,19.86,22.56,23.25,25.60,33.15,24.73,
           21.43,20.09,27.04,45.70,46.22,41.53,39.79,58.14,56.53,55.25,43.60,38.86];
const cur = 2.91;            // polls/min actuales (cadencia 20.6s)
const CAP = 4.0;             // techo seguro segun HB3
const budget = cur*24;       // presupuesto total en polls/min-hora
const base = Y.reduce((a,y)=>a+y*cur,0);

function evaluate(floor:number){
  let rate = Y.map(()=>floor);
  let left = budget - floor*24;
  const order = Y.map((y,i)=>[y,i] as [number,number]).sort((a,b)=>b[0]-a[0]);
  for(const [,i] of order){
    const add = Math.min(CAP-floor, left);
    if(add<=0) break;
    rate[i]+=add; left-=add;
  }
  const tot = Y.reduce((a,y,i)=>a+y*rate[i],0);
  return {floor, gain:tot/base, rate};
}
console.log('\n=== ganancia esperada reasignando el MISMO presupuesto (techo 4/min) ===');
for(const f of [0.5,1.0,1.5,2.0,2.5]){
  const r = evaluate(f);
  const horasAlTope = r.rate.filter(x=>x>=CAP-1e-9).length;
  console.log(`piso ${f.toFixed(1)}/min → ganancia ${((r.gain-1)*100).toFixed(1)}%  ·  ${horasAlTope} horas al tope de ${CAP}/min`);
}
const best = evaluate(1.5);
console.log('\nAsignacion con piso 1.5/min (polls/min por hora Bogota):');
console.log(best.rate.map((r,i)=>`${String(i).padStart(2,'0')}h ${r.toFixed(2)}`).join('  '));
process.exit(0);

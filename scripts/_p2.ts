import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const TZ: Record<string,string> = {'es-co':'America/Bogota','es-pe':'America/Lima','es-mx':'America/Mexico_City'};

async function hourNorm(loc: string) {
  const tz = TZ[loc]!;
  const r = await db.execute(sql`
    WITH ap AS (
      SELECT EXTRACT(HOUR FROM ds.appeared_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::int h, count(*) n
      FROM date_sightings ds JOIN bots b ON b.id=ds.bot_id
      WHERE b.locale=${loc} AND ds.appeared_at > now()-interval '10 days' GROUP BY 1),
    ex AS (
      SELECT EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::int h,
             sum(COALESCE(p.polls_since_prev,1)) polls
      FROM poll_logs p JOIN bots b ON b.id=p.bot_id
      WHERE b.locale=${loc} AND p.created_at > now()-interval '10 days' GROUP BY 1)
    SELECT ex.h hora_local, COALESCE(ap.n,0) apariciones, ex.polls,
      round((1000.0*COALESCE(ap.n,0)/ex.polls)::numeric,2) por_1000_polls
    FROM ex LEFT JOIN ap USING (h) ORDER BY 1`);
  const rows = r.rows as any[];
  const vals = rows.map(x=>Number(x.por_1000_polls));
  const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
  console.log(`\n=== ${loc} · tasa por hora local, normalizada por polls reales (10 dias) · media=${mean.toFixed(2)} ===`);
  console.log(rows.map(x=>{
    const v=Number(x.por_1000_polls), idx=v/mean;
    return `${String(x.hora_local).padStart(2,'0')}h  ${String(x.apariciones).padStart(5)} ap  ${String(x.polls).padStart(7)} polls  ${v.toFixed(2).padStart(6)}  ${idx.toFixed(2)}x ${'#'.repeat(Math.round(idx*14))}`;
  }).join('\n'));
}
await hourNorm('es-co');
await hourNorm('es-pe');
process.exit(0);

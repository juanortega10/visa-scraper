import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

async function dow(loc:string, tz:string){
  const r = await db.execute(sql`
    WITH ap AS (SELECT to_char(ds.appeared_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz},'ID') d, count(*) n
      FROM date_sightings ds JOIN bots b ON b.id=ds.bot_id
      WHERE b.locale=${loc} AND ds.appeared_at > now()-interval '10 days' GROUP BY 1),
    ex AS (SELECT to_char(p.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz},'ID') d,
      sum(COALESCE(p.polls_since_prev,1)) polls
      FROM poll_logs p JOIN bots b ON b.id=p.bot_id
      WHERE b.locale=${loc} AND p.created_at > now()-interval '10 days' GROUP BY 1)
    SELECT ex.d, COALESCE(ap.n,0) ap, ex.polls,
      round((1000.0*COALESCE(ap.n,0)/ex.polls)::numeric,2) tasa
    FROM ex LEFT JOIN ap USING (d) ORDER BY 1`);
  const rows=r.rows as any[]; const m=rows.reduce((a,x)=>a+Number(x.tasa),0)/rows.length;
  const NM=['','Lun','Mar','Mie','Jue','Vie','Sab','Dom'];
  console.log(`\n=== ${loc} · dia de semana normalizado (media ${m.toFixed(2)}) ===`);
  console.log(rows.map(x=>`${NM[Number(x.d)]}  ${String(x.ap).padStart(5)} ap  ${String(x.tasa).padStart(6)}  ${(Number(x.tasa)/m).toFixed(2)}x ${'#'.repeat(Math.round(Number(x.tasa)/m*14))}`).join('\n'));
}
await dow('es-co','America/Bogota');
await dow('es-pe','America/Lima');

// es-co por categoria de visa
const c = await db.execute(sql`
  WITH ap AS (SELECT b.visa_category vc,
      EXTRACT(HOUR FROM ds.appeared_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::int/4 blk, count(*) n
    FROM date_sightings ds JOIN bots b ON b.id=ds.bot_id
    WHERE b.locale='es-co' AND b.visa_category IS NOT NULL AND ds.appeared_at > now()-interval '10 days'
    GROUP BY 1,2),
  ex AS (SELECT b.visa_category vc,
      EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::int/4 blk,
      sum(COALESCE(p.polls_since_prev,1)) polls
    FROM poll_logs p JOIN bots b ON b.id=p.bot_id
    WHERE b.locale='es-co' AND b.visa_category IS NOT NULL AND p.created_at > now()-interval '10 days'
    GROUP BY 1,2)
  SELECT ex.vc categoria, (ex.blk*4)||'-'||(ex.blk*4+3)||'h' franja,
    COALESCE(ap.n,0) apariciones, ex.polls,
    round((1000.0*COALESCE(ap.n,0)/ex.polls)::numeric,1) por_1000
  FROM ex LEFT JOIN ap USING (vc,blk) ORDER BY 1, ex.blk`);
console.log('\n=== es-co · tasa por franja y categoria de visa ===');
console.table(c.rows);
process.exit(0);

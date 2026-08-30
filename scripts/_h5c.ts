import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
async function q(label:string, filt:any) {
  const r = await db.execute(sql`
    WITH ap AS (SELECT DISTINCT ds.bot_id, ds.appeared_at ts FROM date_sightings ds JOIN bots b ON b.id=ds.bot_id
                WHERE ds.appeared_at > now()-interval '150 days' AND ${filt})
    SELECT FLOOR(EXTRACT(SECOND FROM ts))::int seg, count(*) n,
           round(100.0*count(*)/sum(count(*)) OVER (),2) pct
    FROM ap GROUP BY 1 ORDER BY 1`);
  const rows = r.rows as any[];
  const tot = rows.reduce((a,x)=>a+Number(x.n),0);
  console.log(`\n=== ${label} (n=${tot}, uniforme=1.67%/seg) ===`);
  console.log(rows.map(x=>`${String(x.seg).padStart(2)} ${String(x.n).padStart(6)} ${String(x.pct).padStart(5)}% ${'#'.repeat(Math.round(Number(x.pct)*3))}`).join('\n'));
}
await q('es-co', sql`b.locale='es-co'`);
await q('es-pe (cadencia 9s, maxima resolucion)', sql`b.locale='es-pe'`);
process.exit(0);

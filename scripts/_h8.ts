import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`
  WITH c AS (SELECT bot_id, date, count(*) veces FROM date_sightings
             WHERE appeared_at > now()-interval '90 days' GROUP BY 1,2)
  SELECT CASE WHEN veces=1 THEN '1 vez' WHEN veces<=3 THEN '2-3' WHEN veces<=10 THEN '4-10'
              WHEN veces<=50 THEN '11-50' ELSE '>50' END rep,
         count(*) pares_bot_fecha, sum(veces) apariciones,
         round(100.0*sum(veces)/sum(sum(veces)) OVER (),1) pct_de_apariciones
  FROM c GROUP BY 1 ORDER BY min(veces)`);
console.log('=== H8 · parpadeo: apariciones repetidas de la misma fecha ===');
console.table(r.rows);

const g = await db.execute(sql`
  WITH s AS (SELECT bot_id, date, appeared_at,
      row_number() OVER (PARTITION BY bot_id, date ORDER BY appeared_at) rn
    FROM date_sightings WHERE appeared_at > now()-interval '90 days')
  SELECT count(*) n,
    round(percentile_cont(0.25) WITHIN GROUP (ORDER BY gap)::numeric/60.0,1) p25_min,
    round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY gap)::numeric/60.0,1) p50_min,
    round(percentile_cont(0.75) WITHIN GROUP (ORDER BY gap)::numeric/60.0,1) p75_min
  FROM (SELECT EXTRACT(EPOCH FROM a.appeared_at - b.appeared_at) gap
        FROM s a JOIN s b ON a.bot_id=b.bot_id AND a.date=b.date AND a.rn=b.rn+1) x
  WHERE gap > 0`);
console.log('=== H8 · tiempo entre reapariciones de la misma fecha ===');
console.table(g.rows);
process.exit(0);

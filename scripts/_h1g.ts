import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`
  WITH d AS (
    SELECT p.bot_id, p.created_at, jsonb_array_length(b.applicant_ids) napp,
           ARRAY(SELECT x->>'date' FROM jsonb_array_elements(p.all_dates) x) AS dates
    FROM poll_logs p JOIN bots b ON b.id=p.bot_id
    WHERE p.created_at > now() - interval '10 days' AND p.all_dates IS NOT NULL
      AND p.status IN ('ok','filtered_out')
      AND b.locale='es-co' AND b.consular_facility_id='25' AND b.visa_category='B1/B2'
  ), s AS (SELECT *, (EXTRACT(EPOCH FROM created_at)::bigint/20) bkt FROM d)
  SELECT a.napp||'app superset de '||b.napp||'app' caso, count(*) n,
    round(avg(100.0 * cardinality(ARRAY(SELECT unnest(b.dates) INTERSECT SELECT unnest(a.dates)))
             / cardinality(b.dates))::numeric,1) pct_de_b_contenido_en_a
  FROM s a JOIN s b ON a.bkt=b.bkt AND a.napp < b.napp
  WHERE cardinality(a.dates)>0 AND cardinality(b.dates)>0
  GROUP BY 1 ORDER BY 1`);
console.log('=== H1 · contencion: el grupo chico ve lo del grande? ===');
console.table(r.rows);

const k = await db.execute(sql`
  SELECT jsonb_object_keys(phase_timings) k, count(*) n
  FROM poll_logs WHERE phase_timings IS NOT NULL AND created_at > now()-interval '30 days'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 20`);
console.log('=== claves de phase_timings ===');
console.table(k.rows);
process.exit(0);

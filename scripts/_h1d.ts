import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`
  WITH d AS (
    SELECT p.bot_id, p.created_at, b.visa_class_id vc, b.visa_category vcat, b.schedule_id sch,
           ARRAY(SELECT x->>'date' FROM jsonb_array_elements(p.all_dates) x) AS dates
    FROM poll_logs p JOIN bots b ON b.id=p.bot_id
    WHERE p.created_at > now() - interval '10 days' AND p.all_dates IS NOT NULL
      AND p.status IN ('ok','filtered_out')
      AND b.locale='es-co' AND b.consular_facility_id='25' AND jsonb_array_length(b.applicant_ids)=1
  ), s AS (SELECT *, (EXTRACT(EPOCH FROM created_at)::bigint/20) bkt FROM d),
  pairs AS (
    SELECT a.bot_id ba, b.bot_id bb, a.vc va, b.vc vb, a.vcat ca, b.vcat cb,
      cardinality(ARRAY(SELECT unnest(a.dates) INTERSECT SELECT unnest(b.dates))) inter,
      cardinality(ARRAY(SELECT unnest(a.dates) UNION SELECT unnest(b.dates))) uni
    FROM s a JOIN s b ON a.bkt=b.bkt AND a.bot_id<b.bot_id
    WHERE cardinality(a.dates)>0 AND cardinality(b.dates)>0
  )
  SELECT CASE WHEN va IS NULL OR vb IS NULL THEN 'clase desconocida'
              WHEN va = vb THEN 'misma clase de visa' ELSE 'clase distinta' END caso,
         count(*) n,
         round(avg(100.0*inter/uni)::numeric,1) jaccard_medio,
         round(100.0*count(*) FILTER (WHERE inter=0)/count(*),1) pct_disjuntos,
         round(100.0*count(*) FILTER (WHERE inter=uni)/count(*),1) pct_identicos
  FROM pairs GROUP BY 1 ORDER BY 2 DESC`);
console.log('=== H1 · solape segun clase de visa ===');
console.table(r.rows);

const c = await db.execute(sql`
  SELECT visa_category, visa_class_id, count(*) bots FROM bots
  WHERE locale='es-co' AND consular_facility_id='25' AND jsonb_array_length(applicant_ids)=1
    AND id IN (SELECT DISTINCT bot_id FROM poll_logs WHERE created_at>now()-interval '10 days' AND all_dates IS NOT NULL)
  GROUP BY 1,2 ORDER BY 3 DESC`);
console.log('=== clases presentes en el grupo ===');
console.table(c.rows);
process.exit(0);

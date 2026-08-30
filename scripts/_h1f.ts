import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`
  WITH d AS (
    SELECT p.bot_id, p.created_at, jsonb_array_length(b.applicant_ids) napp,
           ARRAY(SELECT x->>'date' FROM jsonb_array_elements(p.all_dates) x) AS dates
    FROM poll_logs p JOIN bots b ON b.id=p.bot_id
    WHERE p.created_at > now() - interval '10 days' AND p.all_dates IS NOT NULL
      AND p.status IN ('ok','filtered_out')
      AND b.locale='es-co' AND b.consular_facility_id='25'
      AND b.visa_category = 'B1/B2'
  ), s AS (SELECT *, (EXTRACT(EPOCH FROM created_at)::bigint/20) bkt FROM d),
  pairs AS (
    SELECT a.napp na_, b.napp nb_,
      cardinality(ARRAY(SELECT unnest(a.dates) INTERSECT SELECT unnest(b.dates))) inter,
      cardinality(ARRAY(SELECT unnest(a.dates) UNION SELECT unnest(b.dates))) uni,
      cardinality(a.dates) ca, cardinality(b.dates) cb
    FROM s a JOIN s b ON a.bkt=b.bkt AND a.bot_id<b.bot_id
    WHERE cardinality(a.dates)>0 AND cardinality(b.dates)>0
  )
  SELECT least(na_,nb_)||' vs '||greatest(na_,nb_) caso, count(*) n,
    round(avg(100.0*inter/uni)::numeric,1) jaccard_medio,
    round(100.0*count(*) FILTER (WHERE inter=0)/count(*),1) pct_disjuntos,
    round(avg(ca)::numeric,1) n_fechas_a, round(avg(cb)::numeric,1) n_fechas_b
  FROM pairs GROUP BY 1 ORDER BY 1`);
console.log('=== H1 · solape por # de solicitantes (es-co, fac 25, B1/B2) ===');
console.table(r.rows);
process.exit(0);

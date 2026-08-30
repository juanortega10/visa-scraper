import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

const r = await db.execute(sql`
  WITH d AS (
    SELECT p.id, p.bot_id, p.created_at,
           ARRAY(SELECT x->>'date' FROM jsonb_array_elements(p.all_dates) x) AS dates
    FROM poll_logs p JOIN bots b ON b.id = p.bot_id
    WHERE p.created_at > now() - interval '10 days'
      AND p.all_dates IS NOT NULL
      AND p.status IN ('ok','filtered_out')
      AND b.locale = 'es-co' AND b.consular_facility_id = '25'
      AND jsonb_array_length(b.applicant_ids) = 1
  ), s AS (
    SELECT *, (EXTRACT(EPOCH FROM created_at)::bigint / 20) AS bkt FROM d
  ), pairs AS (
    SELECT a.bot_id ba, b.bot_id bb,
           cardinality(a.dates) na, cardinality(b.dates) nb,
           cardinality(ARRAY(SELECT unnest(a.dates) INTERSECT SELECT unnest(b.dates))) AS inter,
           cardinality(ARRAY(SELECT unnest(a.dates) UNION SELECT unnest(b.dates))) AS uni,
           abs(EXTRACT(EPOCH FROM a.created_at - b.created_at)) AS dt
    FROM s a JOIN s b ON a.bkt = b.bkt AND a.bot_id < b.bot_id
  )
  SELECT count(*) pares,
         count(DISTINCT ba||'-'||bb) combos,
         round(avg(dt)::numeric,1) dt_medio_s,
         round(avg(na)::numeric,1) avg_n_a, round(avg(nb)::numeric,1) avg_n_b,
         round(avg(CASE WHEN uni>0 THEN 100.0*inter/uni END)::numeric,1) jaccard_pct,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE WHEN uni>0 THEN 100.0*inter/uni END))::numeric,1) jaccard_p50,
         round(100.0*count(*) FILTER (WHERE inter = uni AND uni > 0)/NULLIF(count(*) FILTER (WHERE uni>0),0),1) pct_identicos,
         round(100.0*count(*) FILTER (WHERE uni = 0)/count(*),1) pct_ambos_vacios,
         round(100.0*count(*) FILTER (WHERE inter = 0 AND uni > 0)/count(*),1) pct_disjuntos
  FROM pairs`);
console.log('=== H1 · solape de conjuntos visibles (es-co, fac 25, 1 solicitante, polls <20s aparte) ===');
console.table(r.rows);
process.exit(0);

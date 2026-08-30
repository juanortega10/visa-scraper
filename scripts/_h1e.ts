import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`
  WITH d AS (
    SELECT p.bot_id, p.created_at, b.visa_category vcat,
           ARRAY(SELECT x->>'date' FROM jsonb_array_elements(p.all_dates) x) AS dates
    FROM poll_logs p JOIN bots b ON b.id=p.bot_id
    WHERE p.created_at > now() - interval '10 days' AND p.all_dates IS NOT NULL
      AND p.status IN ('ok','filtered_out')
      AND b.locale='es-co' AND b.consular_facility_id='25' AND jsonb_array_length(b.applicant_ids)=1
      AND b.visa_category IS NOT NULL
  ), s AS (SELECT *, (EXTRACT(EPOCH FROM created_at)::bigint/20) bkt FROM d),
  pairs AS (
    SELECT a.bot_id ba, b.bot_id bb, a.vcat ca, b.vcat cb,
      cardinality(ARRAY(SELECT unnest(a.dates) INTERSECT SELECT unnest(b.dates))) inter,
      cardinality(ARRAY(SELECT unnest(a.dates) UNION SELECT unnest(b.dates))) uni
    FROM s a JOIN s b ON a.bkt=b.bkt AND a.bot_id<b.bot_id
    WHERE cardinality(a.dates)>0 AND cardinality(b.dates)>0
  )
  SELECT CASE WHEN ca=cb THEN 'misma categoria: '||ca ELSE 'distinta: '||least(ca,cb)||'/'||greatest(ca,cb) END caso,
    count(*) n, count(DISTINCT ba||'-'||bb) combos,
    round(avg(100.0*inter/uni)::numeric,1) jaccard_medio,
    round(100.0*count(*) FILTER (WHERE inter=0)/count(*),1) pct_disjuntos,
    round(100.0*count(*) FILTER (WHERE inter=uni)/count(*),1) pct_identicos
  FROM pairs GROUP BY 1 ORDER BY 2 DESC`);
console.log('=== H1 · solape por categoria de visa (es-co, fac 25, 1 solicitante) ===');
console.table(r.rows);
process.exit(0);

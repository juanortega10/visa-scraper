import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

// Build per-poll date sets (es-co, facility 25, last 10 days), join bot meta.
// Then self-join within +/-3s window (tighter than original 20s bucket) and compute per-pair Jaccard.
const r = await db.execute(sql`
WITH polls AS (
  SELECT pl.id, pl.bot_id, pl.created_at,
         (SELECT array_agg(x->>'date') FROM jsonb_array_elements(pl.all_dates) x) AS dates
  FROM poll_logs pl
  JOIN bots b ON b.id = pl.bot_id
  WHERE pl.all_dates IS NOT NULL AND pl.status IN ('ok','filtered_out')
    AND pl.created_at > now() - interval '10 days'
    AND b.locale = 'es-co' AND b.consular_facility_id = '25'
),
meta AS (
  SELECT id, visa_category, jsonb_array_length(applicant_ids) as napp, proxy_provider FROM bots
)
SELECT a.bot_id as bot_a, ma.visa_category as cat_a, ma.napp as napp_a,
       b.bot_id as bot_b, mb.visa_category as cat_b, mb.napp as napp_b,
       count(*) as n_pairs,
       round(avg(
         (SELECT count(*) FROM unnest(a.dates) d WHERE d = ANY(b.dates))::numeric /
         NULLIF(cardinality(array(SELECT unnest(a.dates) UNION SELECT unnest(b.dates))),0)
       ), 4) as mean_jaccard
FROM polls a
JOIN polls b ON a.bot_id < b.bot_id
  AND abs(extract(epoch from a.created_at - b.created_at)) <= 3
JOIN meta ma ON ma.id = a.bot_id
JOIN meta mb ON mb.id = b.bot_id
WHERE (ma.visa_category IN ('B1/B2') AND mb.visa_category IN ('B1/B2') AND ma.napp=1 AND mb.napp=1)
   OR (ma.visa_category = 'B1/B2' AND mb.visa_category = 'F1')
   OR (ma.visa_category = 'B1/B2' AND mb.visa_category = 'J1')
   OR (ma.visa_category = 'F1' AND mb.visa_category = 'J1')
GROUP BY a.bot_id, ma.visa_category, ma.napp, b.bot_id, mb.visa_category, mb.napp
ORDER BY ma.visa_category, mb.visa_category, n_pairs DESC
`);
console.table(r.rows);
process.exit(0);

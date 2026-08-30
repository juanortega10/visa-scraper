import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

// Gap distribution: how much resolution do we actually have?
const g = await db.execute(sql`
  WITH s AS (
    SELECT bot_id, created_at,
           EXTRACT(EPOCH FROM created_at - lag(created_at) OVER (PARTITION BY bot_id ORDER BY created_at)) AS gap,
           jsonb_array_length(date_changes->'appeared') AS app
    FROM poll_logs WHERE created_at > now() - interval '10 days'
  )
  SELECT CASE WHEN gap < 15 THEN 'a <15s' WHEN gap < 30 THEN 'b 15-30s'
              WHEN gap < 60 THEN 'c 30-60s' WHEN gap < 130 THEN 'd 60-130s'
              WHEN gap < 330 THEN 'e 130-330s' ELSE 'f >330s' END bucket,
         count(*) polls, round(avg(gap)::numeric,1) avg_gap,
         count(*) FILTER (WHERE app>0) appear_polls,
         round(100.0*count(*) FILTER (WHERE app>0)/count(*),2) pct
  FROM s WHERE gap IS NOT NULL GROUP BY 1 ORDER BY 1`);
console.log('=== GAP DISTRIBUTION (exposure) ===');
console.table(g.rows);
process.exit(0);

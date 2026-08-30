import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`
  SELECT reschedule_result, count(*) n,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (phase_timings->>'load')::int)) load_p50_ms,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (phase_timings->>'fetch')::int)) fetch_p50_ms,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY response_time_ms)) total_p50_ms,
    round(100.0*count(*) FILTER (WHERE relogin_happened)/count(*),1) pct_relogin
  FROM poll_logs
  WHERE created_at > now()-interval '30 days' AND reschedule_result IS NOT NULL
  GROUP BY 1 ORDER BY 2 DESC`);
console.log('=== H2b · latencia previa segun resultado ===');
console.table(r.rows);

const s = await db.execute(sql`
  WITH e AS (
    SELECT be.date, be.outcome, be.bot_id, be.detected_at,
      (SELECT ds.duration_ms FROM date_sightings ds
        WHERE ds.bot_id=be.bot_id AND ds.date=be.date
          AND ds.appeared_at <= be.detected_at + interval '2 min'
          AND ds.appeared_at >= be.detected_at - interval '10 min'
        ORDER BY ds.appeared_at DESC LIMIT 1) AS life_ms
    FROM bookable_events be WHERE be.detected_at > now()-interval '90 days'
  )
  SELECT outcome, count(*) n, count(life_ms) con_vida,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY life_ms)/1000.0) vida_p50_s
  FROM e GROUP BY 1 ORDER BY 2 DESC LIMIT 8`);
console.log('=== H2b · vida util de la ranura segun desenlace ===');
console.table(s.rows);
process.exit(0);

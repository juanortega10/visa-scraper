import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const a = await db.execute(sql`
  SELECT classification, count(*) n,
    count(*) FILTER (WHERE ended_at IS NULL) abiertos,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_min)::numeric,0) dur_p50_min,
    round(percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_min)::numeric,0) dur_p90_min,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY poll_count)::numeric,0) polls_p50,
    min(started_at)::date desde, max(started_at)::date hasta
  FROM ban_episodes GROUP BY 1 ORDER BY 2 DESC`);
console.log('=== episodios de bloqueo por clasificacion ===');
console.table(a.rows);

const s = await db.execute(sql`
  SELECT status, count(*) filas, sum(COALESCE(polls_since_prev,1)) polls_reales,
    round(100.0*sum(COALESCE(polls_since_prev,1))/sum(sum(COALESCE(polls_since_prev,1))) OVER (),2) pct
  FROM poll_logs WHERE created_at > now()-interval '10 days' GROUP BY 1 ORDER BY 3 DESC`);
console.log('=== estados de poll (10 dias, conteo real) ===');
console.table(s.rows);

const c = await db.execute(sql`
  SELECT connection_info->>'blockClassification' cls, connection_info->>'tcpSubcategory' sub,
    count(*) n FROM poll_logs
  WHERE created_at > now()-interval '30 days' AND connection_info->>'blockClassification' IS NOT NULL
  GROUP BY 1,2 ORDER BY 3 DESC LIMIT 15`);
console.log('=== clasificacion de bloqueo TCP ===');
console.table(c.rows);
process.exit(0);

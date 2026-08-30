import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// Cadencia real por bot = tiempo total transcurrido / polls reales totales
const r = await db.execute(sql`
  WITH per_bot AS (
    SELECT p.bot_id, b.locale,
      sum(COALESCE(p.polls_since_prev,1)) polls,
      EXTRACT(EPOCH FROM max(p.created_at)-min(p.created_at)) segs,
      count(*) filas
    FROM poll_logs p JOIN bots b ON b.id=p.bot_id
    WHERE p.created_at > now()-interval '10 days'
    GROUP BY 1,2 HAVING count(*) > 50 AND EXTRACT(EPOCH FROM max(p.created_at)-min(p.created_at)) > 86400)
  SELECT locale, count(*) bots, sum(polls) polls_totales,
    round(avg(segs/NULLIF(polls,0))::numeric,1) cadencia_real_s_media,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY segs/NULLIF(polls,0))::numeric,1) cadencia_real_s_p50,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY 60.0*polls/NULLIF(segs,0))::numeric,2) polls_por_min_p50,
    round(percentile_cont(0.9) WITHIN GROUP (ORDER BY 60.0*polls/NULLIF(segs,0))::numeric,2) polls_por_min_p90
  FROM per_bot GROUP BY 1 ORDER BY 3 DESC`);
console.log('=== cadencia REAL por bot (tiempo total / polls reales), 10 dias ===');
console.table(r.rows);
process.exit(0);

import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// Durante un bloqueo sostenido, a que ritmo seguimos golpeando, por tipo?
const r = await db.execute(sql`
  WITH s AS (
    SELECT bot_id, created_at, status,
      EXTRACT(EPOCH FROM created_at - lag(created_at) OVER (PARTITION BY bot_id ORDER BY created_at)) gap,
      lag(status) OVER (PARTITION BY bot_id ORDER BY created_at) prev
    FROM poll_logs WHERE created_at > now()-interval '30 days')
  SELECT status, prev AS estado_previo, count(*) n,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)::numeric,1) gap_p50_s,
    round(percentile_cont(0.9) WITHIN GROUP (ORDER BY gap)::numeric,1) gap_p90_s
  FROM s WHERE status IN ('soft_ban','tcp_blocked') AND prev IN ('soft_ban','tcp_blocked')
  GROUP BY 1,2 ORDER BY 3 DESC`);
console.log('=== cadencia MIENTRAS estamos bloqueados (deberia ser lenta) ===');
console.table(r.rows);

// Cuanto dura una racha de soft_ban y cuantos polls gastamos en ella
const b = await db.execute(sql`
  WITH s AS (
    SELECT bot_id, created_at, status,
      CASE WHEN status='soft_ban' AND lag(status) OVER w IS DISTINCT FROM 'soft_ban' THEN 1 ELSE 0 END nuevo
    FROM poll_logs WHERE created_at > now()-interval '30 days'
    WINDOW w AS (PARTITION BY bot_id ORDER BY created_at)),
  g AS (SELECT *, sum(nuevo) OVER (PARTITION BY bot_id ORDER BY created_at) grp FROM s WHERE status='soft_ban')
  SELECT count(DISTINCT bot_id||'-'||grp) rachas,
    round(avg(c)::numeric,1) polls_medios_por_racha,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY dur)::numeric,0) dur_p50_min
  FROM (SELECT bot_id, grp, count(*) c,
          EXTRACT(EPOCH FROM max(created_at)-min(created_at))/60 dur
        FROM g GROUP BY 1,2) x`);
console.log('=== rachas de soft_ban ===');
console.table(b.rows);
process.exit(0);

import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// HB3: curva de riesgo contra tasa instantanea, normalizada por exposicion
const r = await db.execute(sql`
  WITH p AS (
    SELECT (connection_info->>'pollRateRecentPerMin')::float tasa, status,
      COALESCE(polls_since_prev,1) w
    FROM poll_logs
    WHERE created_at > now()-interval '30 days'
      AND connection_info->>'pollRateRecentPerMin' IS NOT NULL)
  SELECT CASE WHEN tasa < 1 THEN 'a <1/min' WHEN tasa < 2 THEN 'b 1-2' WHEN tasa < 3 THEN 'c 2-3'
              WHEN tasa < 4 THEN 'd 3-4' WHEN tasa < 6 THEN 'e 4-6' WHEN tasa < 8 THEN 'f 6-8'
              ELSE 'g >=8' END franja_tasa,
    sum(w) polls, count(*) filas,
    round(100.0*count(*) FILTER (WHERE status='tcp_blocked')/count(*),3) pct_tcp,
    round(100.0*count(*) FILTER (WHERE status='soft_ban')/count(*),3) pct_soft,
    round(100.0*count(*) FILTER (WHERE status IN ('tcp_blocked','soft_ban'))/count(*),3) pct_bloqueo
  FROM p GROUP BY 1 ORDER BY 1`);
console.log('=== HB3 · riesgo de bloqueo contra tasa instantanea (30 dias) ===');
console.table(r.rows);

// HB4: riesgo por hora Bogota — pollear en la franja buena es mas riesgoso?
const h = await db.execute(sql`
  SELECT EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::int/3*3 franja,
    count(*) filas,
    round(100.0*count(*) FILTER (WHERE status IN ('tcp_blocked','soft_ban'))/count(*),3) pct_bloqueo,
    round(100.0*count(*) FILTER (WHERE status='error')/count(*),2) pct_error
  FROM poll_logs p JOIN bots b ON b.id=p.bot_id
  WHERE p.created_at > now()-interval '30 days' AND b.locale='es-co'
  GROUP BY 1 ORDER BY 1`);
console.log('=== HB4 · riesgo por franja horaria Bogota (es-co) ===');
console.table(h.rows);
process.exit(0);

import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// HB5: el techo es por bot o por IP? Tasa agregada por IP en ventanas de 1 min vs riesgo
const r = await db.execute(sql`
  WITH m AS (
    SELECT public_ip, date_trunc('minute', created_at) min,
      sum(COALESCE(polls_since_prev,1)) polls_ip,
      count(DISTINCT bot_id) bots,
      count(*) FILTER (WHERE status IN ('tcp_blocked','soft_ban')) bloqueos,
      count(*) filas
    FROM poll_logs
    WHERE created_at > now()-interval '30 days' AND public_ip IS NOT NULL AND public_ip <> ''
    GROUP BY 1,2)
  SELECT CASE WHEN polls_ip<=2 THEN 'a 1-2/min' WHEN polls_ip<=4 THEN 'b 3-4'
              WHEN polls_ip<=8 THEN 'c 5-8' WHEN polls_ip<=16 THEN 'd 9-16'
              WHEN polls_ip<=32 THEN 'e 17-32' ELSE 'f >32' END polls_por_ip_por_min,
    count(*) minutos_ip, round(avg(bots)::numeric,1) bots_medios,
    sum(filas) filas, sum(bloqueos) bloqueos,
    round(100.0*sum(bloqueos)/sum(filas),3) pct_bloqueo
  FROM m GROUP BY 1 ORDER BY 1`);
console.log('=== HB5 · riesgo contra polls por IP por minuto (30 dias) ===');
console.table(r.rows);

const i = await db.execute(sql`
  SELECT count(DISTINCT public_ip) ips, count(DISTINCT bot_id) bots
  FROM poll_logs WHERE created_at > now()-interval '10 days' AND public_ip IS NOT NULL AND public_ip <> ''`);
console.log('IPs y bots distintos (10 dias):', i.rows[0]);
process.exit(0);

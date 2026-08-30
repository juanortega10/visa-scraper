import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const nulls = await db.execute(sql`
  SELECT status, count(*) filas, count(raw_dates_count) con_dato,
    round(100.0*count(raw_dates_count)/count(*),1) pct_con_dato
  FROM poll_logs WHERE created_at > now()-interval '90 days'
    AND status IN ('ok','filtered_out','soft_ban') GROUP BY 1`);
console.log('=== cobertura de raw_dates_count (mi error anterior) ===');
console.table(nulls.rows);

const r = await db.execute(sql`
  WITH sb AS (
    SELECT p.id, p.bot_id, p.created_at, b.consular_facility_id fac, b.locale
    FROM poll_logs p JOIN bots b ON b.id=p.bot_id
    WHERE p.status='soft_ban' AND p.created_at > now()-interval '90 days'),
  peer AS (
    SELECT sb.id,
      (SELECT max(p2.raw_dates_count) FROM poll_logs p2 JOIN bots b2 ON b2.id=p2.bot_id
       WHERE b2.locale=sb.locale AND b2.consular_facility_id=sb.fac AND p2.bot_id <> sb.bot_id
         AND p2.created_at BETWEEN sb.created_at - interval '90 seconds' AND sb.created_at + interval '90 seconds'
         AND p2.status IN ('ok','filtered_out')
         AND p2.raw_dates_count IS NOT NULL) AS pico,
      (SELECT count(DISTINCT p2.bot_id) FROM poll_logs p2 JOIN bots b2 ON b2.id=p2.bot_id
       WHERE b2.locale=sb.locale AND b2.consular_facility_id=sb.fac AND p2.bot_id <> sb.bot_id
         AND p2.created_at BETWEEN sb.created_at - interval '90 seconds' AND sb.created_at + interval '90 seconds'
         AND p2.raw_dates_count IS NOT NULL) AS n_peers
    FROM sb)
  SELECT CASE WHEN pico IS NULL THEN 'sin companero con dato'
              WHEN pico = 0 THEN 'todos los companeros en 0'
              WHEN pico <= 2 THEN 'mejor companero 1-2'
              WHEN pico <= 20 THEN 'mejor companero 3-20'
              ELSE 'mejor companero >20 (calendario SANO)' END caso,
    count(*) n, round(100.0*count(*)/sum(count(*)) OVER (),1) pct,
    round(avg(n_peers)::numeric,1) companeros_medios
  FROM peer GROUP BY 1 ORDER BY 2 DESC`);
console.log('=== soft_ban: mejor companero del mismo consulado, SOLO filas con dato real ===');
console.table(r.rows);
process.exit(0);

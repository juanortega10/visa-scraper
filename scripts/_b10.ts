import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// PRUEBA DECISIVA: cuando un bot esta en soft_ban, sus companeros de cohorte ven fechas?
const r = await db.execute(sql`
  WITH sb AS (
    SELECT p.id, p.bot_id, p.created_at, b.consular_facility_id fac, b.locale,
           COALESCE(p.raw_dates_count,0) mias
    FROM poll_logs p JOIN bots b ON b.id=p.bot_id
    WHERE p.status='soft_ban' AND p.created_at > now()-interval '90 days'),
  peer AS (
    SELECT sb.id, sb.bot_id, sb.mias,
      (SELECT max(COALESCE(p2.raw_dates_count,0)) FROM poll_logs p2 JOIN bots b2 ON b2.id=p2.bot_id
       WHERE b2.locale=sb.locale AND b2.consular_facility_id=sb.fac AND p2.bot_id <> sb.bot_id
         AND p2.created_at BETWEEN sb.created_at - interval '60 seconds' AND sb.created_at + interval '60 seconds'
         AND p2.status IN ('ok','filtered_out')) AS max_companeros
    FROM sb)
  SELECT CASE WHEN max_companeros IS NULL THEN 'sin companero en la ventana'
              WHEN max_companeros = 0 THEN 'companeros tambien en 0'
              WHEN max_companeros <= 2 THEN 'companeros en 1-2'
              WHEN max_companeros <= 20 THEN 'companeros en 3-20'
              ELSE 'companeros con >20 fechas' END caso,
    count(*) n, round(100.0*count(*)/sum(count(*)) OVER (),1) pct,
    round(avg(max_companeros)::numeric,1) media_companeros
  FROM peer GROUP BY 1 ORDER BY 2 DESC`);
console.log('=== durante un soft_ban, que ven los otros bots del mismo consulado (±60s)? ===');
console.table(r.rows);
process.exit(0);

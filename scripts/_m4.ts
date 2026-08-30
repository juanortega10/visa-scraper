import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// PRUEBA FUERTE del calendario vacio: la cohorte cae y se recupera JUNTA?
// Restrinjo a compañeros de la MISMA categoria de visa y ventana de 90s.
const r = await db.execute(sql`
  WITH sb AS (
    SELECT p.id, p.bot_id, p.created_at, b.consular_facility_id fac, b.locale,
           COALESCE(b.visa_category,'?') cat
    FROM poll_logs p JOIN bots b ON b.id=p.bot_id
    WHERE p.status='soft_ban' AND p.created_at > now()-interval '90 days'),
  peer AS (
    SELECT sb.id,
      (SELECT max(COALESCE(p2.raw_dates_count,0)) FROM poll_logs p2 JOIN bots b2 ON b2.id=p2.bot_id
       WHERE b2.locale=sb.locale AND b2.consular_facility_id=sb.fac
         AND COALESCE(b2.visa_category,'?') = sb.cat
         AND p2.bot_id <> sb.bot_id
         AND p2.created_at BETWEEN sb.created_at - interval '90 seconds' AND sb.created_at + interval '90 seconds'
         AND p2.status IN ('ok','filtered_out')) AS pico_companeros
    FROM sb)
  SELECT CASE WHEN pico_companeros IS NULL THEN 'sin companero de la misma categoria'
              WHEN pico_companeros = 0 THEN 'companeros tambien en 0'
              WHEN pico_companeros <= 2 THEN 'companeros 1-2'
              WHEN pico_companeros <= 20 THEN 'companeros 3-20'
              ELSE 'companeros >20' END caso, count(*) n,
    round(100.0*count(*)/sum(count(*)) OVER (),1) pct
  FROM peer GROUP BY 1 ORDER BY 2 DESC`);
console.log('=== soft_ban: companeros de la MISMA categoria (±90s) ===');
console.table(r.rows);

// Caida y recuperacion: como se ve la flota entera minuto a minuto alrededor de un soft_ban
const t = await db.execute(sql`
  WITH ev AS (SELECT DISTINCT bot_id, date_trunc('minute',created_at) m FROM poll_logs
              WHERE status='soft_ban' AND created_at > now()-interval '90 days'),
  fleet AS (
    SELECT ev.m, o.off,
      round(avg(COALESCE(p.raw_dates_count,0))::numeric,1) media_flota
    FROM ev CROSS JOIN generate_series(-10,10) o(off)
    JOIN poll_logs p ON p.created_at >= ev.m + (o.off||' minutes')::interval
      AND p.created_at < ev.m + ((o.off+1)||' minutes')::interval
      AND p.bot_id <> ev.bot_id AND p.status IN ('ok','filtered_out')
    JOIN bots b ON b.id=p.bot_id WHERE b.locale='es-co'
    GROUP BY 1,2)
  SELECT off AS minutos_desde_el_soft_ban, count(*) muestras,
    round(avg(media_flota)::numeric,1) fechas_medias_del_resto_de_la_flota
  FROM fleet GROUP BY 1 ORDER BY 1`);
console.log('=== que ve el RESTO de la flota antes, durante y despues ===');
console.table(t.rows);
process.exit(0);

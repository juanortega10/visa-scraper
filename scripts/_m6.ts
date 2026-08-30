import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// Para cada instante de soft_ban, el ULTIMO dato conocido de CADA otro bot es-co
// dentro de los 6 minutos previos (incluye filas de latido, no solo cambios).
const r = await db.execute(sql`
  WITH sb AS (
    SELECT p.id, p.bot_id, p.created_at FROM poll_logs p JOIN bots b ON b.id=p.bot_id
    WHERE p.status='soft_ban' AND b.locale='es-co' AND p.created_at > now()-interval '90 days'),
  last_known AS (
    SELECT sb.id, p2.bot_id AS peer,
      (array_agg(p2.raw_dates_count ORDER BY p2.created_at DESC))[1] AS ult
    FROM sb JOIN poll_logs p2 ON p2.bot_id <> sb.bot_id
      AND p2.created_at BETWEEN sb.created_at - interval '6 minutes' AND sb.created_at
      AND p2.status IN ('ok','filtered_out')
    JOIN bots b2 ON b2.id=p2.bot_id AND b2.locale='es-co'
    GROUP BY 1,2)
  SELECT count(DISTINCT id) instantes_soft_ban,
    round(avg(npeers)::numeric,1) companeros_medios,
    round(avg(mx)::numeric,1) max_medio,
    round(avg(med)::numeric,1) mediana_media,
    round(100.0*count(*) FILTER (WHERE mx > 20)/count(*),1) pct_con_algun_companero_sano,
    round(100.0*count(*) FILTER (WHERE med > 20)/count(*),1) pct_con_MAYORIA_sana
  FROM (SELECT id, count(*) npeers, max(ult) mx,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY ult) med
        FROM last_known GROUP BY 1) x`);
console.log('=== PRUEBA LIMPIA: estado de la flota es-co en cada instante de soft_ban ===');
console.table(r.rows);
process.exit(0);

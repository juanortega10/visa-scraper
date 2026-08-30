import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// H16: si el lote sale en el segundo ~14, detectar en el seg 16 = 2s de retraso;
// detectar en el seg 45 = 31s de retraso. Convierte mejor la deteccion temprana?
const r = await db.execute(sql`
  WITH e AS (
    SELECT be.outcome, FLOOR(EXTRACT(SECOND FROM be.detected_at))::int seg
    FROM bookable_events be
    WHERE be.detected_at > now()-interval '90 days')
  SELECT CASE WHEN seg BETWEEN 14 AND 21 THEN 'a seg 14-21 (retraso ~0-7s)'
              WHEN seg BETWEEN 22 AND 29 THEN 'b seg 22-29 (~8-15s)'
              WHEN seg BETWEEN 30 AND 39 THEN 'c seg 30-39 (~16-25s)'
              WHEN seg BETWEEN 40 AND 55 THEN 'd seg 40-55 (~26-41s)'
              ELSE 'e seg 56-13 (fuera de lote)' END franja,
    count(*) n,
    round(100.0*count(*) FILTER (WHERE outcome='success')/count(*),2) pct_exito,
    round(100.0*count(*) FILTER (WHERE outcome='no_times')/count(*),1) pct_no_times,
    round(100.0*count(*) FILTER (WHERE outcome='no_cas_days')/count(*),1) pct_no_cas
  FROM e GROUP BY 1 ORDER BY 1`);
console.log('=== H16 · conversion segun retraso desde el lote ===');
console.table(r.rows);

// Controlado: solo eventos donde CAS no es el muro (fecha nueva a >=30 dias)
const c = await db.execute(sql`
  WITH e AS (
    SELECT be.outcome, FLOOR(EXTRACT(SECOND FROM be.detected_at))::int seg
    FROM bookable_events be
    WHERE be.detected_at > now()-interval '90 days'
      AND be.consular_date_at_detection IS NOT NULL
      AND (be.date - be.detected_at::date) BETWEEN 30 AND 119)
  SELECT CASE WHEN seg BETWEEN 14 AND 21 THEN 'a 14-21' WHEN seg BETWEEN 22 AND 29 THEN 'b 22-29'
              WHEN seg BETWEEN 30 AND 39 THEN 'c 30-39' WHEN seg BETWEEN 40 AND 55 THEN 'd 40-55'
              ELSE 'e fuera' END franja,
    count(*) n,
    round(100.0*count(*) FILTER (WHERE outcome='success')/count(*),2) pct_exito,
    round(100.0*count(*) FILTER (WHERE outcome='no_times')/count(*),1) pct_no_times
  FROM e GROUP BY 1 ORDER BY 1`);
console.log('=== H16 controlado · solo fechas a 30-119 dias (sin muro CAS) ===');
console.table(c.rows);
process.exit(0);

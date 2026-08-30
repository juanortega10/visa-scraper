import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// H15: no_cas_days depende de cuantos dias faltan para la cita actual?
// La cita CAS debe caer ANTES de la consular. Si la consular esta cerca, no hay espacio.
const r = await db.execute(sql`
  WITH e AS (
    SELECT outcome, date,
      (consular_date_at_detection - detected_at::date) AS dias_hasta_cita,
      (date - detected_at::date) AS dias_hasta_nueva
    FROM bookable_events
    WHERE detected_at > now()-interval '90 days' AND consular_date_at_detection IS NOT NULL)
  SELECT CASE WHEN dias_hasta_nueva < 7 THEN 'a <7d'
              WHEN dias_hasta_nueva < 14 THEN 'b 7-13d'
              WHEN dias_hasta_nueva < 30 THEN 'c 14-29d'
              WHEN dias_hasta_nueva < 60 THEN 'd 30-59d'
              WHEN dias_hasta_nueva < 120 THEN 'e 60-119d'
              ELSE 'f >=120d' END ventana_a_la_nueva_cita,
    count(*) n,
    round(100.0*count(*) FILTER (WHERE outcome='no_cas_days')/count(*),1) pct_no_cas,
    round(100.0*count(*) FILTER (WHERE outcome='no_times')/count(*),1) pct_no_times,
    round(100.0*count(*) FILTER (WHERE outcome='success')/count(*),1) pct_exito
  FROM e GROUP BY 1 ORDER BY 1`);
console.log('=== H15 · desenlace segun cuan CERCA esta la nueva fecha ===');
console.table(r.rows);

const c = await db.execute(sql`
  WITH e AS (
    SELECT outcome, (consular_date_at_detection - detected_at::date) AS d FROM bookable_events
    WHERE detected_at > now()-interval '90 days' AND consular_date_at_detection IS NOT NULL)
  SELECT CASE WHEN d<0 THEN 'a cita ya paso' WHEN d<14 THEN 'b <14d' WHEN d<30 THEN 'c 14-29d'
              WHEN d<90 THEN 'd 30-89d' WHEN d<180 THEN 'e 90-179d' ELSE 'f >=180d' END dias_hasta_cita_actual,
    count(*) n,
    round(100.0*count(*) FILTER (WHERE outcome='no_cas_days')/count(*),1) pct_no_cas,
    round(100.0*count(*) FILTER (WHERE outcome='success')/count(*),1) pct_exito
  FROM e GROUP BY 1 ORDER BY 1`);
console.log('=== H15 · desenlace segun dias hasta la cita ACTUAL del bot ===');
console.table(c.rows);
process.exit(0);

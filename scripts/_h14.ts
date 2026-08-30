import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`
  WITH pb AS (
    SELECT bot_id, count(*) n,
      max(CASE WHEN outcome IN ('no_cas_days','no_times') THEN 1 ELSE 0 END) dummy,
      100.0*count(*) FILTER (WHERE outcome='no_cas_days')/count(*) p_cas,
      100.0*count(*) FILTER (WHERE outcome='no_times')/count(*) p_times,
      100.0*count(*) FILTER (WHERE outcome='success')/count(*) p_ok
    FROM bookable_events WHERE detected_at > now()-interval '90 days' GROUP BY 1)
  SELECT CASE WHEN p_cas>=90 THEN 'a atascado en CAS (>=90%)'
              WHEN p_times>=90 THEN 'b atascado en times (>=90%)'
              WHEN p_ok=0 THEN 'c cero exitos, mixto'
              ELSE 'd convierte' END clase,
    count(*) bots, sum(n) eventos,
    round(100.0*sum(n)/sum(sum(n)) OVER (),1) pct_eventos,
    round(avg(p_ok)::numeric,2) pct_exito_medio
  FROM pb GROUP BY 1 ORDER BY 1`);
console.log('=== H14 · bots estructuralmente atascados (90 dias) ===');
console.table(r.rows);

const s = await db.execute(sql`
  SELECT id, sniper_mode, max_reschedules, reschedule_count, target_date_before,
         current_consular_date, current_cas_date, status
  FROM bots WHERE id IN (261,260,290,173,161,212,283) ORDER BY id`);
console.log('=== config de los atascados ===');
console.table(s.rows);
process.exit(0);

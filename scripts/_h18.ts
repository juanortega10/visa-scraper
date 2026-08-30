import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`
  WITH pb AS (
    SELECT be.bot_id, b.current_cas_date IS NOT NULL AS tiene_cas, count(*) n,
      100.0*count(*) FILTER (WHERE outcome='no_cas_days')/count(*) p_cas,
      100.0*count(*) FILTER (WHERE outcome='no_times')/count(*) p_times,
      100.0*count(*) FILTER (WHERE outcome='success')/count(*) p_ok
    FROM bookable_events be JOIN bots b ON b.id=be.bot_id
    WHERE be.detected_at > now()-interval '90 days' GROUP BY 1,2 HAVING count(*)>=30)
  SELECT tiene_cas, count(*) bots, sum(n) eventos,
    round(avg(p_cas)::numeric,1) medio_no_cas, round(avg(p_times)::numeric,1) medio_no_times,
    round(avg(p_ok)::numeric,1) medio_exito
  FROM pb GROUP BY 1`);
console.log('=== H18 · el muro depende de si el bot necesita CAS ===');
console.table(r.rows);
process.exit(0);

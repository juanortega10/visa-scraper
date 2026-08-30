import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const c = await db.execute(sql`
  SELECT date_trunc('week', created_at)::date semana, count(*) n,
    round(avg(total_dates)::numeric,1) fechas_cas_evaluadas,
    round(avg(full_dates)::numeric,1) llenas,
    round(avg(100.0*full_dates/NULLIF(total_dates,0))::numeric,1) pct_llenas,
    round(avg(low_dates)::numeric,1) pocas_ranuras,
    round(avg(request_count)::numeric,1) requests
  FROM cas_prefetch_logs WHERE error IS NULL GROUP BY 1 ORDER BY 1`);
console.log('=== H13 · saturacion CAS por semana ===');
console.table(c.rows);

const e = await db.execute(sql`
  SELECT error IS NOT NULL as con_error, count(*) n,
    round(100.0*count(*)/sum(count(*)) OVER (),1) pct FROM cas_prefetch_logs GROUP BY 1`);
console.table(e.rows);

// no_cas_days por bot: es estructural del bot o del momento?
const b = await db.execute(sql`
  SELECT be.bot_id, b.locale, b.asc_facility_id asc_fac, count(*) n,
    round(100.0*count(*) FILTER (WHERE outcome='no_cas_days')/count(*),1) pct_no_cas,
    round(100.0*count(*) FILTER (WHERE outcome='no_times')/count(*),1) pct_no_times,
    round(100.0*count(*) FILTER (WHERE outcome='success')/count(*),1) pct_ok
  FROM bookable_events be JOIN bots b ON b.id=be.bot_id
  WHERE be.detected_at > now()-interval '90 days'
  GROUP BY 1,2,3 HAVING count(*)>=100 ORDER BY 5 DESC LIMIT 20`);
console.log('=== H13 · no_cas_days por bot (>=100 eventos) ===');
console.table(b.rows);
process.exit(0);

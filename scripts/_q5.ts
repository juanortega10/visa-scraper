import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`
  SELECT CASE WHEN days_from_now < 0 THEN 'a pasada'
              WHEN days_from_now <= 7   THEN 'b 0-7d'
              WHEN days_from_now <= 30  THEN 'c 8-30d'
              WHEN days_from_now <= 90  THEN 'd 31-90d'
              WHEN days_from_now <= 180 THEN 'e 91-180d'
              ELSE 'f >180d' END bucket,
         count(*) n,
         round((percentile_cont(0.25) WITHIN GROUP (ORDER BY duration_ms))/1000.0) p25_s,
         round((percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms))/1000.0) p50_s,
         round((percentile_cont(0.75) WITHIN GROUP (ORDER BY duration_ms))/1000.0) p75_s,
         round(100.0*count(*) FILTER (WHERE duration_ms < 60000)/count(*),1) pct_lt_60s
  FROM date_sightings
  WHERE disappeared_at IS NOT NULL AND duration_ms > 0
  GROUP BY 1 ORDER BY 1`);
console.log('=== VIDA UTIL medida (cota superior) por cercania de la fecha ===');
console.table(r.rows);

const e = await db.execute(sql`
  SELECT to_char(appeared_at,'YYYY-MM') mes, count(*) n,
    round((percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms))/1000.0) p50_s
  FROM date_sightings WHERE disappeared_at IS NOT NULL AND duration_ms > 0 AND days_from_now BETWEEN 0 AND 30
  GROUP BY 1 ORDER BY 1`);
console.log('=== fechas cercanas (0-30d): mediana por mes ===');
console.table(e.rows);
process.exit(0);

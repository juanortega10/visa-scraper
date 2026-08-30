import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const e = await db.execute(sql`
  SELECT CASE
    WHEN error ILIKE '%other side closed%' THEN 'a socket cerrado por el otro lado'
    WHEN error ILIKE '%ECONNRESET%' THEN 'b ECONNRESET'
    WHEN error ILIKE '%ETIMEDOUT%' OR error ILIKE '%timeout%' THEN 'c timeout'
    WHEN error ILIKE '%fetch failed%' THEN 'd fetch failed'
    WHEN error ILIKE '%session%' OR error ILIKE '%401%' OR error ILIKE '%sign_in%' THEN 'e sesion'
    WHEN error ILIKE '%proxy%' OR error ILIKE '%tunnel%' THEN 'f proxy'
    WHEN error ILIKE '%502%' OR error ILIKE '%503%' OR error ILIKE '%504%' THEN 'g 5xx'
    ELSE 'z otro' END tipo,
    count(*) n, round(100.0*count(*)/sum(count(*)) OVER (),1) pct,
    min(left(error,90)) ejemplo
  FROM poll_logs WHERE created_at > now()-interval '10 days' AND status='error'
  GROUP BY 1 ORDER BY 2 DESC`);
console.log('=== que son los 59,730 errores (9.4% de polls) ===');
console.table(e.rows);

// HA4: reintentar durante el bloqueo lo alarga?
const h = await db.execute(sql`
  SELECT classification,
    CASE WHEN poll_count=1 THEN 'a 1 poll' WHEN poll_count<=3 THEN 'b 2-3'
         WHEN poll_count<=10 THEN 'c 4-10' ELSE 'd >10' END reintentos,
    count(*) n,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_min)::numeric,0) dur_p50_min
  FROM ban_episodes WHERE ended_at IS NOT NULL AND duration_min IS NOT NULL
  GROUP BY 1,2 ORDER BY 1,2`);
console.log('=== HA4 · duracion del bloqueo segun cuantas veces insistimos ===');
console.table(h.rows);
process.exit(0);

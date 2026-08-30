import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// Cadencia real por locale: define el retraso medio actual frente al borde s14
const r = await db.execute(sql`
  WITH g AS (
    SELECT b.locale, EXTRACT(EPOCH FROM p.created_at - lag(p.created_at)
             OVER (PARTITION BY p.bot_id ORDER BY p.created_at)) gap
    FROM poll_logs p JOIN bots b ON b.id=p.bot_id
    WHERE p.created_at > now()-interval '10 days' AND p.poll_phase='normal')
  SELECT locale, count(*) n,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)::numeric,1) gap_p50_s,
    round(percentile_cont(0.25) WITHIN GROUP (ORDER BY gap)::numeric,1) gap_p25_s
  FROM g WHERE gap BETWEEN 1 AND 600 GROUP BY 1 ORDER BY 2 DESC`);
console.log('=== cadencia real (fase normal) — retraso medio = gap/2 ===');
console.table(r.rows);
process.exit(0);

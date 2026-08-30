import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// H17: confirmar el confusor de H16 — la duracion del pipeline por desenlace
const r = await db.execute(sql`
  SELECT reschedule_result desenlace, count(*) n,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY response_time_ms)::numeric/1000,1) total_p50_s,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (phase_timings->>'reschedule')::int)::numeric/1000,1) resch_p50_s
  FROM poll_logs WHERE created_at > now()-interval '30 days' AND reschedule_result IS NOT NULL
    AND response_time_ms IS NOT NULL
  GROUP BY 1 HAVING count(*)>20 ORDER BY 3 DESC`);
console.log('=== H17 · duracion del pipeline por desenlace (explica el desfase de fase de H16) ===');
console.table(r.rows);
process.exit(0);

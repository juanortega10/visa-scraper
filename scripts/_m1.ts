import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const b = await db.execute(sql`
  SELECT id, locale, status, poll_environments, active_run_id IS NOT NULL run_dev,
    active_cloud_run_id IS NOT NULL run_cloud, proxy_provider, updated_at
  FROM bots WHERE locale='es-mx'`);
console.table(b.rows);
const p = await db.execute(sql`
  SELECT bot_id, poll_phase, chain_id, status, count(*) n,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)::numeric,1) gap_p50
  FROM (SELECT bot_id, poll_phase, chain_id, status,
      EXTRACT(EPOCH FROM created_at - lag(created_at) OVER (PARTITION BY bot_id ORDER BY created_at)) gap
    FROM poll_logs WHERE bot_id IN (281,119) AND created_at > now()-interval '10 days') x
  WHERE gap IS NOT NULL GROUP BY 1,2,3,4 ORDER BY 5 DESC LIMIT 12`);
console.log('=== cadencia real de los bots es-mx ===');
console.table(p.rows);
process.exit(0);

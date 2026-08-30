import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

const r1 = await db.execute(sql`
  SELECT id, scout_bot_id, facility_id, subscribers_considered, subscribers_attempted,
         subscribers_succeeded, subscribers_failed, subscribers_skipped, duration_ms, created_at
  FROM dispatch_logs
  ORDER BY created_at ASC
`);
console.log('=== DISPATCH LOGS SUMMARY ===');
console.log(JSON.stringify(r1.rows, null, 2));

const r2 = await db.execute(sql`
  SELECT id, created_at, details
  FROM dispatch_logs
  WHERE created_at::date = '2026-02-16'
  ORDER BY created_at ASC
`);
console.log('=== 2026-02-16 DETAILS ===');
console.log(JSON.stringify(r2.rows, null, 2));

process.exit(0);

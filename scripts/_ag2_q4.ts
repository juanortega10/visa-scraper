import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`
  SELECT
    (d->>'botId')::int as bot_id,
    d->>'action' as action,
    d->>'result' as result,
    count(*) as n,
    round(avg((d->>'loginMs')::numeric),0) as avg_login_ms,
    round(avg((d->>'rescheduleMs')::numeric),0) as avg_reschedule_ms,
    min(dl.created_at) as first_seen, max(dl.created_at) as last_seen
  FROM dispatch_logs dl, jsonb_array_elements(dl.details) d
  GROUP BY 1,2,3
  ORDER BY first_seen
`);
console.log(JSON.stringify(r.rows, null, 2));

const r2 = await db.execute(sql`
  SELECT count(*) as total_dispatch_rows,
    sum(subscribers_attempted) as total_attempted,
    sum(subscribers_succeeded) as total_succeeded,
    sum(subscribers_skipped) as total_skipped,
    min(created_at) as first, max(created_at) as last
  FROM dispatch_logs
`);
console.log(JSON.stringify(r2.rows, null, 2));
process.exit(0);

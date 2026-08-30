import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

const r = await db.execute(sql`
  SELECT
    d->>'botId' as bot_id,
    d->>'action' as action,
    d->>'result' as result,
    d->>'failReason' as fail_reason,
    d->>'error' as error,
    d->>'improvementDays' as improvement_days,
    d->>'loginMs' as login_ms,
    d->>'rescheduleMs' as reschedule_ms,
    dl.id as dispatch_id,
    dl.created_at
  FROM dispatch_logs dl, jsonb_array_elements(dl.details) d
  ORDER BY dl.created_at ASC
`);
console.log(JSON.stringify(r.rows, null, 2));

const r2 = await db.execute(sql`
  SELECT id, count(*) as n, min(created_at), max(created_at)
  FROM dispatch_logs
  GROUP BY id
`);

const r3 = await db.execute(sql`
  SELECT DISTINCT (d->>'botId')::int as bot_id
  FROM dispatch_logs dl, jsonb_array_elements(dl.details) d
`);
console.log('SUBSCRIBER BOT IDS:', JSON.stringify(r3.rows));

process.exit(0);

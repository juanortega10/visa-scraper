import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const d = await db.execute(sql`
  SELECT date_trunc('day', created_at)::date d, count(*) n,
         sum(subscribers_considered) cons, sum(subscribers_attempted) att,
         sum(subscribers_succeeded) succ, sum(subscribers_failed) fail, sum(subscribers_skipped) skip
  FROM dispatch_logs GROUP BY 1 ORDER BY 1`);
console.log('=== DISPATCH (scout→subscriber, feb-mar 2026) ===');
console.table(d.rows);
const m = await db.execute(sql`
  SELECT to_char(appeared_at,'YYYY-MM') mes, count(*) n,
         count(DISTINCT bot_id) bots,
         count(*) FILTER (WHERE disappeared_at IS NOT NULL) closed
  FROM date_sightings GROUP BY 1 ORDER BY 1`);
console.log('=== DATE_SIGHTINGS por mes ===');
console.table(m.rows);
process.exit(0);

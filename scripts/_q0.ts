import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`
  SELECT min(created_at) mn, max(created_at) mx, count(*) n,
         count(*) FILTER (WHERE date_changes IS NOT NULL) with_dc,
         count(*) FILTER (WHERE jsonb_array_length(date_changes->'appeared') > 0) with_app
  FROM poll_logs`);
console.log(r.rows);
const b = await db.execute(sql`
  SELECT p.bot_id, b.locale, count(*) n,
         count(*) FILTER (WHERE jsonb_array_length(date_changes->'appeared')>0) app
  FROM poll_logs p JOIN bots b ON b.id=p.bot_id
  WHERE p.created_at > now() - interval '30 days'
  GROUP BY 1,2 ORDER BY app DESC LIMIT 15`);
console.table(b.rows);
process.exit(0);

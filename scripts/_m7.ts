import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`
  SELECT b.locale, p.bot_id, count(*) n, min(p.created_at)::date desde, max(p.created_at)::date hasta
  FROM poll_logs p JOIN bots b ON b.id=p.bot_id
  WHERE p.status='soft_ban' AND p.created_at > now()-interval '90 days'
  GROUP BY 1,2 ORDER BY 3 DESC`);
console.log('=== de quien son las filas soft_ban ===');
console.table(r.rows);
process.exit(0);

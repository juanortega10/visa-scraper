import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';

const db = drizzle(neon(process.env.DATABASE_URL!));
const since1h = new Date(Date.now() - 3600 * 1000);
const since5m = new Date(Date.now() - 5 * 60 * 1000);

const r = await db.execute(sql`
  SELECT
    count(*) filter (where created_at > ${since1h.toISOString()}) as last_1h,
    count(*) filter (where created_at > ${since5m.toISOString()}) as last_5m,
    min(created_at) as oldest,
    max(created_at) as newest
  FROM poll_logs
  WHERE bot_id = 94
`);
console.log('Bot 94 DB counts:', r.rows[0]);
console.log('since1h:', since1h.toISOString());
console.log('since5m:', since5m.toISOString());

// Sample recent polls timestamps
const r2 = await db.execute(sql`
  SELECT created_at, status FROM poll_logs
  WHERE bot_id = 94
  ORDER BY created_at DESC
  LIMIT 5
`);
console.log('Last 5 polls:');
for (const row of r2.rows as any[]) console.log(' ', row.created_at, row.status);
process.exit(0);

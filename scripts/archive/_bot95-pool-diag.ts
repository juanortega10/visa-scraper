import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';

const db = drizzle(neon(process.env.DATABASE_URL!));
const since = new Date(Date.now() - 2 * 3600000);

const r = await db.execute(sql`
  SELECT COUNT(*) as cnt FROM poll_logs
  WHERE bot_id = 95 AND created_at >= ${since.toISOString()}
`);
console.log('Poll rows last 2h:', r.rows[0]);

const r2 = await db.execute(sql`
  SELECT COUNT(*) as cnt FROM poll_logs WHERE bot_id = 95
`);
console.log('Poll rows total:', r2.rows[0]);
process.exit(0);

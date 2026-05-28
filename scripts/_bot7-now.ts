import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';

const db = drizzle(neon(process.env.DATABASE_URL!));

await db.execute(sql`
  ALTER TABLE reschedule_logs
    ADD COLUMN IF NOT EXISTS run_id       varchar(100),
    ADD COLUMN IF NOT EXISTS provider     varchar(20),
    ADD COLUMN IF NOT EXISTS session_age_ms integer,
    ADD COLUMN IF NOT EXISTS fail_step    varchar(50),
    ADD COLUMN IF NOT EXISTS fail_reason  varchar(50),
    ADD COLUMN IF NOT EXISTS duration_ms  integer,
    ADD COLUMN IF NOT EXISTS detail       jsonb
`);

console.log('Migration done — columns added to reschedule_logs');

// Verify
const cols = await db.execute(sql`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'reschedule_logs'
  ORDER BY ordinal_position
`);
for (const c of cols.rows) {
  console.log(`  ${(c.column_name as string).padEnd(20)} ${c.data_type}`);
}
process.exit(0);

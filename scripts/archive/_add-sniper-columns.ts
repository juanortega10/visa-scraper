// One-off DDL: add sniper-mode columns to bots (additive, idempotent).
// Avoids drizzle-kit push's interactive rename-detection vs legacy is_scout/is_subscriber.
import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

async function main() {
  await db.execute(sql`ALTER TABLE bots ADD COLUMN IF NOT EXISTS target_date_after date`);
  await db.execute(sql`ALTER TABLE bots ADD COLUMN IF NOT EXISTS sniper_mode boolean NOT NULL DEFAULT false`);

  const res = await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'bots' AND column_name IN ('target_date_after', 'sniper_mode')
    ORDER BY column_name
  `);
  console.log('Columns now present:');
  console.table((res as any).rows ?? res);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

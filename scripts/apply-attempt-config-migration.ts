/**
 * Idempotent migration for the VisasOK real-clients module:
 *  - bot_credential_attempts.notification_phone + config  → collect creds/exclusions
 *    BEFORE validation (collect-first, validate-and-create async).
 *  - bots.client_type ('b2c'|'b2b')                       → distinguish direct users
 *    from agency clients; backfills existing agency bots to 'b2b'.
 *
 * Usage: npx tsx --env-file=.env scripts/apply-attempt-config-migration.ts
 */

import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Applying VisasOK real-clients migration...');

  await db.execute(sql`
    ALTER TABLE bot_credential_attempts
    ADD COLUMN IF NOT EXISTS notification_phone varchar(20);
  `);
  console.log('  ✓ bot_credential_attempts.notification_phone');

  await db.execute(sql`
    ALTER TABLE bot_credential_attempts
    ADD COLUMN IF NOT EXISTS config jsonb;
  `);
  console.log('  ✓ bot_credential_attempts.config');

  await db.execute(sql`
    ALTER TABLE bots
    ADD COLUMN IF NOT EXISTS client_type varchar(3) NOT NULL DEFAULT 'b2c';
  `);
  console.log('  ✓ bots.client_type');

  // Backfill: existing bots tied to an agency are B2B.
  const upd = await db.execute(sql`
    UPDATE bots SET client_type = 'b2b' WHERE agency_id IS NOT NULL AND client_type <> 'b2b';
  `);
  console.log(`  ✓ backfilled ${upd.rowCount ?? 0} agency bots to 'b2b'`);

  // Verification
  const cols = await db.execute(sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE (table_name = 'bot_credential_attempts' AND column_name IN ('notification_phone', 'config'))
       OR (table_name = 'bots' AND column_name = 'client_type')
    ORDER BY table_name, column_name;
  `);
  console.log('\nVerification:');
  for (const r of cols.rows) console.log(`  ${r.table_name}.${r.column_name} present`);

  console.log('\nDone.');
  process.exit(0);
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});

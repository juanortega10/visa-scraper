/**
 * Idempotent migration: add test_mode columns to agencies and bots.
 *
 * Usage: npx tsx --env-file=.env scripts/apply-test-mode-migration.ts
 */

import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Applying test_mode columns...');

  await db.execute(sql`
    ALTER TABLE agencies ADD COLUMN IF NOT EXISTS test_mode boolean NOT NULL DEFAULT false;
  `);
  console.log('  ✓ agencies.test_mode');

  await db.execute(sql`
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS test_mode boolean NOT NULL DEFAULT false;
  `);
  console.log('  ✓ bots.test_mode');

  // Verification
  const cols = await db.execute(sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE column_name = 'test_mode' AND table_name IN ('agencies', 'bots')
    ORDER BY table_name;
  `);
  console.log('\nVerification:');
  for (const r of cols.rows) {
    console.log(`  ${r.table_name}.${r.column_name} present`);
  }

  console.log('\nDone.');
  process.exit(0);
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});

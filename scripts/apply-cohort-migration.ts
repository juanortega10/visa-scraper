/**
 * Idempotent migration: add bots.cohort ('pilot'|'paid') to separate free pilot
 * accounts from billable ones. Default 'paid' (new accounts are billable); the
 * current agency (B2B) accounts are the pilot, so backfill them to 'pilot'.
 *
 * Usage: npx tsx --env-file=.env scripts/apply-cohort-migration.ts
 */

import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Applying bots.cohort...');

  await db.execute(sql`
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS cohort varchar(5) NOT NULL DEFAULT 'paid';
  `);
  console.log('  ✓ bots.cohort');

  // All existing agency (B2B) accounts are the pilot. New ones stay 'paid' (the default).
  const upd = await db.execute(sql`
    UPDATE bots SET cohort = 'pilot' WHERE client_type = 'b2b' AND cohort <> 'pilot';
  `);
  console.log(`  ✓ backfilled ${upd.rowCount ?? 0} existing B2B bots to 'pilot'`);

  const counts = await db.execute(sql`
    SELECT cohort, count(*)::int c FROM bots WHERE client_type='b2b' GROUP BY cohort ORDER BY cohort;
  `);
  console.log('\nB2B bots by cohort:');
  for (const r of counts.rows) console.log(`  ${r.cohort}: ${r.c}`);

  console.log('\nDone.');
  process.exit(0);
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});

/**
 * Idempotent migration: let bot_credential_attempts hold B2C (self-serve /activar)
 * attempts, not just agency ones.
 *
 *  - agency_id      → nullable (NULL = B2C attempt)
 *  - clerk_user_id  → owner of a B2C attempt (+ index)
 *
 * Why: the /activar frontend now persists encrypted creds straight to Neon BEFORE
 * calling the RPi API, so an onboarding is never lost when the backend is down.
 *
 * Usage: npx tsx --env-file=.env scripts/apply-b2c-attempts-migration.ts
 */

import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Applying B2C credential-attempts migration...');

  await db.execute(sql`
    ALTER TABLE bot_credential_attempts ALTER COLUMN agency_id DROP NOT NULL;
  `);
  console.log('  ✓ bot_credential_attempts.agency_id is nullable');

  await db.execute(sql`
    ALTER TABLE bot_credential_attempts
    ADD COLUMN IF NOT EXISTS clerk_user_id varchar(64);
  `);
  console.log('  ✓ bot_credential_attempts.clerk_user_id');

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS credential_attempts_clerk_idx
    ON bot_credential_attempts (clerk_user_id);
  `);
  console.log('  ✓ credential_attempts_clerk_idx');

  const check = await db.execute(sql`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'bot_credential_attempts'
      AND column_name IN ('agency_id', 'clerk_user_id')
    ORDER BY column_name
  `);
  console.log('Result:', check.rows);
  console.log('Done.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

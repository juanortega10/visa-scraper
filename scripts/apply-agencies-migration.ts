/**
 * Idempotent migration applier for the agencies + bot_credential_attempts schema.
 * Uses IF NOT EXISTS clauses so it's safe to re-run.
 *
 * Usage: npx tsx --env-file=.env scripts/apply-agencies-migration.ts
 */

import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Applying agencies + bot_credential_attempts migration...');

  // 1. Enums
  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE billing_mode AS ENUM ('free', 'paid');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  console.log('  ✓ enum billing_mode');

  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE credential_attempt_status AS ENUM ('pending', 'discovering', 'ready', 'failed', 'used');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  console.log('  ✓ enum credential_attempt_status');

  // 2. agencies table
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agencies (
      id serial PRIMARY KEY NOT NULL,
      name text NOT NULL,
      clerk_user_id varchar(50) NOT NULL,
      contact_email text NOT NULL,
      contact_phone text,
      billing_mode billing_mode DEFAULT 'free' NOT NULL,
      max_bots integer DEFAULT 5 NOT NULL,
      notes text,
      created_at timestamp DEFAULT now() NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS agencies_clerk_idx ON agencies (clerk_user_id);`);
  console.log('  ✓ table agencies + index');

  // 3. bot_credential_attempts table
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS bot_credential_attempts (
      id serial PRIMARY KEY NOT NULL,
      agency_id integer NOT NULL,
      visa_email text NOT NULL,
      visa_password text NOT NULL,
      country varchar(2) NOT NULL,
      locale varchar(10),
      status credential_attempt_status DEFAULT 'pending' NOT NULL,
      discovery_token varchar(64),
      discovered_data jsonb,
      last_error text,
      last_attempt_at timestamp,
      retry_count integer DEFAULT 0 NOT NULL,
      bot_id integer,
      created_at timestamp DEFAULT now() NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS credential_attempts_agency_idx ON bot_credential_attempts (agency_id);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS credential_attempts_status_idx ON bot_credential_attempts (status);`);
  console.log('  ✓ table bot_credential_attempts + indexes');

  // 4. bots.agency_id column
  await db.execute(sql`ALTER TABLE bots ADD COLUMN IF NOT EXISTS agency_id integer;`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS bots_agency_idx ON bots (agency_id);`);
  console.log('  ✓ bots.agency_id + index');

  // 5. Sanity check
  const tables = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('agencies', 'bot_credential_attempts')
    ORDER BY table_name;
  `);
  console.log('\nVerification:');
  console.log('  Tables present:', tables.rows.map((r: any) => r.table_name));

  const cols = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'bots' AND column_name = 'agency_id';
  `);
  console.log('  bots.agency_id present:', cols.rows.length > 0);

  console.log('\nDone.');
  process.exit(0);
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});

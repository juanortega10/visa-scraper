/** DDL idempotente. NO usar db:push: el prompt interactivo de drizzle-kit se cuelga
 *  preguntando si las columnas nuevas son renames de is_scout/is_subscriber. */
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';

await db.execute(sql`
  CREATE TABLE IF NOT EXISTS sniper_scans (
    id SERIAL PRIMARY KEY,
    scan_key VARCHAR(40) NOT NULL,
    scanned_at TIMESTAMP NOT NULL DEFAULT NOW(),
    window_start DATE NOT NULL,
    window_end DATE NOT NULL,
    phase VARCHAR(20) NOT NULL,
    payload JSONB NOT NULL
  )
`);
await db.execute(sql`
  CREATE INDEX IF NOT EXISTS sniper_scans_key_at_idx ON sniper_scans (scan_key, scanned_at)
`);
const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM sniper_scans`);
console.log('sniper_scans OK. filas:', (r as unknown as { rows: Array<{ n: number }> }).rows[0]?.n);
process.exit(0);

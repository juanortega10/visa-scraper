/**
 * Lists B2C onboardings that never became a bot — the recovery queue fed by the
 * /activar flow (creds are persisted to Neon before the API call, so a backend
 * outage no longer loses them).
 *
 * Rows are `pending` (discovery never finished — usually the API was down) or
 * `failed` (discovery ran and rejected; `invalid_credentials` = dead end, the
 * user simply typed the wrong password).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/list-recoverable-attempts.ts            # last 14 days
 *   npx tsx --env-file=.env scripts/list-recoverable-attempts.ts --days=60
 *   npx tsx --env-file=.env scripts/list-recoverable-attempts.ts --all      # include invalid_credentials
 */

import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';

const daysArg = process.argv.find((a) => a.startsWith('--days='));
const days = daysArg ? parseInt(daysArg.split('=')[1] ?? '14', 10) : 14;
const includeInvalid = process.argv.includes('--all');

async function main() {
  const rows = await db.execute(sql`
    SELECT id, clerk_user_id, visa_email, visa_password, country, status,
           last_error, created_at, updated_at
    FROM bot_credential_attempts
    WHERE agency_id IS NULL
      AND status IN ('pending', 'failed')
      AND created_at > now() - (${days} || ' days')::interval
    ORDER BY id DESC
  `);

  let shown = 0;
  for (const r of rows.rows as Array<Record<string, any>>) {
    const invalid = (r.last_error ?? '').includes('invalid_credentials');
    if (invalid && !includeInvalid) continue;
    let email = '(decrypt failed)';
    let password = '(decrypt failed)';
    try { email = decrypt(r.visa_email); } catch {}
    try { password = decrypt(r.visa_password); } catch {}
    console.log(`#${r.id}  ${r.status.toUpperCase()}  ${r.created_at}`);
    console.log(`   ${email} :: ${password}   (${r.country})`);
    console.log(`   clerk=${r.clerk_user_id}${r.last_error ? `  error=${r.last_error}` : ''}`);
    shown++;
  }

  console.log(
    shown === 0
      ? `\nNothing to recover in the last ${days} days.`
      : `\n${shown} recoverable onboarding(s) in the last ${days} days.` +
        (includeInvalid ? '' : ' Add --all to include invalid_credentials.'),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

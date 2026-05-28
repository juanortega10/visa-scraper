/**
 * Borra las agencias VisasOK que NO son de Oswaldo.
 * Mantiene Agency 5 (neiloswaldo@gmail.com).
 * Para Agency 3 + 4: cancela runs activos, borra bots (cascade limpia logs/sesiones),
 * luego limpia bot_credential_attempts y borra el row de agency.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/_delete-non-oswaldo-agencies.ts            # dry-run
 *   npx tsx --env-file=.env scripts/_delete-non-oswaldo-agencies.ts --commit   # ejecuta
 */
import { db } from '../src/db/client.js';
import { agencies, bots, botCredentialAttempts } from '../src/db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { runs } from '@trigger.dev/sdk/v3';

const AGENCIES_TO_DELETE = [3, 4];
const KEEP = 5; // Oswaldo

const commit = process.argv.includes('--commit');

async function main() {
  console.log(`Mode: ${commit ? 'COMMIT' : 'DRY-RUN'}`);
  console.log(`Deleting agencies: ${AGENCIES_TO_DELETE.join(', ')}`);
  console.log(`Keeping agency: ${KEEP} (Oswaldo)\n`);

  // Verify Agency 5 exists and is Oswaldo (sanity check)
  const [oswaldo] = await db.select().from(agencies).where(eq(agencies.id, KEEP));
  if (!oswaldo) {
    console.error(`FATAL: Agency ${KEEP} (Oswaldo) not found — aborting`);
    process.exit(1);
  }
  if (!oswaldo.contactEmail.includes('oswaldo')) {
    console.error(`FATAL: Agency ${KEEP} email "${oswaldo.contactEmail}" does not look like Oswaldo's — aborting`);
    process.exit(1);
  }
  console.log(`Sanity: Agency ${KEEP} verified as Oswaldo (${oswaldo.contactEmail})\n`);

  // Gather victims
  const targets = await db.select().from(agencies).where(inArray(agencies.id, AGENCIES_TO_DELETE));
  for (const a of targets) {
    console.log(`Agency ${a.id}: "${a.name}" — ${a.contactEmail} (clerk=${a.clerkUserId})`);
  }
  console.log();

  // Find all bots tied to these agencies
  const victimBots = await db
    .select({
      id: bots.id,
      agencyId: bots.agencyId,
      status: bots.status,
      testMode: bots.testMode,
      activeRunId: bots.activeRunId,
      activeCloudRunId: bots.activeCloudRunId,
    })
    .from(bots)
    .where(inArray(bots.agencyId, AGENCIES_TO_DELETE));

  console.log(`Bots to delete: ${victimBots.length}`);
  for (const b of victimBots) {
    console.log(
      `  bot ${b.id}: agencyId=${b.agencyId} status=${b.status} testMode=${b.testMode} activeRun=${b.activeRunId ?? '-'} cloudRun=${b.activeCloudRunId ?? '-'}`,
    );
  }
  console.log();

  const victimAttempts = await db
    .select({ id: botCredentialAttempts.id, agencyId: botCredentialAttempts.agencyId, status: botCredentialAttempts.status })
    .from(botCredentialAttempts)
    .where(inArray(botCredentialAttempts.agencyId, AGENCIES_TO_DELETE));
  console.log(`Credential attempts to delete: ${victimAttempts.length}\n`);

  if (!commit) {
    console.log('DRY-RUN. Re-run with --commit to execute.');
    process.exit(0);
  }

  // ── EXECUTE ──
  console.log('--- EXECUTING ---\n');

  // 1. Cancel active runs (best-effort, ignore errors — runs may already be done)
  for (const b of victimBots) {
    for (const runId of [b.activeRunId, b.activeCloudRunId]) {
      if (!runId) continue;
      try {
        await runs.cancel(runId);
        console.log(`  cancelled run ${runId} (bot ${b.id})`);
      } catch (e) {
        console.log(`  could not cancel run ${runId} (bot ${b.id}): ${(e as Error).message}`);
      }
    }
  }

  // 2. Delete bots (cascade clears poll_logs, reschedule_logs, sessions, etc.)
  if (victimBots.length > 0) {
    const ids = victimBots.map((b) => b.id);
    const r = await db.delete(bots).where(inArray(bots.id, ids));
    console.log(`  deleted ${ids.length} bots: ${ids.join(', ')}`);
  }

  // 3. Delete credential attempts
  if (victimAttempts.length > 0) {
    const r = await db
      .delete(botCredentialAttempts)
      .where(inArray(botCredentialAttempts.agencyId, AGENCIES_TO_DELETE));
    console.log(`  deleted ${victimAttempts.length} credential attempts`);
  }

  // 4. Delete agencies
  const r = await db.delete(agencies).where(inArray(agencies.id, AGENCIES_TO_DELETE));
  console.log(`  deleted ${AGENCIES_TO_DELETE.length} agencies`);

  console.log('\nDone.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

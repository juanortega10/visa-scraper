/**
 * Flip an agency's test_mode flag (and propagate to its bots).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/set-agency-test-mode.ts --id=42 --enable
 *   npx tsx --env-file=.env scripts/set-agency-test-mode.ts --id=42 --disable
 *   npx tsx --env-file=.env scripts/set-agency-test-mode.ts --list
 *
 * When you DISABLE test mode, existing bots get test_mode=false but their
 * status stays 'active' — they will start polling on the next cron tick
 * (every 2 min). To kick them off immediately, run the activate endpoint
 * for each bot manually.
 */

import { db } from '../src/db/client.js';
import { agencies, bots } from '../src/db/schema.js';
import { eq, count, and } from 'drizzle-orm';

function arg(name: string): string | undefined {
  const flag = `--${name}=`;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(flag)) return a.slice(flag.length);
    if (a === `--${name}`) return 'true';
  }
  return undefined;
}

async function list() {
  const rows = await db
    .select({
      id: agencies.id,
      name: agencies.name,
      clerkUserId: agencies.clerkUserId,
      testMode: agencies.testMode,
      maxBots: agencies.maxBots,
      createdAt: agencies.createdAt,
    })
    .from(agencies);

  console.log('\nAgencies:');
  console.log('─'.repeat(80));
  for (const a of rows) {
    const [{ n = 0 } = { n: 0 }] = await db
      .select({ n: count() })
      .from(bots)
      .where(eq(bots.agencyId, a.id));
    const [{ tm = 0 } = { tm: 0 }] = await db
      .select({ tm: count() })
      .from(bots)
      .where(and(eq(bots.agencyId, a.id), eq(bots.testMode, true)));
    console.log(
      `  #${a.id.toString().padEnd(3)} ${a.name.padEnd(28)}  test=${a.testMode ? 'ON ' : 'off'}  bots=${n} (test=${tm})`,
    );
  }
  console.log('─'.repeat(80));
  console.log('');
}

async function flip(agencyId: number, enable: boolean) {
  const [agency] = await db.select().from(agencies).where(eq(agencies.id, agencyId));
  if (!agency) {
    console.error(`Agency ${agencyId} not found`);
    process.exit(1);
  }

  console.log(`Flipping agency ${agency.id} "${agency.name}" test_mode → ${enable}`);

  await db.update(agencies).set({ testMode: enable, updatedAt: new Date() }).where(eq(agencies.id, agencyId));

  const result = await db
    .update(bots)
    .set({ testMode: enable, updatedAt: new Date() })
    .where(eq(bots.agencyId, agencyId))
    .returning({ id: bots.id, status: bots.status });

  console.log(`  Updated ${result.length} bot(s) under this agency.`);
  if (!enable && result.length > 0) {
    console.log(
      '\n  ⚠️  Bots are now real-mode but no poll is queued. They will start on the next cron tick (~2 min)',
    );
    console.log(
      '       or you can force-restart each chain via POST /api/bots/:id/restart-chain.',
    );
  }
}

async function main() {
  const wantList = arg('list');
  const wantEnable = arg('enable');
  const wantDisable = arg('disable');
  const id = arg('id');

  if (wantList) {
    await list();
    process.exit(0);
  }

  if (!id) {
    console.error('Usage: --id=<agencyId> --enable   or   --id=<agencyId> --disable   or   --list');
    process.exit(1);
  }

  const agencyId = parseInt(id, 10);
  if (isNaN(agencyId)) {
    console.error(`Invalid id: ${id}`);
    process.exit(1);
  }

  if (wantEnable && wantDisable) {
    console.error('Pass either --enable OR --disable, not both');
    process.exit(1);
  }
  if (!wantEnable && !wantDisable) {
    console.error('Pass --enable or --disable');
    process.exit(1);
  }

  await flip(agencyId, Boolean(wantEnable));
  console.log('\nDone.');
  process.exit(0);
}

main().catch((e) => {
  console.error('Failed:', e);
  process.exit(1);
});

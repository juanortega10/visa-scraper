/**
 * Post-deploy watch for the reschedule attribution guard (deployed 2026-08-11).
 *
 * Prints one line of counters for reschedule_logs rows created since a cutoff:
 *   external_change   → the guard fired: the portal moved to a date the bot never
 *                       POSTed, and the bot did NOT take credit. This is the fix working.
 *   recovered         → [post_error_recovered] rows. After the fix these only happen
 *                       when the portal landed on the exact target, so they are valid.
 *   success           → normal successful reschedules (health check: must keep flowing).
 *   reversion         → portal_reversion rows (unchanged behavior, tracked for contrast).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/watch-attribution.ts               # since deploy
 *   npx tsx --env-file=.env scripts/watch-attribution.ts --since 2h
 *   npx tsx --env-file=.env scripts/watch-attribution.ts --detail      # list the rows
 */
import { db } from '../src/db/client.js';
import { rescheduleLogs } from '../src/db/schema.js';
import { gte, desc } from 'drizzle-orm';

const DEPLOYED_AT = '2026-08-11T17:11:00Z'; // RPi + cloud 20260811.2, 12:11 Bogota

const args = process.argv.slice(2);
const sinceArg = args[args.indexOf('--since') + 1];
const detail = args.includes('--detail');

function cutoff(): Date {
  if (args.includes('--since') && sinceArg) {
    const m = /^(\d+)([hd])$/.exec(sinceArg);
    if (m) {
      const n = Number(m[1]);
      return new Date(Date.now() - n * (m[2] === 'h' ? 3600000 : 86400000));
    }
  }
  return new Date(DEPLOYED_AT);
}

async function main() {
  const from = cutoff();
  const rows = await db
    .select()
    .from(rescheduleLogs)
    .where(gte(rescheduleLogs.createdAt, from))
    .orderBy(desc(rescheduleLogs.createdAt));

  const err = (r: (typeof rows)[number]) => (typeof r.error === 'string' ? r.error : '');
  const external = rows.filter((r) => err(r).startsWith('[external_change]'));
  const recovered = rows.filter((r) => err(r).startsWith('[post_error_recovered]'));
  const reversion = rows.filter((r) => err(r).startsWith('portal_reversion'));
  const success = rows.filter((r) => r.success === true);

  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  console.log(
    `${stamp}Z  since=${from.toISOString().slice(0, 16)}  rows=${rows.length}  ` +
      `success=${success.length}  external_change=${external.length}  ` +
      `recovered=${recovered.length}  reversion=${reversion.length}`,
  );

  // Any recovered row must name the same date it landed on. The guard makes this
  // structurally true; if one ever disagrees, the guard is not running.
  const badRecovered = recovered.filter((r) => {
    const m = /target=(\S+) actual=(\S+)/.exec(err(r));
    return m ? m[1] !== m[2] : false;
  });
  if (badRecovered.length > 0) {
    console.error(`ALERT: ${badRecovered.length} recovered rows with a target/actual mismatch`);
    process.exitCode = 1;
  }

  if (detail) {
    for (const r of [...external, ...recovered, ...reversion]) {
      console.log(
        `  bot ${String(r.botId).padStart(4)}  ${new Date(r.createdAt!).toISOString().slice(0, 16)}  ` +
          `${r.oldConsularDate} → ${r.newConsularDate}  ok=${r.success}  ${err(r)}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

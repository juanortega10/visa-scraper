/**
 * Migration tool (Hop 2a): move a bot between runtimes by flipping pollEnvironments.
 *   dev  = RPi dev worker   |   prod = Trigger.dev cloud
 *
 * Enforces the migration invariant: EXACTLY ONE owner. Only single-value envs are
 * allowed (['dev'] OR ['prod']) — never dual, which would double-poll the account.
 * The old runtime's chain self-stops via the guard in poll-visa.ts:165-169; the new
 * runtime's cron picks the bot up within one cycle. Reversible: just flip back.
 *
 * Usage: npx tsx --env-file=.env scripts/set-poll-env.ts <botId> <dev|prod>
 */
import { db } from '../src/db/client.js';
import { bots, pollLogs } from '../src/db/schema.js';
import { eq, and, sql, gte } from 'drizzle-orm';

const botId = parseInt(process.argv[2] ?? '', 10);
const target = process.argv[3];
if (!botId || (target !== 'dev' && target !== 'prod')) {
  console.error('Usage: set-poll-env.ts <botId> <dev|prod>');
  process.exit(1);
}

const [bot] = await db
  .select({
    id: bots.id, status: bots.status, cohort: bots.cohort, locale: bots.locale,
    provider: bots.proxyProvider, pollEnvironments: bots.pollEnvironments,
    activeRunId: bots.activeRunId, activeCloudRunId: bots.activeCloudRunId,
    consular: bots.currentConsularDate, rc: bots.rescheduleCount, mx: bots.maxReschedules,
  })
  .from(bots)
  .where(eq(bots.id, botId));
if (!bot) { console.error(`bot ${botId} not found`); process.exit(1); }

// Baseline health (last 24h)
const [h] = await db
  .select({
    polls: sql<number>`count(*)`,
    ok: sql<number>`count(*) filter (where ${pollLogs.status}='ok')`,
    blocked: sql<number>`count(*) filter (where ${pollLogs.status} in ('tcp_blocked','soft_ban','error'))`,
  })
  .from(pollLogs)
  .where(and(eq(pollLogs.botId, botId), gte(pollLogs.createdAt, sql`now() - interval '24 hours'`)));

const blockPct = h && Number(h.polls) > 0 ? (100 * Number(h.blocked) / Number(h.polls)).toFixed(1) : 'n/a';
console.log(`\n── BASELINE bot ${botId} ──`);
console.log({ status: bot.status, cohort: bot.cohort, locale: bot.locale, provider: bot.provider,
  pollEnvironments: bot.pollEnvironments, activeRunId: bot.activeRunId, activeCloudRunId: bot.activeCloudRunId,
  consular: bot.consular, reschedules: `${bot.rc}/${bot.mx ?? '∞'}`,
  health_24h: { polls: Number(h?.polls ?? 0), ok: Number(h?.ok ?? 0), blockPct } });

const current = (bot.pollEnvironments as string[] | null) ?? ['dev'];
if (current.length === 1 && current[0] === target) {
  console.log(`\nNo-op: bot ${botId} already ['${target}'].`);
  process.exit(0);
}

// Clear the activeRunId of the runtime we're LEAVING so its self-chain dies cleanly on its
// next run (via the env guards in poll-visa.ts) and the orphan check can't resurrect a ghost.
// Requires both runtimes to run the env-guard build (poll-visa.ts: cloud guard + dev guard).
const leaving = target === 'prod'
  ? { activeRunId: null as string | null }   // leaving dev → clear dev pointer
  : { activeCloudRunId: null as string | null }; // leaving prod → clear cloud pointer
await db.update(bots).set({ pollEnvironments: [target], ...leaving, updatedAt: new Date() }).where(eq(bots.id, botId));
console.log(`\n✅ FLIPPED bot ${botId}: [${current.join(',')}] → ['${target}'] (cleared ${target === 'prod' ? 'activeRunId' : 'activeCloudRunId'})`);
console.log(target === 'prod'
  ? '   Dev chain stops on its next run via the dev guard; cloud cron picks it up within ~2 min.'
  : '   Cloud chain stops on its next run via the cloud guard; RPi cron picks it up within ~2 min.');
console.log('   Rollback: re-run with the opposite env.\n');
process.exit(0);

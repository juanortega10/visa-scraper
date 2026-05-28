import { schedules, logger, runs } from '@trigger.dev/sdk/v3';
import { db } from '../db/client.js';
import { bots, pollLogs } from '../db/schema.js';
import { eq, inArray, and, desc } from 'drizzle-orm';
import { notifyUserTask } from './notify-user.js';
import { visaPollingPerBotQueue } from './queues.js';
import { calculatePriority } from '../services/scheduling.js';

type RunAction = 'executing' | 'pulled_forward' | 'resurrected' | 'cron_ok';

async function getRunStatus(runId: string | null): Promise<string | null> {
  if (!runId) return null;
  try {
    const run = await runs.retrieve(runId);
    return run.status;
  } catch {
    return null;
  }
}

/**
 * If EXECUTING → leave it alone.
 * If DELAYED/QUEUED → cancel and re-trigger now (pull forward into pre-warm/super-critical schedule).
 * If dead/null → trigger new chain.
 */
async function ensureChainForBot(
  botId: number,
  runId: string | null,
  concurrencyKey: string,
  activatedAt: Date | null,
  tags: string[],
  usesCron: boolean,
  chainId?: 'dev' | 'cloud',
): Promise<{ action: RunAction; newRunId?: string }> {
  const status = await getRunStatus(runId);

  if (status === 'EXECUTING') return { action: 'executing' };

  // For cron bots, null activeRunId is normal (cleared between cron ticks).
  // Only resurrect if no recent poll_log (cron should fire every 2 min, 5 min gap = something's wrong).
  if (usesCron && !runId) {
    const [recentLog] = await db.select({ createdAt: pollLogs.createdAt })
      .from(pollLogs)
      .where(eq(pollLogs.botId, botId))
      .orderBy(desc(pollLogs.createdAt))
      .limit(1);

    if (recentLog) {
      const minSince = (Date.now() - recentLog.createdAt.getTime()) / 60000;
      if (minSince < 5) {
        logger.info('ensure-chain: cron bot has recent poll, skipping', { botId, minSince: Math.round(minSince) });
        return { action: 'cron_ok' };
      }
    }
    // No recent activity — fall through to resurrect
  }

  if (status === 'DELAYED' || status === 'QUEUED') {
    // Cancel stale run (DELAYED waiting 10min, QUEUED, etc.)
    if (runId) {
      try { await runs.cancel(runId); } catch {}
    }
  }

  const { pollVisaTask } = await import('./poll-visa.js');
  const handle = await pollVisaTask.trigger(
    { botId, ...(chainId === 'cloud' ? { chainId: 'cloud' as const } : {}) },
    {
      delay: '1s',
      idempotencyKey: `ensure-restart-${botId}-${chainId ?? 'dev'}-${Math.floor(Date.now() / 60_000)}`,
      queue: 'visa-polling-per-bot',
      concurrencyKey,
      priority: calculatePriority(activatedAt),
      tags,
    },
  );

  const action: RunAction = status === 'DELAYED' || status === 'QUEUED' ? 'pulled_forward' : 'resurrected';
  return { action, newRunId: handle.id };
}

/**
 * Chain Guardian — runs every 10 min in BOTH dev (RPi) and prod (cloud).
 *
 * Each runtime env (DEVELOPMENT / PRODUCTION) only manages chains for ITS env:
 * - dev worker → bot.activeRunId      (concurrencyKey `poll-${id}`)
 * - cloud worker → bot.activeCloudRunId (concurrencyKey `poll-cloud-${id}`)
 *
 * Triggering across envs is unsafe (the spawned run would execute in the wrong
 * env and bypass the pollEnvironments guard).
 *
 * Behavior per chain:
 * - EXECUTING → no-op (already running)
 * - DELAYED / QUEUED → cancel + re-trigger now (releases stuck queue slot)
 * - Dead/null → resurrect (unless cron bot with recent poll_logs)
 *
 * Bursty Tuesday-drop window (8:50–8:59 Bogota) is still covered — the 10 min
 * cadence + per-minute self-chain make sure no bot stays idle for more than
 * ~10 min during normal operation.
 */
export const ensureChainSchedule = schedules.task({
  id: 'ensure-chain',
  cron: {
    // Every 10 minutes — catches orphans within 10 min anywhere in the system.
    pattern: '*/10 * * * *',
    environments: ['DEVELOPMENT', 'PRODUCTION'],
  },
  machine: { preset: 'micro' },
  maxDuration: 60,

  run: async (_payload, { ctx }) => {
    const isCloud = ctx.environment.type === 'PRODUCTION';
    const envLabel = isCloud ? 'cloud' : 'dev';

    // SELECT only columns needed for chain management
    const targetBots = await db.select({
      id: bots.id, status: bots.status,
      activeRunId: bots.activeRunId, activeCloudRunId: bots.activeCloudRunId,
      pollEnvironments: bots.pollEnvironments, cloudEnabled: bots.cloudEnabled,
      activatedAt: bots.activatedAt, locale: bots.locale,
    }).from(bots)
      .where(inArray(bots.status, ['active', 'error']));

    if (targetBots.length === 0) {
      logger.info('ensure-chain: no bots', { env: envLabel });
      return;
    }

    const results: Record<number, RunAction> = {};

    for (const bot of targetBots) {
      const envs = (bot.pollEnvironments as string[] | null) ?? ['dev'];
      const botUsesCloud = envs.includes('prod');
      const botUsesDev = envs.includes('dev');
      const usesCron = envs.length > 1; // dual-source = cron-driven

      // Only manage chains for the env we're running in.
      const manageThisBot = isCloud ? botUsesCloud : botUsesDev;
      if (!manageThisBot) continue;

      const runId = isCloud ? bot.activeCloudRunId : bot.activeRunId;
      const concurrencyKey = isCloud ? `poll-cloud-${bot.id}` : `poll-${bot.id}`;
      const tags = [`bot:${bot.id}`, ...(isCloud ? ['cloud'] : []), 'guardian'];

      const result = await ensureChainForBot(
        bot.id,
        runId,
        concurrencyKey,
        bot.activatedAt,
        tags,
        usesCron,
        isCloud ? 'cloud' : 'dev',
      );

      if (result.newRunId) {
        const updateField = isCloud
          ? { activeCloudRunId: result.newRunId }
          : { activeRunId: result.newRunId };
        await db.update(bots)
          .set({ ...updateField, updatedAt: new Date() })
          .where(eq(bots.id, bot.id));
      }
      results[bot.id] = result.action;

      // Notify only on real resurrections (not pull-forwards or cron_ok)
      if (result.action === 'resurrected') {
        await notifyUserTask.trigger({
          botId: bot.id,
          event: 'chain_resurrected',
          data: { env: envLabel, action: result.action, trigger: 'guardian_10min' },
        }, { tags: [`bot:${bot.id}`] }).catch(() => {});
      }
    }

    logger.info('ensure-chain done', { env: envLabel, results });
  },
});

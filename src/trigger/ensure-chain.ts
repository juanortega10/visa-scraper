import { schedules, logger, runs } from '@trigger.dev/sdk/v3';
import { db } from '../db/client.js';
import { bots, pollLogs } from '../db/schema.js';
import { eq, inArray, and, desc } from 'drizzle-orm';
import { notifyUserTask } from './notify-user.js';
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
      concurrencyKey,
      priority: calculatePriority(activatedAt),
      tags,
    },
  );

  const action: RunAction = status === 'DELAYED' || status === 'QUEUED' ? 'pulled_forward' : 'resurrected';
  return { action, newRunId: handle.id };
}

/**
 * Tuesday Chain Guardian — every minute from 8:50 to 8:59 AM Bogota, PRODUCTION only.
 *
 * Ensures all active/error bots have a poll chain that will EXECUTE before 9:00 AM.
 * - EXECUTING → no-op (already running)
 * - DELAYED → cancel + re-trigger now (pulls forward a run that might be 10min away)
 * - Dead/null → resurrect (unless cron bot with recent poll_logs)
 *
 * Runs every minute so even if a chain dies at 8:56, it's caught by 8:57 at worst.
 */
export const ensureChainSchedule = schedules.task({
  id: 'ensure-chain',
  cron: {
    pattern: '50-59 13 * * 2',
    environments: ['PRODUCTION'],
  },
  machine: { preset: 'micro' },
  maxDuration: 30,

  run: async () => {
    // SELECT only columns needed for chain management
    const targetBots = await db.select({
      id: bots.id, status: bots.status, isScout: bots.isScout,
      activeRunId: bots.activeRunId, activeCloudRunId: bots.activeCloudRunId,
      pollEnvironments: bots.pollEnvironments, cloudEnabled: bots.cloudEnabled,
      activatedAt: bots.activatedAt, locale: bots.locale,
    }).from(bots)
      .where(inArray(bots.status, ['active', 'error']));

    if (targetBots.length === 0) {
      logger.info('ensure-chain: no bots');
      return;
    }

    const results: Record<number, { dev: RunAction; cloud?: RunAction }> = {};

    for (const bot of targetBots) {
      const envs = (bot.pollEnvironments as string[] | null) ?? ['dev'];
      const usesDev = envs.includes('dev');
      const usesCloud = envs.includes('prod');
      const usesCron = envs.length > 1; // dual-source (e.g. ['dev','prod']) = cron-driven

      if (usesDev) {
        const dev = await ensureChainForBot(
          bot.id,
          bot.activeRunId,
          `poll-${bot.id}`,
          bot.activatedAt,
          [`bot:${bot.id}`, 'guardian'],
          usesCron,
          'dev',
        );
        if (dev.newRunId) {
          await db.update(bots)
            .set({ activeRunId: dev.newRunId, updatedAt: new Date() })
            .where(eq(bots.id, bot.id));
        }
        results[bot.id] = { dev: dev.action };
      }

      if (usesCloud) {
        const cloud = await ensureChainForBot(
          bot.id,
          bot.activeCloudRunId,
          `poll-cloud-${bot.id}`,
          bot.activatedAt,
          [`bot:${bot.id}`, 'cloud', 'guardian'],
          usesCron,
          'cloud',
        );
        if (cloud.newRunId) {
          await db.update(bots)
            .set({ activeCloudRunId: cloud.newRunId, updatedAt: new Date() })
            .where(eq(bots.id, bot.id));
        }
        if (results[bot.id]) {
          results[bot.id]!.cloud = cloud.action;
        } else {
          results[bot.id] = { dev: 'cron_ok', cloud: cloud.action };
        }
      }

      const r = results[bot.id];
      // Notify only on resurrections (not pull-forwards or cron_ok — those are normal)
      if (r && (r.dev === 'resurrected' || r.cloud === 'resurrected')) {
        await notifyUserTask.trigger({
          botId: bot.id,
          event: 'chain_resurrected',
          data: { dev: r.dev, cloud: r.cloud, trigger: 'tuesday_guardian' },
        }, { tags: [`bot:${bot.id}`] }).catch(() => {});
      }
    }

    logger.info('ensure-chain done', { results });
  },
});

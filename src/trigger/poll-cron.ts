import { schedules, logger, runs } from '@trigger.dev/sdk/v3';
import { db } from '../db/client.js';
import { bots } from '../db/schema.js';
import { eq, inArray, and, lte } from 'drizzle-orm';
import { calculatePriority } from '../services/scheduling.js';
import { visaPollingPerBotQueue } from './queues.js';

type Source = 'dev' | 'cloud';

/**
 * Trigger poll-visa for all eligible bots that should be polled from this source.
 * Eligible = active/error bots whose pollEnvironments includes this source.
 */
async function triggerEligibleBots(source: Source): Promise<void> {
  // SELECT only columns needed for cron eligibility — omit casCacheJson, creds, etc.
  const activeBots = await db.select({
    id: bots.id, status: bots.status,
    pollEnvironments: bots.pollEnvironments, cloudEnabled: bots.cloudEnabled,
    activeRunId: bots.activeRunId, activeCloudRunId: bots.activeCloudRunId,
    activatedAt: bots.activatedAt,
  }).from(bots)
    .where(inArray(bots.status, ['active', 'error']));

  if (activeBots.length === 0) {
    logger.info(`poll-cron-${source}: no eligible bots`);
    return;
  }

  // Filter bots whose pollEnvironments includes this source
  const eligible = activeBots.filter((bot) => {
    const envs = (bot.pollEnvironments as string[] | null) ?? ['dev'];
    return envs.includes(source === 'cloud' ? 'prod' : 'dev');
  });

  if (eligible.length === 0) {
    logger.info(`poll-cron-${source}: no bots configured for ${source}`, { totalBots: activeBots.length });
    return;
  }

  logger.info(`poll-cron-${source}: ${eligible.length} eligible bots`, {
    botIds: eligible.map(b => b.id),
  });

  const { pollVisaTask } = await import('./poll-visa.js');

  for (const bot of eligible) {
    const isCloud = source === 'cloud';
    const activeRunId = isCloud ? bot.activeCloudRunId : bot.activeRunId;

    // Check if an active run exists — if executing or delayed (chain in burst/super-critical), skip
    // Staleness guard: if EXECUTING for longer than 3min, assume orphaned (e.g. worker restart/deploy)
    if (activeRunId) {
      try {
        const run = await runs.retrieve(activeRunId);
        if (run.status === 'EXECUTING' || run.status === 'DELAYED' || run.status === 'QUEUED') {
          const startedAt = run.startedAt ?? run.createdAt;
          const ageMs = startedAt ? Date.now() - new Date(startedAt).getTime() : 0;
          if (run.status === 'EXECUTING' && ageMs > 180_000) {
            logger.warn(`poll-cron-${source}: bot ${bot.id} run is stale EXECUTING (${Math.round(ageMs / 1000)}s), treating as dead`, {
              botId: bot.id, runId: activeRunId,
            });
          } else {
            logger.info(`poll-cron-${source}: bot ${bot.id} has active run (${run.status}), skipping`, {
              botId: bot.id, runId: activeRunId,
            });
            continue;
          }
        }
      } catch {
        // Can't verify — proceed with trigger
      }
    }

    // Trigger poll-visa
    const concurrencyKey = isCloud ? `poll-cloud-${bot.id}` : `poll-${bot.id}`;
    try {
      const handle = await pollVisaTask.trigger(
        {
          botId: bot.id,
          ...(isCloud ? { chainId: 'cloud' as const } : {}),
        },
        {
          queue: 'visa-polling-per-bot',
          concurrencyKey,
          priority: calculatePriority(bot.activatedAt),
          tags: [`bot:${bot.id}`, ...(isCloud ? ['cloud'] : []), 'cron'],
        },
      );

      // Update activeRunId
      const updateField = isCloud
        ? { activeCloudRunId: handle.id }
        : { activeRunId: handle.id };
      await db.update(bots)
        .set({ ...updateField, updatedAt: new Date() })
        .where(eq(bots.id, bot.id))
        .catch((e) => logger.error('activeRunId update failed', { botId: bot.id, error: String(e) }));

      logger.info(`poll-cron-${source}: triggered bot ${bot.id}`, {
        botId: bot.id,
        runId: handle.id,
      });
    } catch (e) {
      logger.error(`poll-cron-${source}: failed to trigger bot ${bot.id}`, {
        botId: bot.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Auto-retry bots stuck in login_required (transient network failures, e.g. RPi offline)
  const stuckBots = await db.select({
    id: bots.id,
    pollEnvironments: bots.pollEnvironments,
    updatedAt: bots.updatedAt,
  }).from(bots)
    .where(and(
      eq(bots.status, 'login_required'),
      lte(bots.updatedAt, new Date(Date.now() - 5 * 60_000)),
    ));

  if (stuckBots.length > 0) {
    const { loginVisaTask } = await import('./login-visa.js');
    for (const bot of stuckBots) {
      const envs = (bot.pollEnvironments as string[] | null) ?? ['dev'];
      const chainId = envs.includes('dev') ? 'dev' : 'cloud';
      try {
        await loginVisaTask.trigger(
          { botId: bot.id, chainId: chainId as 'dev' | 'cloud' },
          {
            idempotencyKey: `login-retry-${bot.id}-${Math.floor(Date.now() / 300_000)}`,
            tags: [`bot:${bot.id}`, 'login-retry'],
          },
        );
        logger.info('poll-cron: triggered login-retry for stuck bot', {
          botId: bot.id, chainId, stuckMinutes: Math.round((Date.now() - bot.updatedAt.getTime()) / 60_000),
        });
      } catch (e) {
        logger.error('poll-cron: failed to trigger login-retry', {
          botId: bot.id, error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
}

/**
 * Cloud cron: even minutes (0,2,4...), PRODUCTION only.
 * Fallback for when chain is not active. Chains use exact 90s self-trigger.
 * Combined with local cron (1min offset), effective gap ~1min between sources.
 */
export const pollCronCloud = schedules.task({
  id: 'poll-cron-cloud',
  cron: {
    pattern: '*/2 * * * *',
    environments: ['PRODUCTION'],
  },
  machine: { preset: 'micro' },
  maxDuration: 30,
  run: async () => triggerEligibleBots('cloud'),
});

/**
 * Local cron: odd minutes (1,3,5...), DEV/RPi only.
 * Fallback for when chain is not active. Chains use exact 90s self-trigger.
 * 1min offset from cloud cron (closest to ideal 45s offset that cron supports).
 */
export const pollCronLocal = schedules.task({
  id: 'poll-cron-local',
  cron: {
    pattern: '1/2 * * * *',
    environments: ['DEVELOPMENT'],
  },
  machine: { preset: 'micro' },
  maxDuration: 30,
  run: async () => triggerEligibleBots('dev'),
});

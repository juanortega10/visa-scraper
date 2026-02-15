import { schedules, logger, runs } from '@trigger.dev/sdk/v3';
import { db } from '../db/client.js';
import { bots } from '../db/schema.js';
import { eq, inArray, and } from 'drizzle-orm';
import { calculatePriority } from '../services/scheduling.js';

type Source = 'dev' | 'cloud';

/**
 * Trigger poll-visa for all eligible bots that should be polled from this source.
 * Eligible = active/error scouts whose pollEnvironments includes this source.
 */
async function triggerEligibleBots(source: Source): Promise<void> {
  // SELECT only columns needed for cron eligibility — omit casCacheJson, creds, etc.
  const activeBots = await db.select({
    id: bots.id, status: bots.status, isScout: bots.isScout,
    pollEnvironments: bots.pollEnvironments, cloudEnabled: bots.cloudEnabled,
    activeRunId: bots.activeRunId, activeCloudRunId: bots.activeCloudRunId,
    activatedAt: bots.activatedAt,
  }).from(bots)
    .where(
      and(
        inArray(bots.status, ['active', 'error']),
        eq(bots.isScout, true),
      ),
    );

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
          cronTriggered: true,
        },
        {
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
}

/**
 * Cloud cron: even minutes, PRODUCTION only.
 * Triggers poll-visa for bots with 'prod' in pollEnvironments.
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
 * Local cron: odd minutes, no env restriction (runs on DEV/RPi).
 * Triggers poll-visa for bots with 'dev' in pollEnvironments.
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

import { schedules, logger } from '@trigger.dev/sdk/v3';
import { and, eq, lt, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { botCredentialAttempts } from '../db/schema.js';
import { discoverAgencyBatchTask } from './discover-agency-batch.js';

const MAX_TOTAL_ATTEMPTS = 4; // D26: 1 + 3 retries
const STALE_MIN = 15;

/**
 * DB-as-durable-queue reconciler (D34). Every 5 min on the RPi (DEVELOPMENT, the
 * worker with the right IP). Finds agencies with due work — stale `pending`
 * (missed triggers / Trigger-down recovery) or transient `failed` due for a 15-min
 * retry — and re-runs the inline batch per agency. Idempotent per (agency, 5-min slot)
 * so it never piles up concurrent batches.
 */
export const reconcileAgencyAttempts = schedules.task({
  id: 'reconcile-agency-attempts',
  cron: { pattern: '*/5 * * * *', environments: ['DEVELOPMENT'] },
  machine: { preset: 'micro' },
  maxDuration: 60,
  run: async () => {
    const cutoff = new Date(Date.now() - STALE_MIN * 60 * 1000);
    const slot = Math.floor(Date.now() / (5 * 60 * 1000)); // 5-min bucket for idempotency

    const due = await db
      .selectDistinct({ agencyId: botCredentialAttempts.agencyId })
      .from(botCredentialAttempts)
      .where(
        or(
          and(eq(botCredentialAttempts.status, 'pending'), lt(botCredentialAttempts.createdAt, cutoff)),
          and(
            eq(botCredentialAttempts.status, 'failed'),
            lt(botCredentialAttempts.retryCount, MAX_TOTAL_ATTEMPTS),
            lt(botCredentialAttempts.lastAttemptAt, cutoff),
          ),
        ),
      );

    for (const { agencyId } of due) {
      await discoverAgencyBatchTask.trigger(
        { agencyId },
        { idempotencyKey: `reconcile-batch-${agencyId}-${slot}`, idempotencyKeyTTL: '5m' },
      );
    }

    logger.info('reconcile-agency-attempts', { agencies: due.length });
    return { agencies: due.length };
  },
});

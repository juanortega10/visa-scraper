import { schedules, logger } from '@trigger.dev/sdk/v3';
import { and, eq, lt, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { botCredentialAttempts } from '../db/schema.js';
import { discoverAgencyAttemptTask } from './discover-agency-batch.js';

// D26: a transient failure is retried at a 15-min cadence, up to 3 retries
// (1 initial attempt + 3 retries = 4 total), then left as "requiere acción".
const MAX_TOTAL_ATTEMPTS = 4;
const STALE_MIN = 15;
// Permanent failures must NOT be retried (D27): invalid creds → fix password,
// corrupt/invalid-country → fix data. Surfaced in the report instead.
const PERMANENT = new Set(['invalid_credentials', 'corrupt_credentials', 'invalid_country']);

/**
 * DB-as-durable-queue reconciler (D34). Runs on the RPi (DEVELOPMENT) since discovery
 * needs the worker's IP. Safety net that makes the pipeline resilient to Trigger/RPi
 * outages and lost triggers:
 *   - drains stale `pending` attempts the explicit discover-all never picked up
 *   - re-attempts transient `failed` attempts on a 15-min cadence (max 3)
 * Idempotent per (attempt, retryCount) so it never double-processes vs discover-all.
 */
export const reconcileAgencyAttempts = schedules.task({
  id: 'reconcile-agency-attempts',
  cron: { pattern: '*/5 * * * *', environments: ['DEVELOPMENT'] },
  machine: { preset: 'micro' },
  maxDuration: 60,
  run: async () => {
    const cutoff = new Date(Date.now() - STALE_MIN * 60 * 1000);

    const rows = await db
      .select({
        id: botCredentialAttempts.id,
        agencyId: botCredentialAttempts.agencyId,
        status: botCredentialAttempts.status,
        retryCount: botCredentialAttempts.retryCount,
        lastError: botCredentialAttempts.lastError,
      })
      .from(botCredentialAttempts)
      .where(
        or(
          // Stragglers: pending never picked up (missed trigger / Trigger was down).
          and(eq(botCredentialAttempts.status, 'pending'), lt(botCredentialAttempts.createdAt, cutoff)),
          // Transient failures due for their next 15-min-spaced retry.
          and(
            eq(botCredentialAttempts.status, 'failed'),
            lt(botCredentialAttempts.retryCount, MAX_TOTAL_ATTEMPTS),
            lt(botCredentialAttempts.lastAttemptAt, cutoff),
          ),
        ),
      );

    const due = rows.filter(
      (r) => r.status === 'pending' || !PERMANENT.has((r.lastError ?? '').trim()),
    );

    for (const r of due) {
      await discoverAgencyAttemptTask.trigger(
        { attemptId: r.id, agencyId: r.agencyId },
        { idempotencyKey: `discover-attempt-${r.id}-${r.retryCount}`, idempotencyKeyTTL: '20m' },
      );
    }

    logger.info('reconcile-agency-attempts', { candidates: rows.length, triggered: due.length });
    return { candidates: rows.length, triggered: due.length };
  },
});

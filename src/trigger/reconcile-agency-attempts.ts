import { schedules, logger } from '@trigger.dev/sdk/v3';
import { and, eq, lt, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { botCredentialAttempts } from '../db/schema.js';
import { processAgencyDue } from '../services/agency-batch.js';

const MAX_TOTAL_ATTEMPTS = 4; // D26: 1 + 3 retries

/**
 * The RELIABLE processor (D34). Runs every 2 min on the RPi (DEVELOPMENT — the worker
 * with the right IP). Schedules execute in-session reliably (unlike external `.trigger()`
 * runs which can sit PENDING_VERSION in dev), so this does the discover + auto-create
 * work INLINE for every agency with due attempts: fresh `pending` + transient `failed`
 * due for a 15-min retry. Also drains anything a missed/Trigger-down `.trigger()` left.
 */
export const reconcileAgencyAttempts = schedules.task({
  id: 'reconcile-agency-attempts',
  cron: { pattern: '*/2 * * * *', environments: ['DEVELOPMENT'] },
  machine: { preset: 'small-1x' },
  maxDuration: 300,
  run: async () => {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const due = await db
      .selectDistinct({ agencyId: botCredentialAttempts.agencyId })
      .from(botCredentialAttempts)
      .where(
        or(
          eq(botCredentialAttempts.status, 'pending'),
          and(
            eq(botCredentialAttempts.status, 'failed'),
            lt(botCredentialAttempts.retryCount, MAX_TOTAL_ATTEMPTS),
            lt(botCredentialAttempts.lastAttemptAt, cutoff),
          ),
        ),
      );

    let processed = 0;
    for (const { agencyId } of due) {
      const counts = await processAgencyDue(agencyId, (m, d) => logger.info(m, d as Record<string, unknown>));
      processed += counts.total;
    }
    logger.info('reconcile-agency-attempts', { agencies: due.length, processed });
    return { agencies: due.length, processed };
  },
});

import { task, logger } from '@trigger.dev/sdk/v3';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { botCredentialAttempts } from '../db/schema.js';
import { agencyDiscoverQueue } from './queues.js';
import { runDiscoveryForAttempt, isTransientDiscoverError } from '../services/agency-discovery.js';

interface AttemptPayload {
  attemptId: number;
  agencyId: number;
  clerkUserId?: string | null;
}

/**
 * Discover ONE agency credential attempt. Runs on the concurrency-limited
 * agency-discover queue (anti-ban). Transient failures throw so Trigger retries
 * (maxAttempts 3 = 1 try + 2 retries, D18); permanent failures return without retry.
 */
export const discoverAgencyAttemptTask = task({
  id: 'discover-agency-attempt',
  queue: agencyDiscoverQueue,
  machine: { preset: 'micro' },
  maxDuration: 90,
  retry: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 15000, factor: 2 },
  run: async (payload: AttemptPayload) => {
    const { attemptId, agencyId, clerkUserId } = payload;
    const [attempt] = await db
      .select()
      .from(botCredentialAttempts)
      .where(and(eq(botCredentialAttempts.id, attemptId), eq(botCredentialAttempts.agencyId, agencyId)));

    if (!attempt) return { attemptId, status: 'failed' as const, error: 'attempt_not_found' };
    if (attempt.status === 'used') return { attemptId, status: 'used' as const };

    const res = await runDiscoveryForAttempt(attempt, { clerkUserId });

    // Let Trigger retry only transient failures (portal down / network).
    if (res.status === 'failed' && isTransientDiscoverError(res.error)) {
      throw new Error(`discover transient failure for attempt ${attemptId}: ${res.message ?? res.error}`);
    }
    return { attemptId, status: res.status, error: res.error };
  },
});

/**
 * Parent task: discover ALL pending/failed attempts for an agency in bulk.
 * Fans out one child run per attempt (throttled by the queue), waits for all,
 * then aggregates. Triggered by POST /api/agencies/:id/credential-attempts/discover-all.
 */
export const discoverAgencyBatchTask = task({
  id: 'discover-agency-batch',
  machine: { preset: 'micro' },
  maxDuration: 60,
  run: async (payload: { agencyId: number; clerkUserId?: string | null }) => {
    const { agencyId, clerkUserId } = payload;

    const targets = await db
      .select({ id: botCredentialAttempts.id })
      .from(botCredentialAttempts)
      .where(
        and(
          eq(botCredentialAttempts.agencyId, agencyId),
          inArray(botCredentialAttempts.status, ['pending', 'failed']),
        ),
      );

    if (targets.length === 0) {
      logger.info('discover-agency-batch: nothing to discover', { agencyId });
      return { agencyId, total: 0, ready: 0, failed: 0 };
    }

    logger.info('discover-agency-batch START', { agencyId, total: targets.length });

    const batch = await discoverAgencyAttemptTask.batchTriggerAndWait(
      targets.map((t) => ({ payload: { attemptId: t.id, agencyId, clerkUserId } })),
    );

    let ready = 0;
    let failed = 0;
    for (const run of batch.runs) {
      if (run.ok && run.output?.status === 'ready') ready++;
      else failed++;
    }

    logger.info('discover-agency-batch DONE', { agencyId, total: targets.length, ready, failed });

    // Fase 4: notifyAgencyBatchTask.trigger({ agencyId, kind: 'discovery', ready, failed, total: targets.length })

    return { agencyId, total: targets.length, ready, failed };
  },
});

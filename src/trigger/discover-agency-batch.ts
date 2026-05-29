import { task, logger, metadata } from '@trigger.dev/sdk/v3';
import { and, eq, lt, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agencies, botCredentialAttempts } from '../db/schema.js';
import { runDiscoveryForAttempt } from '../services/agency-discovery.js';
import { createBotFromAttempt } from '../services/agency-bot-creation.js';
import { sendAgencyBatchSummaryEmail } from '../services/notifications.js';

type AttemptRow = typeof botCredentialAttempts.$inferSelect;
type AgencyRow = typeof agencies.$inferSelect;

// Anti-ban: at most this many concurrent portal logins per batch run.
const CONCURRENCY = 3;
// D26: retry transient failures at a 15-min cadence, up to 3 retries (4 attempts total).
const MAX_TOTAL_ATTEMPTS = 4;
const RETRY_AFTER_MIN = 15;

type Outcome = 'created' | 'invalid_creds' | 'portal_down' | 'max_bots' | 'other';

/** Discover one attempt and, if it lands ready, create its bot. Reuses the same
 * services the per-bot endpoint uses. Processed INLINE (no child-task fan-out) so it
 * runs reliably in the dev worker — child-task fan-out + batchTriggerAndWait proved
 * fragile in this environment (runs stuck PENDING_VERSION). */
async function processAttempt(attempt: AttemptRow, agency: AgencyRow | undefined): Promise<Outcome> {
  const res = await runDiscoveryForAttempt(attempt);
  if (res.status !== 'ready') {
    return res.error === 'invalid_credentials' || res.error === 'corrupt_credentials' || res.error === 'invalid_country'
      ? 'invalid_creds'
      : 'portal_down';
  }
  if (!agency) return 'other';
  const [fresh] = await db.select().from(botCredentialAttempts).where(eq(botCredentialAttempts.id, attempt.id));
  if (!fresh) return 'other';
  const created = await createBotFromAttempt(fresh, agency);
  if (created.status === 'created') return 'created';
  if (created.status === 'skipped' && created.reason === 'max_bots') return 'max_bots';
  if (created.status === 'skipped' && (created.reason === 'duplicate' || created.reason === 'already_used')) return 'created';
  return 'other';
}

/**
 * Discover + auto-create all due attempts for an agency, inline with bounded concurrency.
 * Triggered by POST /api/agencies/:id/credential-attempts/discover-all and by the
 * reconciler. Targets: pending attempts + transient-failed ones due for a 15-min retry.
 */
export const discoverAgencyBatchTask = task({
  id: 'discover-agency-batch',
  machine: { preset: 'small-1x' },
  maxDuration: 1800,
  run: async (payload: { agencyId: number; clerkUserId?: string | null }) => {
    const { agencyId } = payload;
    const cutoff = new Date(Date.now() - RETRY_AFTER_MIN * 60 * 1000);

    const targets = await db
      .select()
      .from(botCredentialAttempts)
      .where(
        and(
          eq(botCredentialAttempts.agencyId, agencyId),
          or(
            eq(botCredentialAttempts.status, 'pending'),
            and(
              eq(botCredentialAttempts.status, 'failed'),
              lt(botCredentialAttempts.retryCount, MAX_TOTAL_ATTEMPTS),
              lt(botCredentialAttempts.lastAttemptAt, cutoff),
            ),
          ),
        ),
      );

    if (targets.length === 0) {
      logger.info('discover-agency-batch: nothing due', { agencyId });
      return { agencyId, total: 0, activated: 0, invalidCreds: 0, portalDown: 0, maxBots: 0, other: 0 };
    }

    // Skip transient-failed that aren't due yet for retry (belt-and-suspenders vs the SQL).
    const [agency] = await db.select().from(agencies).where(eq(agencies.id, agencyId));
    logger.info('discover-agency-batch START', { agencyId, total: targets.length });

    const counts = { activated: 0, invalidCreds: 0, portalDown: 0, maxBots: 0, other: 0 };
    const bump = (o: Outcome) => {
      if (o === 'created') counts.activated++;
      else if (o === 'invalid_creds') counts.invalidCreds++;
      else if (o === 'portal_down') counts.portalDown++;
      else if (o === 'max_bots') counts.maxBots++;
      else counts.other++;
    };

    let idx = 0;
    let done = 0;
    metadata.set('progress', { done: 0, total: targets.length });
    const worker = async () => {
      while (idx < targets.length) {
        const a = targets[idx++]!;
        try {
          bump(await processAttempt(a, agency));
        } catch (e) {
          counts.other++;
          logger.error('processAttempt failed', { attemptId: a.id, error: String(e) });
        }
        done++;
        metadata.set('progress', { done, total: targets.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

    logger.info('discover-agency-batch DONE', { agencyId, total: targets.length, ...counts });

    if (agency?.contactEmail) {
      await sendAgencyBatchSummaryEmail(agency.contactEmail, agency.name, {
        total: targets.length,
        activated: counts.activated,
        invalidCreds: counts.invalidCreds,
        portalDown: counts.portalDown,
        maxBots: counts.maxBots,
        other: counts.other,
      }).catch((e) => logger.warn('batch summary email failed', { error: String(e) }));
    }

    return { agencyId, total: targets.length, ...counts };
  },
});

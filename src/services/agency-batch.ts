import { and, eq, lt, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agencies, botCredentialAttempts } from '../db/schema.js';
import { runDiscoveryForAttempt } from './agency-discovery.js';
import { createBotFromAttempt } from './agency-bot-creation.js';
import { sendAgencyBatchSummaryEmail } from './notifications.js';

type AttemptRow = typeof botCredentialAttempts.$inferSelect;
type AgencyRow = typeof agencies.$inferSelect;

const CONCURRENCY = 3; // anti-ban: concurrent portal logins per agency
const MAX_TOTAL_ATTEMPTS = 4; // D26
const RETRY_AFTER_MIN = 15;

export type BatchCounts = { total: number; activated: number; invalidCreds: number; portalDown: number; maxBots: number; other: number };
type Outcome = 'created' | 'invalid_creds' | 'portal_down' | 'max_bots' | 'other';

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

/** Find the attempts that are due for processing for an agency: fresh `pending`
 * plus transient `failed` whose 15-min retry window has elapsed (D26). */
export async function findDueAttempts(agencyId: number): Promise<AttemptRow[]> {
  const cutoff = new Date(Date.now() - RETRY_AFTER_MIN * 60 * 1000);
  return db
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
}

/**
 * Discover + auto-create all due attempts for one agency, inline with bounded
 * concurrency. Pure (no Trigger deps) so it runs reliably whether called from the
 * batch task OR directly inside the reconciler schedule. Sends the summary email.
 */
export async function processAgencyDue(
  agencyId: number,
  log: (msg: string, data?: unknown) => void = () => {},
): Promise<BatchCounts> {
  const targets = await findDueAttempts(agencyId);
  if (targets.length === 0) return { total: 0, activated: 0, invalidCreds: 0, portalDown: 0, maxBots: 0, other: 0 };

  const [agency] = await db.select().from(agencies).where(eq(agencies.id, agencyId));
  log('agency-batch START', { agencyId, total: targets.length });

  const counts: BatchCounts = { total: targets.length, activated: 0, invalidCreds: 0, portalDown: 0, maxBots: 0, other: 0 };
  let idx = 0;
  const worker = async () => {
    while (idx < targets.length) {
      const a = targets[idx++]!;
      try {
        const o = await processAttempt(a, agency);
        if (o === 'created') counts.activated++;
        else if (o === 'invalid_creds') counts.invalidCreds++;
        else if (o === 'portal_down') counts.portalDown++;
        else if (o === 'max_bots') counts.maxBots++;
        else counts.other++;
      } catch (e) {
        counts.other++;
        log('processAttempt failed', { attemptId: a.id, error: String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  log('agency-batch DONE', { agencyId, ...counts });

  if (agency?.contactEmail) {
    await sendAgencyBatchSummaryEmail(agency.contactEmail, agency.name, counts).catch((e) =>
      log('batch summary email failed', { error: String(e) }),
    );
  }
  return counts;
}

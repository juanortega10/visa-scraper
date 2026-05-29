import { task, logger } from '@trigger.dev/sdk/v3';
import { processAgencyDue } from '../services/agency-batch.js';

/**
 * Best-effort immediate processor: discover + auto-create all due attempts for an
 * agency, inline. Triggered by POST /discover-all. NOTE: in the dev worker, external
 * `.trigger()` runs can sit PENDING_VERSION; the reconcile-agency-attempts schedule is
 * the reliable path (runs in-session) and calls the same processAgencyDue within ~2 min.
 */
export const discoverAgencyBatchTask = task({
  id: 'discover-agency-batch',
  machine: { preset: 'micro' },
  maxDuration: 300,
  run: async (payload: { agencyId: number; clerkUserId?: string | null }) => {
    const counts = await processAgencyDue(payload.agencyId, (m, d) => logger.info(m, d as Record<string, unknown>));
    return { agencyId: payload.agencyId, ...counts };
  },
});

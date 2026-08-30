import { db } from '../db/client.js';
import { botCredentialAttempts } from '../db/schema.js';
import type { DiscoveredAttemptData } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from './encryption.js';
import { resolveLocale, MAX_TOTAL_ATTEMPTS } from '../utils/constants.js';
import { InvalidCredentialsError, AccountLockedError, NoSchedulableGroupError } from './login.js';
import { discoverWithFallback } from '../api/bots.js';
import { setDiscoveryToken } from './discovery-tokens.js';
import { logAuth } from '../utils/auth-logger.js';

type AttemptRow = typeof botCredentialAttempts.$inferSelect;

export type DiscoverErrorCode =
  | 'invalid_credentials'
  | 'account_locked'
  | 'visa_fee_unpaid'
  | 'discovery_failed'
  | 'corrupt_credentials'
  | 'invalid_country';

/** Errors a retry can never clear. The reconciler must not spend another portal login
 * on these — for `invalid_credentials` and `account_locked` a retry actively harms the
 * client's account, because the portal locks after repeated failed logins. */
const TERMINAL_ERRORS: ReadonlySet<DiscoverErrorCode> = new Set<DiscoverErrorCode>([
  'invalid_credentials',
  'account_locked',
  'visa_fee_unpaid',
  'corrupt_credentials',
  'invalid_country',
]);

export function isTerminalDiscoverError(code: DiscoverErrorCode | null | undefined): boolean {
  return code != null && TERMINAL_ERRORS.has(code);
}

export interface DiscoverAttemptResult {
  status: 'ready' | 'failed';
  error?: DiscoverErrorCode;
  message?: string;
  discoveryToken?: string;
  discoveredData?: DiscoveredAttemptData;
  locale?: string;
}

/**
 * Run discovery (login + extract) for ONE credential attempt and persist the result.
 * Shared by the single-attempt PATCH endpoint and the bulk Trigger.dev task so the
 * behavior stays identical. Never throws — returns a structured result.
 */
export async function runDiscoveryForAttempt(
  attempt: AttemptRow,
  opts: { clerkUserId?: string | null; ip?: string | null } = {},
): Promise<DiscoverAttemptResult> {
  // Mark permanent pre-flight failures as 'failed' (not left 'pending') so the
  // reconciler doesn't retry them forever and they surface in the report.
  // retryCount jumps to MAX_TOTAL_ATTEMPTS because `findDueAttempts` re-queues any
  // `failed` row still under the cap — without this the row comes back every 15 min.
  const markFailed = async (err: DiscoverErrorCode): Promise<DiscoverAttemptResult> => {
    await db
      .update(botCredentialAttempts)
      .set({
        status: 'failed',
        lastError: err,
        lastAttemptAt: new Date(),
        retryCount: MAX_TOTAL_ATTEMPTS,
        updatedAt: new Date(),
      })
      .where(eq(botCredentialAttempts.id, attempt.id));
    return { status: 'failed', error: err };
  };

  let visaEmail: string;
  let visaPassword: string;
  try {
    visaEmail = decrypt(attempt.visaEmail);
    visaPassword = decrypt(attempt.visaPassword);
  } catch {
    return markFailed('corrupt_credentials');
  }

  const locale = resolveLocale(attempt.country);
  if (!locale) return markFailed('invalid_country');

  await db
    .update(botCredentialAttempts)
    .set({ status: 'discovering', lastAttemptAt: new Date(), updatedAt: new Date() })
    .where(eq(botCredentialAttempts.id, attempt.id));

  try {
    const { result, via } = await discoverWithFallback(visaEmail, visaPassword, locale);
    const discoveryToken = setDiscoveryToken(result);
    const discoveredData: DiscoveredAttemptData = {
      scheduleId: result.scheduleId,
      userId: result.userId,
      applicantIds: result.applicantIds,
      applicantNames: result.applicantNames,
      currentConsularDate: result.currentConsularDate,
      currentConsularTime: result.currentConsularTime,
      currentCasDate: result.currentCasDate,
      currentCasTime: result.currentCasTime,
      consularFacilityId: result.consularFacilityId,
      ascFacilityId: result.ascFacilityId,
      collectsBiometrics: result.collectsBiometrics,
      primaryVisaCategory: result.primaryVisaCategory ?? null,
      primaryVisaTypeRaw: result.primaryVisaTypeRaw ?? null,
      applicantVisaTypes: result.applicantVisaTypes ?? null,
    };

    await db
      .update(botCredentialAttempts)
      .set({
        status: 'ready',
        locale,
        discoveryToken,
        discoveredData,
        lastError: null,
        retryCount: attempt.retryCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(botCredentialAttempts.id, attempt.id));

    logAuth({
      email: visaEmail, action: 'discover', locale, result: 'ok', errorMessage: via,
      password: visaPassword, clerkUserId: opts.clerkUserId ?? null, ip: opts.ip ?? null,
    });

    return { status: 'ready', discoveryToken, discoveredData, locale };
  } catch (e) {
    const isInvalid = e instanceof InvalidCredentialsError;
    const isLocked = e instanceof AccountLockedError;
    const isUnpaid = e instanceof NoSchedulableGroupError;
    const code: DiscoverErrorCode = isInvalid
      ? 'invalid_credentials'
      : isLocked
      ? 'account_locked'
      : isUnpaid
      ? 'visa_fee_unpaid'
      : 'discovery_failed';
    const errorMessage = isInvalid
      ? 'invalid_credentials'
      : e instanceof Error
      ? e.message
      : String(e);

    await db
      .update(botCredentialAttempts)
      .set({
        status: 'failed',
        lastError: errorMessage,
        // A wrong password stays wrong, and a locked account only unlocks with time —
        // burn the remaining budget so the reconciler stops hitting the portal.
        retryCount: isTerminalDiscoverError(code) ? MAX_TOTAL_ATTEMPTS : attempt.retryCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(botCredentialAttempts.id, attempt.id));

    logAuth({
      email: visaEmail, action: 'discover', locale,
      result: isInvalid || isLocked ? 'invalid' : 'error', errorMessage,
      password: visaPassword, clerkUserId: opts.clerkUserId ?? null, ip: opts.ip ?? null,
    });

    return { status: 'failed', error: code, message: errorMessage };
  }
}

import { db } from '../db/client.js';
import { botCredentialAttempts } from '../db/schema.js';
import type { DiscoveredAttemptData } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from './encryption.js';
import { resolveLocale } from '../utils/constants.js';
import { InvalidCredentialsError } from './login.js';
import { discoverWithFallback } from '../api/bots.js';
import { setDiscoveryToken } from './discovery-tokens.js';
import { logAuth } from '../utils/auth-logger.js';

type AttemptRow = typeof botCredentialAttempts.$inferSelect;

export type DiscoverErrorCode =
  | 'invalid_credentials'
  | 'discovery_failed'
  | 'corrupt_credentials'
  | 'invalid_country';

export interface DiscoverAttemptResult {
  status: 'ready' | 'failed';
  error?: DiscoverErrorCode;
  message?: string;
  discoveryToken?: string;
  discoveredData?: DiscoveredAttemptData;
  locale?: string;
}

/** True for failures worth retrying (transient: portal down, network). Invalid
 * credentials / bad country / corrupt are permanent and must NOT be retried. */
export function isTransientDiscoverError(code?: DiscoverErrorCode): boolean {
  return code === 'discovery_failed';
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
  let visaEmail: string;
  let visaPassword: string;
  try {
    visaEmail = decrypt(attempt.visaEmail);
    visaPassword = decrypt(attempt.visaPassword);
  } catch {
    return { status: 'failed', error: 'corrupt_credentials' };
  }

  const locale = resolveLocale(attempt.country);
  if (!locale) return { status: 'failed', error: 'invalid_country' };

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
        retryCount: attempt.retryCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(botCredentialAttempts.id, attempt.id));

    logAuth({
      email: visaEmail, action: 'discover', locale,
      result: isInvalid ? 'invalid' : 'error', errorMessage,
      password: visaPassword, clerkUserId: opts.clerkUserId ?? null, ip: opts.ip ?? null,
    });

    return {
      status: 'failed',
      error: isInvalid ? 'invalid_credentials' : 'discovery_failed',
      message: errorMessage,
    };
  }
}

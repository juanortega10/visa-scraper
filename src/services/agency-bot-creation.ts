import { and, count, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  bots,
  botCredentialAttempts,
  excludedDates,
  excludedTimes,
  sessions,
} from '../db/schema.js';
import type { AttemptConfig } from '../db/schema.js';
import { encrypt } from './encryption.js';
import { consumeDiscoveryToken } from './discovery-tokens.js';
import { findDuplicateBot, COUNTRY_DEFAULTS } from '../api/bots.js';

type AttemptRow = typeof botCredentialAttempts.$inferSelect;
type AgencyRow = typeof agencies.$inferSelect;

export type CreateBotResult =
  | { status: 'created'; botId: number; activation: 'active' | 'login_required' }
  | { status: 'skipped'; reason: 'not_ready' | 'duplicate' | 'max_bots' | 'already_used' };

/**
 * Create a bot from a discovered ('ready') agency credential attempt, applying the
 * restrictions captured at collection time (attempt.config) and the client phone.
 * B2B (clientType='b2b'), owner = agency. Reuses the fresh discovery session if its
 * token is still cached (same worker run), otherwise triggers login-visa.
 *
 * Mirrors the agency path of POST /api/bots so behavior stays identical, but is
 * callable from the background pipeline (discover→create) and the reconciler.
 * Never throws on business outcomes — returns a structured result.
 */
export async function createBotFromAttempt(
  attempt: AttemptRow,
  agency: AgencyRow,
): Promise<CreateBotResult> {
  if (attempt.botId) return { status: 'skipped', reason: 'already_used' };
  if (attempt.status !== 'ready' || !attempt.discoveredData) return { status: 'skipped', reason: 'not_ready' };
  const d = attempt.discoveredData;

  // Plan cap.
  const [{ existing = 0 } = { existing: 0 }] = await db
    .select({ existing: count() })
    .from(bots)
    .where(eq(bots.agencyId, agency.id));
  if (existing >= agency.maxBots) return { status: 'skipped', reason: 'max_bots' };

  // Same (scheduleId, applicantIds) → same real embassy account. Link + skip.
  const dup = await findDuplicateBot(d.scheduleId, d.applicantIds);
  if (dup) {
    await db
      .update(botCredentialAttempts)
      .set({ status: 'used', botId: dup.id, updatedAt: new Date() })
      .where(eq(botCredentialAttempts.id, attempt.id));
    return { status: 'skipped', reason: 'duplicate' };
  }

  const locale = attempt.locale ?? 'es-co';
  const cc = locale.split('-')[1] ?? '';
  const config: AttemptConfig = attempt.config ?? {};
  const targetDateBefore = config.targetDateBefore ?? COUNTRY_DEFAULTS[cc]?.targetDateBefore ?? null;
  const maxReschedules =
    config.maxReschedules ?? COUNTRY_DEFAULTS[cc]?.maxReschedules ?? null;

  // Creds are already encrypted on the attempt — copy ciphertext as-is (same key).
  const [bot] = await db
    .insert(bots)
    .values({
      visaEmail: attempt.visaEmail,
      visaPassword: attempt.visaPassword,
      scheduleId: d.scheduleId,
      applicantIds: d.applicantIds,
      consularFacilityId: d.consularFacilityId,
      ascFacilityId: d.ascFacilityId,
      locale,
      targetDateBefore,
      maxReschedules,
      currentConsularDate: d.currentConsularDate,
      currentConsularTime: d.currentConsularTime,
      currentCasDate: d.currentCasDate,
      currentCasTime: d.currentCasTime,
      notificationEmail: process.env.ADMIN_NOTIFICATION_EMAIL ?? null,
      ownerEmail: agency.contactEmail,
      // Client WhatsApp (D6), fallback to the agency number.
      notificationPhone: attempt.notificationPhone ?? agency.contactPhone ?? null,
      proxyProvider: 'webshare',
      agencyId: agency.id,
      clientType: 'b2b',
      testMode: agency.testMode,
      status: agency.testMode ? 'active' : 'login_required',
      activatedAt: new Date(),
    })
    .returning();
  if (!bot) throw new Error(`bot insert failed for attempt ${attempt.id}`);

  // Restrictions captured at collection time.
  if (config.excludedDateRanges?.length) {
    await db.insert(excludedDates).values(
      config.excludedDateRanges.map((r) => ({ botId: bot.id, startDate: r.startDate, endDate: r.endDate })),
    );
  }
  if (config.excludedTimeRanges?.length) {
    await db.insert(excludedTimes).values(
      config.excludedTimeRanges.map((r) => ({ botId: bot.id, date: null, timeStart: r.timeStart, timeEnd: r.timeEnd })),
    );
  }

  await db
    .update(botCredentialAttempts)
    .set({ status: 'used', botId: bot.id, updatedAt: new Date() })
    .where(eq(botCredentialAttempts.id, attempt.id));

  // Test-mode: shown active, never polls. No embassy traffic.
  if (bot.testMode) return { status: 'created', botId: bot.id, activation: 'active' };

  // Reuse the fresh discovery session if its token is still cached (same worker run).
  const cached = consumeDiscoveryToken(attempt.discoveryToken);
  if (cached) {
    await db.insert(sessions).values({ botId: bot.id, yatriCookie: encrypt(cached.cookie) });
    await db.update(bots).set({ status: 'active', updatedAt: new Date() }).where(eq(bots.id, bot.id));
    const { pollVisaTask } = await import('../trigger/poll-visa.js');
    const handle = await pollVisaTask.trigger(
      { botId: bot.id },
      { delay: '3s', queue: 'visa-polling-per-bot', concurrencyKey: `poll-${bot.id}`, tags: [`bot:${bot.id}`] },
    );
    await db.update(bots).set({ activeRunId: handle.id, updatedAt: new Date() }).where(eq(bots.id, bot.id));
    return { status: 'created', botId: bot.id, activation: 'active' };
  }

  // No cached session → login from the worker, which starts the poll chain.
  const { loginVisaTask } = await import('../trigger/login-visa.js');
  const handle = await loginVisaTask.trigger({ botId: bot.id });
  await db.update(bots).set({ activeRunId: handle.id, updatedAt: new Date() }).where(eq(bots.id, bot.id));
  return { status: 'created', botId: bot.id, activation: 'login_required' };
}

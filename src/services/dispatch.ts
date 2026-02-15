import { logger } from '@trigger.dev/sdk/v3';
import { db } from '../db/client.js';
import { bots, sessions, excludedTimes, dispatchLogs, rescheduleLogs } from '../db/schema.js';
import type { DispatchDetail, CasCacheData } from '../db/schema.js';
import { eq, and, gte, desc } from 'drizzle-orm';
import { decrypt, encrypt } from './encryption.js';
import { logAuth } from '../utils/auth-logger.js';
import { performLogin, InvalidCredentialsError } from './login.js';
import { VisaClient, type DaySlot } from './visa-client.js';
import { executeReschedule } from './reschedule-logic.js';
import { getSubscribersForFacility } from './subscriber-query.js';
import type { ProxyProvider } from './proxy-fetch.js';


export interface DispatchResult {
  dispatchLogId: number;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

/**
 * Dispatch reschedule attempts to subscribers when the scout detects available dates.
 * Runs inline (fire-and-forget) inside the scout's poll-visa run.
 *
 * For each subscriber (sorted by improvement magnitude, largest first):
 * 1. Login with their credentials (~1s)
 * 2. executeReschedule() with the detected dates (~2.5s)
 * 3. Log results
 */
export async function dispatchToSubscribers(opts: {
  facilityId: string;
  availableDates: DaySlot[];
  scoutBotId: number;
  pollLogId: number | null;
  runId: string;
}): Promise<DispatchResult> {
  const { facilityId, availableDates, scoutBotId, pollLogId, runId } = opts;
  const startMs = Date.now();
  const details: DispatchDetail[] = [];

  // Dedup: skip if another chain already dispatched for this facility in the last 3 min
  const DEDUP_WINDOW_MS = 3 * 60 * 1000;
  const [recentDispatch] = await db.select({ id: dispatchLogs.id })
    .from(dispatchLogs)
    .where(and(
      eq(dispatchLogs.facilityId, facilityId),
      gte(dispatchLogs.createdAt, new Date(Date.now() - DEDUP_WINDOW_MS)),
    ))
    .orderBy(desc(dispatchLogs.createdAt)).limit(1);

  if (recentDispatch) {
    logger.info('[dispatch] Skipped — recent dispatch exists (dedup)', {
      facilityId,
      scoutBotId,
      recentDispatchId: recentDispatch.id,
    });
    return { dispatchLogId: recentDispatch.id, attempted: 0, succeeded: 0, failed: 0, skipped: 0, durationMs: Date.now() - startMs };
  }

  // 1. Get subscribers that would benefit
  const subscribers = await getSubscribersForFacility(facilityId, availableDates, scoutBotId);

  if (subscribers.length === 0) {
    logger.info('[dispatch] No subscribers to dispatch to', { facilityId, scoutBotId });
    // Still log the dispatch event for audit trail
    const [log] = await db.insert(dispatchLogs).values({
      scoutBotId,
      facilityId,
      availableDates: availableDates.map((d) => d.date),
      subscribersConsidered: 0,
      subscribersAttempted: 0,
      subscribersSucceeded: 0,
      subscribersFailed: 0,
      subscribersSkipped: 0,
      details: [],
      durationMs: Date.now() - startMs,
      pollLogId,
      runId,
    }).returning({ id: dispatchLogs.id });

    return {
      dispatchLogId: log!.id,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      durationMs: Date.now() - startMs,
    };
  }

  logger.info('[dispatch] Starting dispatch', {
    facilityId,
    scoutBotId,
    subscribers: subscribers.length,
    topDates: availableDates.slice(0, 5).map((d) => d.date),
  });

  // 2. Process each subscriber sequentially
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < subscribers.length; i++) {
    const sub = subscribers[i]!;
    const detail: DispatchDetail = {
      botId: sub.id,
      currentDate: sub.currentConsularDate,
      targetDate: sub.bestDate,
      improvementDays: sub.improvementDays,
      priorityRank: i + 1,
      action: 'attempted',
    };

    logger.info(`[dispatch] Processing subscriber ${i + 1}/${subscribers.length}`, {
      botId: sub.id,
      currentDate: sub.currentConsularDate,
      targetDate: sub.bestDate,
      improvementDays: sub.improvementDays,
    });

    try {
      // a. Login with subscriber's credentials
      const loginStart = Date.now();
      let email: string, password: string;
      try {
        email = decrypt(sub.visaEmail);
        password = decrypt(sub.visaPassword);
      } catch (e) {
        detail.result = 'error';
        detail.error = `decrypt failed: ${e}`;
        details.push(detail);
        failed++;
        continue;
      }

      let loginResult;
      try {
        loginResult = await performLogin({
          email,
          password,
          scheduleId: sub.scheduleId,
          applicantIds: sub.applicantIds,
          locale: sub.locale,
        });
      } catch (loginErr) {
        detail.loginMs = Date.now() - loginStart;
        const isInvalid = loginErr instanceof InvalidCredentialsError;
        logAuth({ email, action: 'dispatch', locale: sub.locale, result: isInvalid ? 'invalid' : 'error', errorMessage: loginErr instanceof Error ? loginErr.message : String(loginErr), botId: sub.id });
        detail.result = 'error';
        detail.error = `login failed: ${loginErr instanceof Error ? loginErr.message : loginErr}`;
        details.push(detail);
        failed++;
        continue;
      }
      detail.loginMs = Date.now() - loginStart;
      logAuth({ email, action: 'dispatch', locale: sub.locale, result: 'ok', botId: sub.id });

      logger.info(`[dispatch] Login OK for subscriber`, {
        botId: sub.id,
        loginMs: detail.loginMs,
        hasTokens: loginResult.hasTokens,
      });

      // Save session for the subscriber (they don't have an active session)
      const sessionData = {
        yatriCookie: encrypt(loginResult.cookie),
        csrfToken: loginResult.csrfToken || null,
        authenticityToken: loginResult.authenticityToken || null,
        lastUsedAt: new Date(),
        createdAt: new Date(),
      };

      // Upsert session
      const [existingSession] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.botId, sub.id));
      if (existingSession) {
        await db.update(sessions).set(sessionData).where(eq(sessions.botId, sub.id));
      } else {
        await db.insert(sessions).values({ botId: sub.id, ...sessionData });
      }

      // b. Create VisaClient for this subscriber
      const client = new VisaClient(
        {
          cookie: loginResult.cookie,
          csrfToken: loginResult.csrfToken,
          authenticityToken: loginResult.authenticityToken,
        },
        {
          scheduleId: sub.scheduleId,
          applicantIds: sub.applicantIds,
          consularFacilityId: sub.consularFacilityId,
          ascFacilityId: sub.ascFacilityId,
          proxyProvider: 'direct' as ProxyProvider, // Always direct for POST
          userId: sub.userId,
          locale: sub.locale,
        },
      );

      // Load time exclusions for this subscriber
      const exTimes = await db.select({
        date: excludedTimes.date,
        timeStart: excludedTimes.timeStart,
        timeEnd: excludedTimes.timeEnd,
      }).from(excludedTimes).where(eq(excludedTimes.botId, sub.id));
      const timeExclusions = exTimes.map((t) => ({
        date: t.date,
        timeStart: t.timeStart,
        timeEnd: t.timeEnd,
      }));

      // Re-read only status + appointment fields (fresh data for reschedule)
      const [freshBot] = await db.select({
        status: bots.status,
        currentConsularDate: bots.currentConsularDate,
        currentConsularTime: bots.currentConsularTime,
        currentCasDate: bots.currentCasDate,
        currentCasTime: bots.currentCasTime,
        ascFacilityId: bots.ascFacilityId,
      }).from(bots).where(eq(bots.id, sub.id));
      if (!freshBot || freshBot.status !== 'active') {
        detail.action = 'skipped_paused';
        details.push(detail);
        skipped++;
        continue;
      }

      // c. Execute reschedule
      const rescheduleStart = Date.now();
      const pending: Promise<unknown>[] = [];
      const result = await executeReschedule({
        client,
        botId: sub.id,
        bot: freshBot,
        dateExclusions: sub.exclusions,
        timeExclusions,
        preFetchedDays: availableDates,
        casCacheJson: sub.casCacheJson as CasCacheData | null,
        dryRun: false,
        pending,
        loginCredentials: { email, password, scheduleId: sub.scheduleId, applicantIds: sub.applicantIds, locale: sub.locale },
      });
      detail.rescheduleMs = Date.now() - rescheduleStart;

      // Flush pending promises from executeReschedule
      await Promise.allSettled(pending);

      if (result.success) {
        detail.result = 'success';
        detail.newDate = result.date;
        succeeded++;
        logger.info(`[dispatch] Reschedule SUCCESS for subscriber`, {
          botId: sub.id,
          oldDate: sub.currentConsularDate,
          newDate: result.date,
          totalMs: detail.loginMs + detail.rescheduleMs,
        });
      } else {
        detail.result = 'failed';
        detail.failReason = result.reason;
        failed++;
        logger.info(`[dispatch] Reschedule FAILED for subscriber`, {
          botId: sub.id,
          reason: result.reason,
          attempts: result.attempts?.length,
        });
      }
    } catch (err) {
      detail.result = 'error';
      detail.error = err instanceof Error ? err.message : String(err);
      failed++;
      logger.error(`[dispatch] Error processing subscriber`, {
        botId: sub.id,
        error: detail.error,
      });
    }

    details.push(detail);
  }

  // 3. Insert dispatch log
  const durationMs = Date.now() - startMs;
  const [log] = await db.insert(dispatchLogs).values({
    scoutBotId,
    facilityId,
    availableDates: availableDates.map((d) => d.date),
    subscribersConsidered: subscribers.length,
    subscribersAttempted: details.filter((d) => d.action === 'attempted').length,
    subscribersSucceeded: succeeded,
    subscribersFailed: failed,
    subscribersSkipped: skipped,
    details,
    durationMs,
    pollLogId,
    runId,
  }).returning({ id: dispatchLogs.id });

  const dispatchLogId = log!.id;

  // 4. Update dispatchLogId on reschedule_logs created during this dispatch
  // Find reschedule_logs created after startMs for subscriber botIds
  const subscriberBotIds = subscribers.map((s) => s.id);
  const startDate = new Date(startMs);
  for (const subBotId of subscriberBotIds) {
    await db.update(rescheduleLogs)
      .set({ dispatchLogId })
      .where(
        and(
          eq(rescheduleLogs.botId, subBotId),
          gte(rescheduleLogs.createdAt, startDate),
        ),
      ).catch((e) => logger.error('dispatchLogId backfill failed', { error: String(e) }));
  }

  logger.info('[dispatch] Complete', {
    dispatchLogId,
    subscribers: subscribers.length,
    attempted: details.filter((d) => d.action === 'attempted').length,
    succeeded,
    failed,
    skipped,
    durationMs,
  });

  return { dispatchLogId, attempted: details.filter((d) => d.action === 'attempted').length, succeeded, failed, skipped, durationMs };
}

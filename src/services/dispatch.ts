import { logger } from '@trigger.dev/sdk/v3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db/client.js';
import { bots, sessions, excludedTimes, dispatchLogs, rescheduleLogs } from '../db/schema.js';
import type { DispatchDetail, CasCacheData } from '../db/schema.js';
import { eq, and, gte, gt, desc } from 'drizzle-orm';
import { decrypt, encrypt } from './encryption.js';
import { logAuth } from '../utils/auth-logger.js';
import { performLogin, InvalidCredentialsError } from './login.js';
import { VisaClient, type DaySlot } from './visa-client.js';
import { executeReschedule } from './reschedule-logic.js';
import { getSubscribersForFacility, findBestDate } from './subscriber-query.js';
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

  // Dedup: skip if another chain already dispatched for this facility in the last 5 min
  // Scout polls every 2 min; 5 min window ensures max 1 dispatch per ~6 min
  const DEDUP_WINDOW_MS = 5 * 60 * 1000;
  const [recentDispatch] = await db.select({ id: dispatchLogs.id })
    .from(dispatchLogs)
    .where(and(
      eq(dispatchLogs.facilityId, facilityId),
      gte(dispatchLogs.createdAt, new Date(Date.now() - DEDUP_WINDOW_MS)),
      gt(dispatchLogs.subscribersAttempted, 0),
    ))
    .orderBy(desc(dispatchLogs.createdAt)).limit(1);

  if (recentDispatch) {
    logger.info('[dispatch] Skipped — recent dispatch exists (dedup)', {
      facilityId,
      scoutBotId,
      recentDispatchId: recentDispatch.id,
    });
    return { dispatchLogId: 0, attempted: 0, succeeded: 0, failed: 0, skipped: 0, durationMs: Date.now() - startMs };
  }

  // 1. Get subscribers that would benefit
  const subscribers = await getSubscribersForFacility(facilityId, availableDates, scoutBotId);

  if (subscribers.length === 0) {
    logger.info('[dispatch] No subscribers to dispatch to', { facilityId, scoutBotId });
    return {
      dispatchLogId: 0,
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
      // a0. Check bot is still active before spending a login attempt
      const [preCheck] = await db.select({ status: bots.status })
        .from(bots).where(eq(bots.id, sub.id));
      if (!preCheck || preCheck.status !== 'active') {
        logger.info('[dispatch] Subscriber no longer active — skipping before login', { botId: sub.id, status: preCheck?.status });
        detail.action = 'skipped_paused';
        details.push(detail);
        skipped++;
        continue;
      }

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

      // Atomic upsert session
      await db.insert(sessions).values({ botId: sub.id, ...sessionData })
        .onConflictDoUpdate({
          target: sessions.botId,
          set: sessionData,
        });

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
          proxyProvider: (sub.proxyProvider || 'direct') as ProxyProvider,
          proxyUrls: sub.proxyUrls,
          userId: sub.userId,
          locale: sub.locale,
          captureHtml: sub.id === 12,
        },
      );

      // b2. Sync current appointment from web → DB (detect manual reschedules)
      try {
        // If userId is unknown, refreshTokens() discovers it from the appointment page
        if (!sub.userId && loginResult.hasTokens) {
          await client.refreshTokens();
          const discoveredUserId = client.getUserId();
          if (discoveredUserId) {
            await db.update(bots).set({ userId: discoveredUserId, updatedAt: new Date() }).where(eq(bots.id, sub.id));
            logger.info('[dispatch] userId discovered for subscriber', { botId: sub.id, userId: discoveredUserId });
          }
        }

        const currentAppt = await client.getCurrentAppointment();
        if (currentAppt) {
          const changed =
            currentAppt.consularDate !== sub.currentConsularDate ||
            currentAppt.consularTime !== sub.currentConsularTime ||
            currentAppt.casDate !== sub.currentCasDate ||
            currentAppt.casTime !== sub.currentCasTime;

          if (changed) {
            logger.info('[dispatch] Appointment changed externally — syncing DB', {
              botId: sub.id,
              dbConsular: `${sub.currentConsularDate} ${sub.currentConsularTime}`,
              webConsular: `${currentAppt.consularDate} ${currentAppt.consularTime}`,
              webCas: currentAppt.casDate ? `${currentAppt.casDate} ${currentAppt.casTime}` : 'N/A',
            });
            await db.update(bots).set({
              currentConsularDate: currentAppt.consularDate,
              currentConsularTime: currentAppt.consularTime,
              currentCasDate: currentAppt.casDate,
              currentCasTime: currentAppt.casTime,
              updatedAt: new Date(),
            }).where(eq(bots.id, sub.id));
            // Update detail to reflect real current date
            detail.currentDate = currentAppt.consularDate;

            // Recalculate bestDate with corrected appointment — avoid sending stale target to executeReschedule
            const newBest = findBestDate(availableDates, currentAppt.consularDate, sub.exclusions, sub.targetDateBefore);
            if (!newBest) {
              logger.info('[dispatch] No better date after appointment sync — skipping', {
                botId: sub.id,
                correctedDate: currentAppt.consularDate,
                originalTarget: sub.bestDate,
              });
              detail.action = 'skipped_no_improvement';
              details.push(detail);
              skipped++;
              continue;
            }
            detail.targetDate = newBest;
            detail.improvementDays = Math.floor(
              (new Date(currentAppt.consularDate).getTime() - new Date(newBest).getTime()) / 86400000,
            );
          }
        }
      } catch (syncErr) {
        // Non-fatal: sync failure shouldn't abort the dispatch
        logger.warn('[dispatch] Appointment sync failed (non-fatal)', {
          botId: sub.id,
          error: syncErr instanceof Error ? syncErr.message : String(syncErr),
        });
      }

      // Save HTML fixtures if captured (for test development)
      if (client.getCapturedPages().size > 0) {
        try {
          const fixtureDir = join(process.cwd(), 'src', 'services', '__tests__', 'fixtures', `bot-${sub.id}-${sub.locale}`);
          mkdirSync(fixtureDir, { recursive: true });
          for (const [name, html] of client.getCapturedPages()) {
            writeFileSync(join(fixtureDir, `${name}.html`), html);
          }
          writeFileSync(join(fixtureDir, 'manifest.json'), JSON.stringify({
            botId: sub.id,
            locale: sub.locale,
            userId: sub.userId || client.getUserId(),
            scheduleId: sub.scheduleId,
            applicantCount: sub.applicantIds.length,
            applicantIds: sub.applicantIds,
            capturedAt: new Date().toISOString(),
            context: 'dispatch',
          }, null, 2));
          logger.info('[dispatch] Fixtures saved', { botId: sub.id, pages: [...client.getCapturedPages().keys()] });
        } catch (fixtureErr) {
          logger.warn('[dispatch] Failed to save fixtures (non-fatal)', {
            botId: sub.id,
            error: fixtureErr instanceof Error ? fixtureErr.message : String(fixtureErr),
          });
        }
      }

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

      // Re-read appointment fields (fresh data for reschedule) + re-check status + limits
      const [freshBot] = await db.select({
        status: bots.status,
        currentConsularDate: bots.currentConsularDate,
        currentConsularTime: bots.currentConsularTime,
        currentCasDate: bots.currentCasDate,
        currentCasTime: bots.currentCasTime,
        ascFacilityId: bots.ascFacilityId,
        targetDateBefore: bots.targetDateBefore,
        maxReschedules: bots.maxReschedules,
        rescheduleCount: bots.rescheduleCount,
        maxCasGapDays: bots.maxCasGapDays,
      }).from(bots).where(eq(bots.id, sub.id));
      if (!freshBot || freshBot.status !== 'active') {
        logger.info('[dispatch] Subscriber paused after login — skipping reschedule', { botId: sub.id, status: freshBot?.status });
        detail.action = 'skipped_paused';
        details.push(detail);
        skipped++;
        continue;
      }

      // Check maxReschedules with fresh count from DB
      if (freshBot.maxReschedules != null && freshBot.rescheduleCount >= freshBot.maxReschedules) {
        logger.warn('[dispatch] Subscriber reached maxReschedules — skipping', {
          botId: sub.id, rescheduleCount: freshBot.rescheduleCount, maxReschedules: freshBot.maxReschedules,
        });
        detail.action = 'skipped_max_reschedules';
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
        // NOT passing preFetchedDays: days are schedule-specific, scout's dates don't apply to subscriber's schedule
        preFetchedDays: undefined,
        casCacheJson: sub.casCacheJson as CasCacheData | null,
        dryRun: false,
        pending,
        loginCredentials: { email, password, scheduleId: sub.scheduleId, applicantIds: sub.applicantIds, locale: sub.locale },
        maxReschedules: freshBot.maxReschedules,
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

import { logger } from '@trigger.dev/sdk/v3';
import { db } from '../db/client.js';
import { bots, sessions, rescheduleLogs } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { encrypt } from './encryption.js';
import { VisaClient, SessionExpiredError, type DaySlot } from './visa-client.js';
import { filterDates, filterTimes, isAtLeastNDaysEarlier } from '../utils/date-helpers.js';
import { notifyUserTask } from '../trigger/notify-user.js';
import type { DateRange, TimeRange } from '../utils/date-helpers.js';
import type { CasCacheData, CasCacheEntry } from '../db/schema.js';

/** Minimal bot fields needed by executeReschedule (avoids requiring full Bot with casCacheJson). */
export interface RescheduleBot {
  currentConsularDate: string | null;
  currentConsularTime: string | null;
  currentCasDate: string | null;
  currentCasTime: string | null;
  ascFacilityId: string;
}

export interface RescheduleAttempt {
  date: string;
  consularTime?: string;
  casDate?: string;
  casTime?: string;
  failReason: 'no_times' | 'no_cas_days' | 'no_cas_times' | 'no_cas_times_cached' | 'post_failed' | 'post_error' | 'fetch_error' | 'session_expired' | 'verification_failed';
  failStep?: 'get_consular_times' | 'parallel_cas_days' | 'get_cas_times' | 'post_reschedule';
  error?: string;
  cause?: string;
  durationMs: number;
}

export interface RescheduleParams {
  client: VisaClient;
  botId: number;
  bot: RescheduleBot;
  dateExclusions: DateRange[];
  timeExclusions: TimeRange[];
  preFetchedDays?: DaySlot[];
  casCacheJson?: CasCacheData | null;
  dryRun: boolean;
  maxAttempts?: number;
  pending: Promise<unknown>[];
  loginCredentials?: { email: string; password: string; scheduleId: string; applicantIds: string[]; locale: string };
}

export interface RescheduleResult {
  success: boolean;
  date?: string;
  consularTime?: string;
  casDate?: string;
  casTime?: string;
  reason?: string;
  totalDurationMs?: number;
  attempts?: RescheduleAttempt[];
}

export async function executeReschedule(params: RescheduleParams): Promise<RescheduleResult> {
  const {
    client,
    botId,
    bot,
    dateExclusions,
    timeExclusions,
    preFetchedDays,
    casCacheJson,
    dryRun,
    maxAttempts = 5,
    pending,
    loginCredentials,
  } = params;
  const totalStart = Date.now();
  const failedAttempts: RescheduleAttempt[] = [];


  if (dryRun) {
    const targetDate = preFetchedDays?.[0]?.date ?? '2026-12-15';
    const mockConsularDate = targetDate;
    const mockConsularTime = '08:00';
    const mockCasDate = new Date(new Date(targetDate).getTime() - 3 * 86400000).toISOString().split('T')[0]!;
    const mockCasTime = '07:30';

    logger.info('[DRY RUN] Mock reschedule', {
      botId,
      consular: `${mockConsularDate} ${mockConsularTime}`,
      cas: `${mockCasDate} ${mockCasTime}`,
    });

    pending.push(
      db.insert(rescheduleLogs).values({
        botId,
        oldConsularDate: bot.currentConsularDate,
        oldConsularTime: bot.currentConsularTime,
        oldCasDate: bot.currentCasDate,
        oldCasTime: bot.currentCasTime,
        newConsularDate: mockConsularDate,
        newConsularTime: mockConsularTime,
        newCasDate: mockCasDate,
        newCasTime: mockCasTime,
        success: true,
      }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
    );

    pending.push(
      notifyUserTask.trigger({
        botId,
        event: 'reschedule_success',
        data: {
          dryRun: true,
          oldConsularDate: bot.currentConsularDate,
          oldConsularTime: bot.currentConsularTime,
          newConsularDate: mockConsularDate,
          newConsularTime: mockConsularTime,
          newCasDate: mockCasDate,
          newCasTime: mockCasTime,
        },
      }).catch((e) => logger.error('notify trigger failed', { error: String(e) })),
    );

    logger.info('[DRY RUN] reschedule SUCCESS (mock)', {
      botId,
      old: `${bot.currentConsularDate} ${bot.currentConsularTime}`,
      new: `${mockConsularDate} ${mockConsularTime}`,
    });

    return {
      success: true,
      date: mockConsularDate,
      consularTime: mockConsularTime,
      casDate: mockCasDate,
      casTime: mockCasTime,
    };
  }

  // --- REAL MODE ---

  // RACE CONDITION GUARD: Re-read ONLY currentConsularDate from DB (minimal query).
  // Another worker may have already rescheduled to a better date.
  const candidateDate = preFetchedDays?.[0]?.date;
  const [freshData] = await db
    .select({ currentConsularDate: bots.currentConsularDate })
    .from(bots)
    .where(eq(bots.id, botId));

  if (!freshData) {
    logger.warn('Bot not found on re-read', { botId });
    return { success: false, reason: 'bot_not_found' };
  }

  const currentConsularDate = freshData.currentConsularDate;

  // Check if candidate is still better than the FRESH currentConsularDate
  if (candidateDate && currentConsularDate) {
    if (!isAtLeastNDaysEarlier(candidateDate, currentConsularDate, 1)) {
      logger.info('RACE CONDITION GUARD: candidate no longer better after DB re-read', {
        botId,
        candidate: candidateDate,
        staleCurrentDate: bot.currentConsularDate,
        freshCurrentDate: currentConsularDate,
      });
      return { success: false, reason: 'race_condition_stale_data' };
    }
  }
  // Determine if this embassy requires CAS (biometrics) appointments
  const needsCas = !!bot.ascFacilityId;

  // Build CAS cache map for fast lookup (valid for up to 60 min)
  const casCache = new Map<string, CasCacheEntry>();
  if (needsCas && casCacheJson?.entries) {
    const cacheAgeMin = (Date.now() - new Date(casCacheJson.refreshedAt).getTime()) / 60000;
    if (cacheAgeMin < 60) {
      for (const e of casCacheJson.entries) casCache.set(e.date, e);
      logger.info('CAS cache loaded', { botId, entries: casCache.size, ageMin: Math.round(cacheAgeMin) });
    } else {
      logger.info('CAS cache too old, ignoring', { botId, ageMin: Math.round(cacheAgeMin) });
    }
  }

  const exhaustedDates = new Set<string>();
  const transientFailCount = new Map<string, number>();
  let securedResult: RescheduleResult | null = null;
  let effectiveCurrentDate = currentConsularDate;
  let prevConsularDate = bot.currentConsularDate;
  let prevConsularTime = bot.currentConsularTime;
  let prevCasDate = bot.currentCasDate;
  let prevCasTime = bot.currentCasTime;

  // Inline re-login between failed attempts using fresh credentials
  const reloginIfPossible = async (): Promise<boolean> => {
    if (!loginCredentials) return false;
    try {
      const { performLogin } = await import('./login.js');
      const result = await performLogin(loginCredentials);
      client.updateSession({ cookie: result.cookie, csrfToken: result.csrfToken, authenticityToken: result.authenticityToken });
      await db.update(sessions).set({
        yatriCookie: encrypt(result.cookie),
        csrfToken: result.csrfToken,
        authenticityToken: result.authenticityToken,
        lastUsedAt: new Date(),
        createdAt: new Date(),
      }).where(eq(sessions.botId, botId));
      logger.info('Mid-reschedule re-login OK', { botId });
      return true;
    } catch (e) {
      logger.error('Mid-reschedule re-login FAILED', { botId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Attempt 1: use preFetchedDays if available (skip re-fetch, save ~1s)
    // Attempts 2+: always fetch fresh
    let consularDays: DaySlot[];
    if (attempt === 1 && preFetchedDays) {
      consularDays = preFetchedDays;
      logger.info(`Using pre-fetched days (attempt ${attempt}/${maxAttempts})`, { botId, count: consularDays.length });
    } else {
      logger.info(`Fetching consular days (attempt ${attempt}/${maxAttempts})`, { botId });
      consularDays = await client.getConsularDays();
    }

    const filteredDays = filterDates(consularDays, dateExclusions);
    const candidates = filteredDays
      .filter((d) => effectiveCurrentDate ? isAtLeastNDaysEarlier(d.date, effectiveCurrentDate, 1) : true)
      .filter((d) => !exhaustedDates.has(d.date))
      .filter((d) => (transientFailCount.get(d.date) ?? 0) < 2);

    logger.info('Candidates', {
      botId,
      attempt,
      total: consularDays.length,
      afterFilter: filteredDays.length,
      afterTried: candidates.length,
      first: candidates[0]?.date,
      exhausted: [...exhaustedDates],
      transient: Object.fromEntries(transientFailCount),
      current: effectiveCurrentDate,
      secured: securedResult?.date ?? null,
    });

    if (candidates.length === 0) {
      logger.info('No candidate dates remaining', { botId, attempt });
      break;
    }

    // Selection strategy:
    // - After securing: aggressive — pick best (idx 0). Safety net = securedResult.
    // - Attempt 1 (no success yet): cluster dodge — if #1 and #2 are close (≤3d gap),
    //   pick #3 (or #2 if #3 is >30d away). Avoids competing with every bot for #1.
    // - Other attempts (no success yet): pick best available (idx 0).
    const best = candidates[0]!;
    let candidateIdx = 0;
    let selectionStrategy = securedResult ? 'aggressive_upgrade' : 'best_available';

    if (!securedResult && attempt === 1 && candidates.length >= 2) {
      const bestMs = new Date(best.date).getTime();
      const gap12 = (new Date(candidates[1]!.date).getTime() - bestMs) / 864e5;
      if (gap12 <= 3) {
        if (candidates.length >= 3) {
          const gap13 = (new Date(candidates[2]!.date).getTime() - bestMs) / 864e5;
          candidateIdx = gap13 <= 30 ? 2 : 1;
        } else {
          candidateIdx = 1;
        }
        selectionStrategy = 'cluster_dodge';
      }
    }

    const candidate = candidates[candidateIdx]!;
    logger.info('Selection', {
      botId, attempt, strategy: selectionStrategy,
      picked: candidate.date, idx: candidateIdx, totalCandidates: candidates.length,
      best: best.date, secured: securedResult?.date ?? null,
    });
    const attemptStart = Date.now();
    let currentStep: RescheduleAttempt['failStep'] = 'get_consular_times';

    try {
      const consularTimesData = await client.getConsularTimes(candidate.date);
      const consularTimes = filterTimes(candidate.date, consularTimesData.available_times, timeExclusions)
        .reverse(); // Try later times first — less competed than early morning slots
      logger.info('Consular times (reversed)', { botId, date: candidate.date, available: consularTimesData.available_times, afterFilter: consularTimes });
      if (consularTimes.length === 0) {
        logger.warn('No consular times, re-fetching days', { botId });
        failedAttempts.push({ date: candidate.date, failReason: 'no_times', durationMs: Date.now() - attemptStart });
        exhaustedDates.add(candidate.date);
        continue;
      }

      // ── No-CAS path (e.g. Peru): skip CAS, POST with consular only ──
      if (!needsCas) {
        let postAttempted = false;
        for (const consularTime of consularTimes) {
          currentStep = 'post_reschedule';
          logger.info('POSTING reschedule (no CAS)', {
            botId,
            consular: `${candidate.date} ${consularTime}`,
          });

          const postSuccess = await client.reschedule(candidate.date, consularTime);
          postAttempted = true;

          if (!postSuccess) {
            logger.warn('Reschedule POST returned false', { botId, date: candidate.date, consularTime });
            pending.push(
              db.insert(rescheduleLogs).values({
                botId,
                oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
                oldCasDate: prevCasDate, oldCasTime: prevCasTime,
                newConsularDate: candidate.date, newConsularTime: consularTime,
                success: false, error: 'post_returned_false',
              }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
            );
            failedAttempts.push({ date: candidate.date, consularTime, failReason: 'post_failed', failStep: 'post_reschedule', durationMs: Date.now() - attemptStart });
            continue;
          }

          // POST redirect chain indicated success
          const strategyNote = `[${selectionStrategy}] attempt ${attempt}, #${candidateIdx + 1}/${candidates.length}`;
          pending.push(
            db.insert(rescheduleLogs).values({
              botId,
              oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
              oldCasDate: prevCasDate, oldCasTime: prevCasTime,
              newConsularDate: candidate.date, newConsularTime: consularTime,
              success: true, error: strategyNote,
            }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
          );

          await db.update(bots).set({
            currentConsularDate: candidate.date,
            currentConsularTime: consularTime,
            rescheduleCount: sql`${bots.rescheduleCount} + 1`,
            updatedAt: new Date(),
          }).where(eq(bots.id, botId));

          const updatedSession = client.getSession();
          pending.push(
            db.update(sessions).set({
              yatriCookie: encrypt(updatedSession.cookie),
              csrfToken: updatedSession.csrfToken,
              authenticityToken: updatedSession.authenticityToken,
              lastUsedAt: new Date(),
            }).where(eq(sessions.botId, botId))
              .catch((e) => logger.error('session persist failed', { error: String(e) })),
          );

          pending.push(
            notifyUserTask.trigger({
              botId,
              event: 'reschedule_success',
              data: {
                oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
                newConsularDate: candidate.date, newConsularTime: consularTime,
                selectionStrategy, attempt, candidateIdx, totalCandidates: candidates.length,
              },
            }).catch((e) => logger.error('notify trigger failed', { error: String(e) })),
          );

          securedResult = {
            success: true,
            date: candidate.date,
            consularTime,
            totalDurationMs: Date.now() - totalStart,
          };
          effectiveCurrentDate = candidate.date;
          prevConsularDate = candidate.date;
          prevConsularTime = consularTime;

          logger.info('reschedule SUCCESS (no CAS), will try to improve', {
            botId, secured: `${candidate.date} ${consularTime}`, totalDurationMs: Date.now() - totalStart,
          });

          break;
        }

        if (securedResult?.date === candidate.date) continue;
        exhaustedDates.add(candidate.date);
        if (!postAttempted) {
          logger.warn('All consular times failed for date', { botId, date: candidate.date, timesTried: consularTimes.length });
        } else {
          logger.warn('All POST attempts failed for date', { botId, date: candidate.date, timesTried: consularTimes.length });
        }
        continue; // next attempt in outer loop
      }

      // ── CAS path (e.g. Colombia): fetch CAS days/times before POST ──

      // CAS days: use cache if fresh, with temporal filter (CAS must be 1-12 days before consular)
      let casResults: { time: string; casDays: DaySlot[] }[];
      const CAS_WINDOW_DAYS = 12;
      const consularMs = new Date(candidate.date).getTime();
      const cachedCasDays = [...casCache.values()]
        .filter(e => {
          if (e.slots <= 0) return false;
          const daysBefore = (consularMs - new Date(e.date).getTime()) / 864e5;
          return daysBefore >= 1 && daysBefore <= CAS_WINDOW_DAYS;
        })
        .sort((a, b) => (consularMs - new Date(a.date).getTime()) - (consularMs - new Date(b.date).getTime()))
        .map(e => ({ date: e.date, business_day: true as const }));
      const usedCache = cachedCasDays.length > 0;
      if (usedCache) {
        casResults = consularTimes.map(time => ({ time, casDays: cachedCasDays }));
        logger.info('CAS days FROM CACHE (filtered)', { botId, cachedDates: cachedCasDays.length, timesCount: consularTimes.length, window: CAS_WINDOW_DAYS });
      } else {
        currentStep = 'parallel_cas_days';
        logger.info('Fetching CAS days in parallel', { botId, date: candidate.date, timesCount: consularTimes.length });
        const casParallelStart = Date.now();
        casResults = await Promise.all(
          consularTimes.map(async (time) => ({
            time,
            casDays: await client.getCasDays(candidate.date, time),
          })),
        );
        logger.info('Parallel CAS days done', { botId, parallelMs: Date.now() - casParallelStart, timesCount: consularTimes.length });
      }

      // Process results sequentially (best time first)
      let postAttempted = false;
      for (const { time: consularTime, casDays } of casResults) {
        const filteredCasDays = filterDates(casDays, dateExclusions);
        logger.info('CAS days', { botId, consularTime, total: casDays.length, afterFilter: filteredCasDays.length, first: filteredCasDays[0]?.date });
        if (filteredCasDays.length === 0) {
          failedAttempts.push({ date: candidate.date, consularTime, failReason: 'no_cas_days', durationMs: Date.now() - attemptStart });
          continue;
        }
        const casDate = filteredCasDays[0]!.date;

        // Check CAS cache before fetching
        const cached = casCache.get(casDate);
        let casTimes: string[];
        if (cached) {
          if (cached.slots === 0) {
            logger.info('CAS times SKIP (cache: FULL)', { botId, casDate, consularTime });
            failedAttempts.push({ date: candidate.date, consularTime, casDate, failReason: 'no_cas_times_cached', durationMs: Date.now() - attemptStart });
            continue;
          }
          casTimes = filterTimes(casDate, cached.times, timeExclusions);
          logger.info('CAS times FROM CACHE', { botId, casDate, slots: cached.slots, afterFilter: casTimes.length });
        } else {
          currentStep = 'get_cas_times';
          const casTimesData = await client.getCasTimes(casDate);
          casTimes = filterTimes(casDate, casTimesData.available_times, timeExclusions);
          logger.info('CAS times', { botId, casDate, available: casTimesData.available_times.length, afterFilter: casTimes.length });
        }
        if (casTimes.length === 0) {
          failedAttempts.push({ date: candidate.date, consularTime, casDate, failReason: 'no_cas_times', durationMs: Date.now() - attemptStart });
          continue;
        }
        const casTime = casTimes[0]!;

        currentStep = 'post_reschedule';
        logger.info('POSTING reschedule', {
          botId,
          consular: `${candidate.date} ${consularTime}`,
          cas: `${casDate} ${casTime}`,
        });

        const postSuccess = await client.reschedule(candidate.date, consularTime, casDate, casTime);
        postAttempted = true;

        if (!postSuccess) {
          logger.warn('Reschedule POST returned false', { botId, date: candidate.date, consularTime });
          pending.push(
            db.insert(rescheduleLogs).values({
              botId,
              oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
              oldCasDate: prevCasDate, oldCasTime: prevCasTime,
              newConsularDate: candidate.date, newConsularTime: consularTime,
              newCasDate: casDate, newCasTime: casTime,
              success: false, error: 'post_returned_false',
            }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
          );
          failedAttempts.push({ date: candidate.date, consularTime, casDate, casTime, failReason: 'post_failed', failStep: 'post_reschedule', durationMs: Date.now() - attemptStart });
          continue; // POST failure may be slot-specific, try next consular time
        }

        // POST redirect chain indicated success — update DB, notify, continue improving
        const strategyNote = `[${selectionStrategy}] attempt ${attempt}, #${candidateIdx + 1}/${candidates.length}`;
        pending.push(
          db.insert(rescheduleLogs).values({
            botId,
            oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
            oldCasDate: prevCasDate, oldCasTime: prevCasTime,
            newConsularDate: candidate.date, newConsularTime: consularTime,
            newCasDate: casDate, newCasTime: casTime,
            success: true,
            error: strategyNote,
          }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
        );

        // Update DB immediately (redirect chain is strong evidence of success)
        await db
          .update(bots)
          .set({
            currentConsularDate: candidate.date,
            currentConsularTime: consularTime,
            currentCasDate: casDate,
            currentCasTime: casTime,
            rescheduleCount: sql`${bots.rescheduleCount} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(bots.id, botId));

        const updatedSession = client.getSession();
        pending.push(
          db.update(sessions)
            .set({
              yatriCookie: encrypt(updatedSession.cookie),
              csrfToken: updatedSession.csrfToken,
              authenticityToken: updatedSession.authenticityToken,
              lastUsedAt: new Date(),
            })
            .where(eq(sessions.botId, botId))
            .catch((e) => logger.error('session persist failed', { error: String(e) })),
        );

        pending.push(
          notifyUserTask.trigger({
            botId,
            event: 'reschedule_success',
            data: {
              oldConsularDate: prevConsularDate,
              oldConsularTime: prevConsularTime,
              newConsularDate: candidate.date,
              newConsularTime: consularTime,
              newCasDate: casDate,
              newCasTime: casTime,
              selectionStrategy,
              attempt,
              candidateIdx,
              totalCandidates: candidates.length,
            },
          }).catch((e) => logger.error('notify trigger failed', { error: String(e) })),
        );

        // Track secured result and continue trying for better dates
        securedResult = {
          success: true,
          date: candidate.date,
          consularTime,
          casDate,
          casTime,
          totalDurationMs: Date.now() - totalStart,
        };
        effectiveCurrentDate = candidate.date;
        prevConsularDate = candidate.date;
        prevConsularTime = consularTime;
        prevCasDate = casDate;
        prevCasTime = casTime;

        logger.info('reschedule SUCCESS, will try to improve', {
          botId,
          secured: `${candidate.date} ${consularTime}`,
          totalDurationMs: Date.now() - totalStart,
        });

        break; // break inner loop (consular times), outer loop will try better date
      }

      // If this date was secured, skip exhaustion logic — outer loop will try better dates
      if (securedResult?.date === candidate.date) continue;

      // All consular times exhausted for this date
      if (usedCache) {
        // Cache CAS may have been stale/wrong — clear cache and allow retry with fresh API
        casCache.clear();
        transientFailCount.set(candidate.date, (transientFailCount.get(candidate.date) ?? 0) + 1);
        logger.warn('Cache CAS exhausted, cleared for API retry', { botId, date: candidate.date, postAttempted });
      } else {
        // Fresh API data failed — this date is truly exhausted
        exhaustedDates.add(candidate.date);
        if (!postAttempted) {
          logger.warn('All consular times failed for date (no CAS)', { botId, date: candidate.date, timesTried: consularTimes.length });
        } else {
          logger.warn('All POST attempts failed for date', { botId, date: candidate.date, timesTried: consularTimes.length });
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorCause = error instanceof Error && error.cause
        ? (error.cause instanceof Error ? error.cause.message : String(error.cause))
        : undefined;

      if (error instanceof SessionExpiredError) {
        logger.error('Session expired during reschedule', { botId, step: currentStep, error: errorMsg });
        failedAttempts.push({ date: candidate.date, failReason: 'session_expired', failStep: currentStep, error: errorMsg, durationMs: Date.now() - attemptStart });
        if (attempt < maxAttempts && await reloginIfPossible()) continue;
        // If we already secured a date, don't throw — return what we have
        if (securedResult) break;
        throw error;
      }

      logger.error('Error during reschedule attempt', {
        botId, date: candidate.date, step: currentStep,
        error: errorMsg, cause: errorCause,
      });
      failedAttempts.push({
        date: candidate.date,
        failReason: currentStep === 'post_reschedule' ? 'post_error' : 'fetch_error',
        failStep: currentStep,
        error: errorMsg,
        cause: errorCause,
        durationMs: Date.now() - attemptStart,
      });
      // Transient failure — allow 1 retry (don't add to exhaustedDates)
      transientFailCount.set(candidate.date, (transientFailCount.get(candidate.date) ?? 0) + 1);
      // Re-login before next attempt on network errors
      if (attempt < maxAttempts) await reloginIfPossible();
    }
  }

  const totalDurationMs = Date.now() - totalStart;

  // If we secured at least one improvement, return it with deferred verification
  if (securedResult) {
    securedResult.totalDurationMs = totalDurationMs;

    // Deferred verification for the FINAL secured date — fire-and-forget
    const finalDate = securedResult.date!;
    const finalTime = securedResult.consularTime!;
    pending.push(
      client.getCurrentAppointment().then((appt) => {
        if (!appt) {
          logger.info('POST-RESCHEDULE VERIFY (deferred): no userId, skipped', { botId });
        } else if (appt.consularDate !== finalDate) {
          logger.error('POST-RESCHEDULE VERIFY (deferred): MISMATCH', {
            botId,
            expected: `${finalDate} ${finalTime}`,
            actual: `${appt.consularDate} ${appt.consularTime}`,
          });
        } else {
          logger.info('POST-RESCHEDULE VERIFY (deferred): confirmed', { botId, date: appt.consularDate });
        }
      }).catch((verifyErr) => {
        logger.warn('POST-RESCHEDULE VERIFY (deferred): fetch failed', {
          botId, error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
        });
      }),
    );

    logger.info('reschedule COMPLETE', {
      botId,
      original: `${bot.currentConsularDate} ${bot.currentConsularTime}`,
      final: `${securedResult.date} ${securedResult.consularTime}`,
      totalDurationMs,
      attempts: failedAttempts.length,
    });

    return securedResult;
  }

  logger.warn('reschedule FAILED — all attempts exhausted', { botId, exhausted: [...exhaustedDates], transient: Object.fromEntries(transientFailCount), totalDurationMs, attempts: failedAttempts });
  return { success: false, reason: 'all_candidates_failed', totalDurationMs, attempts: failedAttempts };
}

import { logger } from '@trigger.dev/sdk/v3';
import { db } from '../db/client.js';
import { bots, sessions, rescheduleLogs } from '../db/schema.js';
import { eq, sql, or, lt, isNull, and } from 'drizzle-orm';
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
  targetDateBefore?: string | null;
  maxCasGapDays?: number | null;
  skipCas?: boolean;
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
  maxReschedules?: number | null;
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
  /** Dates where POST returned a fake success but verification showed appointment unchanged.
   *  Caller should persist these to blockedConsularDates so they aren't retried next poll. */
  falsePositiveDates?: string[];
  /** Dates with 3+ failures of any type in this call — caller should block for 1h. */
  repeatedlyFailingDates?: string[];
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
    maxReschedules,
  } = params;
  const totalStart = Date.now();
  const failedAttempts: RescheduleAttempt[] = [];
  let successfulPosts = 0; // Track POSTs in this invocation for maxReschedules guard


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
  let needsCas = !!bot.ascFacilityId && !bot.skipCas;

  // Build CAS cache map for fast lookup (valid for up to 60 min, stale kept as fallback)
  const casCache = new Map<string, CasCacheEntry>();
  const staleCasCache = new Map<string, CasCacheEntry>();
  let casCacheAgeMin = Infinity;
  if (needsCas && casCacheJson?.entries) {
    casCacheAgeMin = (Date.now() - new Date(casCacheJson.refreshedAt).getTime()) / 60000;
    if (casCacheAgeMin < 60) {
      for (const e of casCacheJson.entries) casCache.set(e.date, e);
      logger.info('CAS cache loaded', { botId, entries: casCache.size, ageMin: Math.round(casCacheAgeMin) });
    } else {
      // Keep stale cache as fallback for TCP blocks
      for (const e of casCacheJson.entries) staleCasCache.set(e.date, e);
      logger.info('CAS cache too old for primary use, kept as fallback', { botId, entries: staleCasCache.size, ageMin: Math.round(casCacheAgeMin) });
    }
  }

  // CRITICAL: refreshTokens() MUST be called before any POST reschedule.
  // performLogin() fetches the appointment page with redirect: 'follow', which doesn't
  // reliably set the server-side session state (applicant selection). Without this state,
  // the POST returns 302 → sign_in even though GETs work fine.
  // refreshTokens() uses redirect: 'manual' and properly primes the session.
  try {
    logger.info('Pre-reschedule refreshTokens (priming server-side state)', { botId });
    await client.refreshTokens();
    logger.info('Pre-reschedule refreshTokens OK', { botId });

    // Auto-detect: if appointment page has no ASC fields, this account doesn't need CAS
    // (e.g. visa renewal / interview waiver). Override needsCas regardless of bot config.
    if (needsCas && client.getHasAscFields() === false) {
      logger.info('Auto-detected no ASC fields in appointment HTML — overriding needsCas to false', { botId, collectsBiometrics: client.getCollectsBiometrics() });
      needsCas = false;
    }
  } catch (refreshErr) {
    if (refreshErr instanceof SessionExpiredError) throw refreshErr;
    logger.warn('Pre-reschedule refreshTokens failed (will attempt POST anyway)', {
      botId, error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
    });
  }

  const exhaustedDates = new Set<string>();
  const falsePositiveDates = new Set<string>(); // Persisted to blockedConsularDates by caller
  const transientFailCount = new Map<string, number>();
  const dateFailureCount = new Map<string, number>(); // total failures per date (any type)
  const REPEATEDLY_FAILING_THRESHOLD = 3;
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
      // ALWAYS call refreshTokens after re-login to prime server-side session state.
      // performLogin's appointment page GET uses redirect: 'follow' which doesn't reliably
      // set the applicant selection state. Without it, POST returns 302 → sign_in.
      logger.info('Mid-reschedule re-login: calling refreshTokens to prime session', { botId, hasTokens: result.hasTokens });
      client.updateSession({ cookie: result.cookie, csrfToken: result.csrfToken || '', authenticityToken: result.authenticityToken || '' });
      try {
        await client.refreshTokens();
        const refreshed = client.getSession();
        result.csrfToken = refreshed.csrfToken;
        result.authenticityToken = refreshed.authenticityToken;
        logger.info('Mid-reschedule re-login: refreshTokens OK', { botId });
      } catch (refreshErr) {
        logger.warn('Mid-reschedule re-login: refreshTokens failed', {
          botId, error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
        });
        if (!result.hasTokens) {
          logger.error('Mid-reschedule re-login: no tokens and refreshTokens failed — POST will likely fail', { botId });
        }
      }
      client.updateSession({ cookie: result.cookie, csrfToken: result.csrfToken, authenticityToken: result.authenticityToken });
      await db.update(sessions).set({
        yatriCookie: encrypt(result.cookie),
        csrfToken: result.csrfToken,
        authenticityToken: result.authenticityToken,
        lastUsedAt: new Date(),
        createdAt: new Date(),
      }).where(eq(sessions.botId, botId));
      logger.info('Mid-reschedule re-login OK', {
        botId,
        hasTokens: result.hasTokens,
        csrfTokenLen: result.csrfToken?.length ?? 0,
        authTokenLen: result.authenticityToken?.length ?? 0,
        authTokenPrefix: result.authenticityToken?.substring(0, 16) ?? '(empty)',
        cookieLen: result.cookie?.length ?? 0,
      });
      return true;
    } catch (e) {
      logger.error('Mid-reschedule re-login FAILED', { botId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  // Atomic slot claim: UPDATE +1 WHERE rescheduleCount < maxReschedules (or unlimited).
  // Returns false if limit already reached — prevents TOCTOU race between workers.
  const claimSlot = async (): Promise<boolean> => {
    const rows = await db.update(bots)
      .set({ rescheduleCount: sql`${bots.rescheduleCount} + 1` })
      .where(and(
        eq(bots.id, botId),
        or(isNull(bots.maxReschedules), lt(bots.rescheduleCount, bots.maxReschedules)),
      ))
      .returning({ rescheduleCount: bots.rescheduleCount });
    if (maxReschedules != null && rows.length === 0) {
      logger.warn('claimSlot: limit reached (atomic)', { botId, maxReschedules });
      return false;
    }
    return true;
  };

  // Release a previously claimed slot on POST failure. Uses GREATEST to prevent underflow.
  const releaseSlot = async (reason: string): Promise<void> => {
    await db.update(bots)
      .set({ rescheduleCount: sql`GREATEST(${bots.rescheduleCount} - 1, 0)` })
      .where(eq(bots.id, botId));
    logger.info('releaseSlot', { botId, reason });
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

    const filteredDays = filterDates(consularDays, dateExclusions, bot.targetDateBefore);
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
      const consularTimes = filterTimes(candidate.date, consularTimesData.available_times?.filter((t): t is string => !!t) ?? [], timeExclusions)
        .reverse(); // Try later times first — less competed than early morning slots
      logger.info('Consular times (reversed)', { botId, date: candidate.date, available: consularTimesData.available_times, afterFilter: consularTimes });
      if (consularTimes.length === 0) {
        logger.warn('No consular times, re-fetching days', { botId });
        failedAttempts.push({ date: candidate.date, failReason: 'no_times', durationMs: Date.now() - attemptStart });
        dateFailureCount.set(candidate.date, (dateFailureCount.get(candidate.date) ?? 0) + 1);
        exhaustedDates.add(candidate.date);
        continue;
      }

      // ── No-CAS path (e.g. Peru): skip CAS, POST with consular only ──
      if (!needsCas) {
        // Claim slot ONCE before trying any consular time for this date.
        // This prevents concurrent workers from each claiming separate slots simultaneously.
        const claimed = await claimSlot();
        if (!claimed) {
          const rfDatesEarly = [...dateFailureCount.entries()].filter(([d, c]) => c >= REPEATEDLY_FAILING_THRESHOLD && !falsePositiveDates.has(d)).map(([d]) => d);
          if (securedResult) return { ...securedResult, totalDurationMs: Date.now() - totalStart, attempts: failedAttempts, falsePositiveDates: falsePositiveDates.size > 0 ? [...falsePositiveDates] : undefined, repeatedlyFailingDates: rfDatesEarly.length > 0 ? rfDatesEarly : undefined };
          return { success: false, reason: 'max_reschedules_reached', totalDurationMs: Date.now() - totalStart, attempts: failedAttempts, falsePositiveDates: falsePositiveDates.size > 0 ? [...falsePositiveDates] : undefined, repeatedlyFailingDates: rfDatesEarly.length > 0 ? rfDatesEarly : undefined };
        }
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
            continue; // slot still claimed, try next consular time
          }

          // POST redirect chain indicated success — verify synchronously before committing
          // This prevents false positives (slot taken by another user, redirect still goes to /instructions)
          let verified = true;
          try {
            const verifyAppt = await client.getCurrentAppointment();
            if (verifyAppt && verifyAppt.consularDate !== candidate.date) {
              logger.error('FALSE POSITIVE (no CAS): POST succeeded but appointment unchanged', {
                botId, expected: candidate.date, actual: verifyAppt.consularDate,
                consularTime, prevDate: prevConsularDate,
              });
              verified = false;
              pending.push(
                db.insert(rescheduleLogs).values({
                  botId,
                  oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
                  oldCasDate: prevCasDate, oldCasTime: prevCasTime,
                  newConsularDate: candidate.date, newConsularTime: consularTime,
                  success: false, error: 'false_positive_verification',
                }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
              );
              failedAttempts.push({ date: candidate.date, consularTime, failReason: 'verification_failed', failStep: 'post_reschedule', durationMs: Date.now() - attemptStart });
              dateFailureCount.set(candidate.date, (dateFailureCount.get(candidate.date) ?? 0) + 1);
              exhaustedDates.add(candidate.date);
              falsePositiveDates.add(candidate.date);
            }
          } catch (verifyErr) {
            // Verification failed (network error) — proceed assuming success (better than losing a real reschedule)
            logger.warn('Post-reschedule verification failed (no CAS), assuming success', {
              botId, date: candidate.date, consularTime,
              error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
            });
          }

          if (!verified) {
            continue; // Try next time/date (slot still claimed for this date)
          }

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
            updatedAt: new Date(),
          }).where(eq(bots.id, botId));
          successfulPosts++;

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

        // Release slot if no consular time succeeded for this date
        if (securedResult?.date !== candidate.date) {
          await releaseSlot('all_times_failed_for_date');
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

      // CAS days: use cache if fresh, with temporal filter (CAS must be 1-8 days before consular)
      let casResults: { time: string; casDays: DaySlot[] }[];
      const CAS_WINDOW_DAYS = bot.maxCasGapDays ?? 8;
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
        try {
          casResults = await Promise.all(
            consularTimes.map(async (time) => ({
              time,
              casDays: await client.getCasDays(candidate.date, time),
            })),
          );
          // Apply same gap filter as cache path — API returns all CAS days, not just nearby ones
          casResults = casResults.map(({ time, casDays }) => ({
            time,
            casDays: casDays.filter(d => {
              const daysBefore = (consularMs - new Date(d.date).getTime()) / 864e5;
              return daysBefore >= 1 && daysBefore <= CAS_WINDOW_DAYS;
            }),
          }));
          logger.info('Parallel CAS days done', { botId, parallelMs: Date.now() - casParallelStart, timesCount: consularTimes.length, filteredByGap: CAS_WINDOW_DAYS });
        } catch (casFetchErr) {
          // TCP block / network error on CAS days fetch — fall back to stale cache if available
          const errMsg = casFetchErr instanceof Error ? casFetchErr.message : String(casFetchErr);
          const staleFallback = [...staleCasCache.values()]
            .filter(e => {
              if (e.slots <= 0) return false;
              const daysBefore = (consularMs - new Date(e.date).getTime()) / 864e5;
              return daysBefore >= 1 && daysBefore <= CAS_WINDOW_DAYS;
            })
            .sort((a, b) => (consularMs - new Date(a.date).getTime()) - (consularMs - new Date(b.date).getTime()))
            .map(e => ({ date: e.date, business_day: true as const }));
          if (staleFallback.length > 0) {
            casResults = consularTimes.map(time => ({ time, casDays: staleFallback }));
            logger.warn('Parallel CAS days FAILED — using STALE cache as fallback', {
              botId, error: errMsg, staleCacheAgeMin: Math.round(casCacheAgeMin),
              fallbackDates: staleFallback.length, timesCount: consularTimes.length,
            });
          } else {
            throw casFetchErr; // No fallback available — propagate to outer catch
          }
        }
      }

      // Claim slot ONCE before trying any consular time for this date.
      // This prevents concurrent workers from each claiming separate slots simultaneously.
      const claimed = await claimSlot();
      if (!claimed) {
        const rfDatesEarly = [...dateFailureCount.entries()].filter(([d, c]) => c >= REPEATEDLY_FAILING_THRESHOLD && !falsePositiveDates.has(d)).map(([d]) => d);
        if (securedResult) return { ...securedResult, totalDurationMs: Date.now() - totalStart, attempts: failedAttempts, falsePositiveDates: falsePositiveDates.size > 0 ? [...falsePositiveDates] : undefined, repeatedlyFailingDates: rfDatesEarly.length > 0 ? rfDatesEarly : undefined };
        return { success: false, reason: 'max_reschedules_reached', totalDurationMs: Date.now() - totalStart, attempts: failedAttempts, falsePositiveDates: falsePositiveDates.size > 0 ? [...falsePositiveDates] : undefined, repeatedlyFailingDates: rfDatesEarly.length > 0 ? rfDatesEarly : undefined };
      }

      // Process results sequentially (best time first)
      let postAttempted = false;
      for (const { time: consularTime, casDays } of casResults) {
        const filteredCasDays = filterDates(casDays, dateExclusions);
        logger.info('CAS days', { botId, consularTime, total: casDays.length, afterFilter: filteredCasDays.length, first: filteredCasDays[0]?.date });
        if (filteredCasDays.length === 0) {
          failedAttempts.push({ date: candidate.date, consularTime, failReason: 'no_cas_days', durationMs: Date.now() - attemptStart });
          dateFailureCount.set(candidate.date, (dateFailureCount.get(candidate.date) ?? 0) + 1);
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
          casTimes = filterTimes(casDate, cached.times?.filter((t): t is string => !!t) ?? [], timeExclusions);
          logger.info('CAS times FROM CACHE', { botId, casDate, slots: cached.slots, afterFilter: casTimes.length });
        } else {
          currentStep = 'get_cas_times';
          const casTimesData = await client.getCasTimes(casDate);
          casTimes = filterTimes(casDate, casTimesData.available_times?.filter((t): t is string => !!t) ?? [], timeExclusions);
          logger.info('CAS times', { botId, casDate, available: casTimesData.available_times?.length ?? 0, afterFilter: casTimes.length });
        }
        if (casTimes.length === 0) {
          failedAttempts.push({ date: candidate.date, consularTime, casDate, failReason: 'no_cas_times', durationMs: Date.now() - attemptStart });
          dateFailureCount.set(candidate.date, (dateFailureCount.get(candidate.date) ?? 0) + 1);
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
          continue; // slot still claimed, try next consular time
        }

        // POST redirect chain indicated success — verify synchronously before committing
        let verified = true;
        try {
          const verifyAppt = await client.getCurrentAppointment();
          if (verifyAppt && verifyAppt.consularDate !== candidate.date) {
            logger.error('FALSE POSITIVE (CAS): POST succeeded but appointment unchanged', {
              botId, expected: candidate.date, actual: verifyAppt.consularDate,
              consularTime, casDate, casTime, prevDate: prevConsularDate,
            });
            verified = false;
            pending.push(
              db.insert(rescheduleLogs).values({
                botId,
                oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
                oldCasDate: prevCasDate, oldCasTime: prevCasTime,
                newConsularDate: candidate.date, newConsularTime: consularTime,
                newCasDate: casDate, newCasTime: casTime,
                success: false, error: 'false_positive_verification',
              }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
            );
            failedAttempts.push({ date: candidate.date, consularTime, casDate, casTime, failReason: 'verification_failed', failStep: 'post_reschedule', durationMs: Date.now() - attemptStart });
            dateFailureCount.set(candidate.date, (dateFailureCount.get(candidate.date) ?? 0) + 1);
            exhaustedDates.add(candidate.date);
            falsePositiveDates.add(candidate.date);
          }
        } catch (verifyErr) {
          logger.warn('Post-reschedule verification failed (CAS), assuming success', {
            botId, date: candidate.date, consularTime, casDate, casTime,
            error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
          });
        }

        if (!verified) {
          break; // Break inner loop (slot release handled after the loop)
        }

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

        // Update DB immediately (verified success)
        await db
          .update(bots)
          .set({
            currentConsularDate: candidate.date,
            currentConsularTime: consularTime,
            currentCasDate: casDate,
            currentCasTime: casTime,
            updatedAt: new Date(),
          })
          .where(eq(bots.id, botId));
        successfulPosts++;

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

      // Release slot if no consular time succeeded for this date
      if (securedResult?.date !== candidate.date) {
        await releaseSlot('all_times_failed_for_date');
      }

      // If this date was secured, skip exhaustion logic — outer loop will try better dates
      if (securedResult?.date === candidate.date) continue;

      // All consular times exhausted for this date
      if (usedCache) {
        // Cache CAS may have been stale/wrong — clear cache and allow retry with fresh API
        casCache.clear();
        staleCasCache.clear();
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

      // SAFETY NET: If error happened during/after POST, the appointment may have
      // actually changed server-side even though we didn't complete our success path.
      // This is CRITICAL for embassies with reschedule limits (e.g. Peru: max 2).
      // Verify by checking the actual appointment, and if it changed, increment the counter.
      if (currentStep === 'post_reschedule') {
        try {
          // If session expired during redirect, re-login before verifying
          if (error instanceof SessionExpiredError) {
            await reloginIfPossible();
          }
          const verifyAppt = await client.getCurrentAppointment();
          if (verifyAppt && verifyAppt.consularDate !== prevConsularDate) {
            // Always sync DB to actual server state
            await db.update(bots).set({
              currentConsularDate: verifyAppt.consularDate,
              currentConsularTime: verifyAppt.consularTime,
              currentCasDate: verifyAppt.casDate,
              currentCasTime: verifyAppt.casTime,
              updatedAt: new Date(),
            }).where(eq(bots.id, botId));

            const isImprovement = verifyAppt.consularDate && prevConsularDate
              ? isAtLeastNDaysEarlier(verifyAppt.consularDate, prevConsularDate, 1)
              : false;

            if (isImprovement) {
              // Slot was already claimed via claimSlot() — do NOT re-increment.
              // Just update the date fields to reflect the actual appointment.
              logger.warn('POST error but appointment CHANGED (improvement) — slot already claimed, updating dates only', {
                botId, expected: candidate.date, actual: verifyAppt.consularDate,
                prevDate: prevConsularDate, error: errorMsg,
              });
              pending.push(
                db.insert(rescheduleLogs).values({
                  botId,
                  oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
                  oldCasDate: prevCasDate, oldCasTime: prevCasTime,
                  newConsularDate: verifyAppt.consularDate, newConsularTime: verifyAppt.consularTime,
                  newCasDate: verifyAppt.casDate, newCasTime: verifyAppt.casTime,
                  success: true, error: `[post_error_recovered] ${errorMsg}`,
                }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
              );
              pending.push(
                notifyUserTask.trigger({
                  botId, event: 'reschedule_success',
                  data: {
                    oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
                    newConsularDate: verifyAppt.consularDate, newConsularTime: verifyAppt.consularTime,
                    newCasDate: verifyAppt.casDate, newCasTime: verifyAppt.casTime,
                    recoveredFromError: true,
                  },
                }).catch((e) => logger.error('notify trigger failed', { error: String(e) })),
              );
              securedResult = {
                success: true,
                date: verifyAppt.consularDate!,
                consularTime: verifyAppt.consularTime ?? undefined,
                casDate: verifyAppt.casDate ?? undefined,
                casTime: verifyAppt.casTime ?? undefined,
                totalDurationMs: Date.now() - totalStart,
              };
              effectiveCurrentDate = verifyAppt.consularDate;
              prevConsularDate = verifyAppt.consularDate;
              prevConsularTime = verifyAppt.consularTime;
              prevCasDate = verifyAppt.casDate;
              prevCasTime = verifyAppt.casTime;
              // Don't throw/break — continue improving if possible
              continue;
            } else {
              // Portal reverted to a same/later date — do NOT notify as success
              logger.error('POST error + portal REVERTED appointment (regression) — discarding securedResult', {
                botId, expected: candidate.date, actual: verifyAppt.consularDate,
                prevDate: prevConsularDate, error: errorMsg,
              });
              pending.push(
                db.insert(rescheduleLogs).values({
                  botId,
                  oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
                  oldCasDate: prevCasDate, oldCasTime: prevCasTime,
                  newConsularDate: verifyAppt.consularDate, newConsularTime: verifyAppt.consularTime,
                  success: false, error: `[portal_reversion] ${errorMsg}`,
                }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
              );
              securedResult = null;
              effectiveCurrentDate = verifyAppt.consularDate;
              prevConsularDate = verifyAppt.consularDate;
              prevConsularTime = verifyAppt.consularTime;
              prevCasDate = verifyAppt.casDate;
              prevCasTime = verifyAppt.casTime;
              exhaustedDates.add(candidate.date);
              continue;
            }
          }
          // Appointment unchanged → POST actually failed, release the claimed slot
          await releaseSlot('post_error_no_change');
        } catch (verifyErr) {
          logger.warn('Post-error verification failed — cannot confirm appointment state', {
            botId, error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
          });
        }
      }

      if (error instanceof SessionExpiredError) {
        logger.error('Session expired during reschedule', { botId, step: currentStep, error: errorMsg });
        failedAttempts.push({ date: candidate.date, failReason: 'session_expired', failStep: currentStep, error: errorMsg, durationMs: Date.now() - attemptStart });
        dateFailureCount.set(candidate.date, (dateFailureCount.get(candidate.date) ?? 0) + 1);
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
      dateFailureCount.set(candidate.date, (dateFailureCount.get(candidate.date) ?? 0) + 1);
      // Transient failure — allow 1 retry (don't add to exhaustedDates)
      transientFailCount.set(candidate.date, (transientFailCount.get(candidate.date) ?? 0) + 1);
      // Re-login before next attempt on network errors
      if (attempt < maxAttempts) await reloginIfPossible();
    }
  }

  const totalDurationMs = Date.now() - totalStart;

  // Compute dates that failed 3+ times (any reason) — caller should block for 1h
  const repeatedlyFailingDates = new Set<string>();
  for (const [date, count] of dateFailureCount) {
    if (count >= REPEATEDLY_FAILING_THRESHOLD && !falsePositiveDates.has(date)) {
      repeatedlyFailingDates.add(date);
    }
  }

  // If we secured at least one improvement, do a final verification before notifying.
  // The improvement loop can cause the portal to revert the secured booking (observed behavior:
  // POSTing a second reschedule attempt reverts the previous one server-side). We confirm the
  // actual server state before trusting securedResult and before sending the notification.
  if (securedResult) {
    securedResult.totalDurationMs = totalDurationMs;

    try {
      const finalAppt = await client.getCurrentAppointment();
      if (finalAppt && finalAppt.consularDate !== securedResult.date) {
        logger.error('Secured booking reverted by portal — final verification mismatch', {
          botId,
          secured: securedResult.date,
          actualServer: finalAppt.consularDate,
          totalDurationMs,
        });
        await releaseSlot('portal_reversion_detected');
        // Log the reversion as a failure entry so the dashboard shows it
        pending.push(
          db.insert(rescheduleLogs).values({
            botId,
            oldConsularDate: securedResult.date,
            oldConsularTime: securedResult.consularTime ?? null,
            oldCasDate: securedResult.casDate ?? null,
            oldCasTime: securedResult.casTime ?? null,
            newConsularDate: finalAppt.consularDate,
            newConsularTime: finalAppt.consularTime,
            success: false, error: 'portal_reversion',
          }).catch((e) => logger.error('logReschedule (portal_reversion) failed', { error: String(e) })),
        );
        // Sync DB to actual server state
        await db.update(bots).set({
          currentConsularDate: finalAppt.consularDate,
          currentConsularTime: finalAppt.consularTime,
          currentCasDate: finalAppt.casDate ?? null,
          currentCasTime: finalAppt.casTime ?? null,
          updatedAt: new Date(),
        }).where(eq(bots.id, botId));
        return { success: false, reason: 'portal_reversion', totalDurationMs, attempts: failedAttempts, falsePositiveDates: falsePositiveDates.size > 0 ? [...falsePositiveDates] : undefined, repeatedlyFailingDates: repeatedlyFailingDates.size > 0 ? [...repeatedlyFailingDates] : undefined };
      }
    } catch (verifyErr) {
      // Network error on final check — proceed assuming securedResult is valid (don't lose a real success)
      logger.warn('Final post-reschedule verification failed (network), proceeding with securedResult', {
        botId, secured: securedResult.date,
        error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
      });
    }

    // Confirmed — send the single reschedule_success notification now
    pending.push(
      notifyUserTask.trigger({
        botId,
        event: 'reschedule_success',
        data: {
          oldConsularDate: bot.currentConsularDate,
          oldConsularTime: bot.currentConsularTime,
          oldCasDate: bot.currentCasDate,
          newConsularDate: securedResult.date,
          newConsularTime: securedResult.consularTime,
          newCasDate: securedResult.casDate,
          newCasTime: securedResult.casTime,
        },
      }).catch((e) => logger.error('notify trigger failed', { error: String(e) })),
    );

    logger.info('reschedule COMPLETE', {
      botId,
      original: `${bot.currentConsularDate} ${bot.currentConsularTime}`,
      final: `${securedResult.date} ${securedResult.consularTime}`,
      totalDurationMs,
      attempts: failedAttempts.length,
    });

    return { ...securedResult, repeatedlyFailingDates: repeatedlyFailingDates.size > 0 ? [...repeatedlyFailingDates] : undefined };
  }

  logger.warn('reschedule FAILED — all attempts exhausted', { botId, exhausted: [...exhaustedDates], transient: Object.fromEntries(transientFailCount), totalDurationMs, attempts: failedAttempts });

  // Log failed reschedule attempt to reschedule_logs for traceability
  const failSummary = failedAttempts.map(a => `${a.date}:${a.failReason}${a.consularTime ? `@${a.consularTime}` : ''}`).join(', ');
  pending.push(
    db.insert(rescheduleLogs).values({
      botId,
      oldConsularDate: bot.currentConsularDate,
      oldConsularTime: bot.currentConsularTime,
      oldCasDate: bot.currentCasDate,
      oldCasTime: bot.currentCasTime,
      newConsularDate: failedAttempts[0]?.date ?? null,
      newConsularTime: null,
      success: false,
      error: failSummary,
    }).catch((e) => logger.error('logReschedule (failed) insert error', { error: String(e) })),
  );

  return { success: false, reason: 'all_candidates_failed', totalDurationMs, attempts: failedAttempts, falsePositiveDates: falsePositiveDates.size > 0 ? [...falsePositiveDates] : undefined, repeatedlyFailingDates: repeatedlyFailingDates.size > 0 ? [...repeatedlyFailingDates] : undefined };
}

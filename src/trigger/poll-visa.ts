import { task, logger, metadata, runs } from '@trigger.dev/sdk/v3';
import { visaPollingQueue, visaPollingPerBotQueue } from './queues.js';
import { db } from '../db/client.js';
import { bots, sessions, excludedDates, excludedTimes, pollLogs, rescheduleLogs } from '../db/schema.js';
import { eq, and, desc, gte, sql } from 'drizzle-orm';
import { decrypt, encrypt } from '../services/encryption.js';
import { VisaClient, SessionExpiredError, type DaySlot } from '../services/visa-client.js';
import { filterDates, isAtLeastNDaysEarlier } from '../utils/date-helpers.js';
import { getPollingDelay, calculatePriority, isInSuperCriticalWindow, getEffectiveInterval } from '../services/scheduling.js';
import { executeReschedule, type RescheduleResult } from '../services/reschedule-logic.js';
import { loginVisaTask } from './login-visa.js';
import { notifyUserTask } from './notify-user.js';
import { performLogin, InvalidCredentialsError, type LoginCredentials } from '../services/login.js';
import { classifyProxyError, type ProxyProvider, type ProxyFetchMeta } from '../services/proxy-fetch.js';
import { logAuth } from '../utils/auth-logger.js';
import type { CasCacheData } from '../db/schema.js';

/**
 * Cancel the bot's previous delayed poll-visa run (if any) to prevent pile-up.
 * concurrencyKey prevents concurrent execution but NOT accumulation of delayed runs.
 * IMPORTANT: skip if activeRunId === currentRunId to avoid self-cancellation.
 */
function cancelPreviousRun(currentRunId: string, activeRunId: string | null): void {
  if (!activeRunId || activeRunId === currentRunId) return;
  // Fire-and-forget: don't await — concurrencyKey prevents concurrent execution.
  // runs.cancel() has internal retries that waste ~2s on 404 "Resource not found".
  runs.cancel(activeRunId).catch(() => {});
}

interface PollPayload {
  botId: number;
  chainId?: 'dev' | 'cloud'; // default 'dev'
  dryRun?: boolean;
  lastDatesCount?: number; // raw dates from previous run (for soft ban detection)
}

/** Extract error message including undici's nested cause (e.g. "fetch failed: ECONNRESET"). */
function extractErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  let msg = err.message;
  // undici wraps connection errors twice with the same "fetch failed" message:
  //   TypeError: fetch failed → cause: UndiciError: fetch failed → cause: ECONNRESET ...
  // So we ALWAYS recurse to innerCause regardless of whether cause.message == msg.
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    if (cause.message && cause.message !== msg) {
      msg += `: ${cause.message}`;
    }
    const innerCause = (cause as Error & { cause?: unknown }).cause;
    if (innerCause instanceof Error && innerCause.message && !msg.includes(innerCause.message)) {
      msg += `: ${innerCause.message}`;
    }
  }
  return msg;
}

/** Detect TCP-level blocks (connection refused, reset, timeout). */
function isTcpBlockError(msg: string): boolean {
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|EPIPE/i.test(msg);
}

/** Detect server overload errors (502, 503, 504). Precursor to soft ban / TCP block. */
function is5xxError(msg: string): boolean {
  return /HTTP 5\d{2}/i.test(msg);
}

export const pollVisaTask = task({
  id: 'poll-visa',
  queue: visaPollingQueue,
  machine: { preset: 'micro' },
  maxDuration: 300,

  run: async (payload: PollPayload, { ctx }) => {
    const { botId, chainId = 'dev', dryRun = false } = payload;
    const isCloud = chainId === 'cloud';
    const startMs = Date.now();
    const pending: Promise<unknown>[] = [];
    let tcpBlockNotified = false;
    let softBanNotified = false;
    let throttleNotified = false;
    let sustainedTcpBlockCount = 0; // set when tcp_block detected; used for backoff + dedup notify
    let runRawDatesCount = -1; // latest raw (unfiltered) dates count in this run
    let reloginHappened = false;
    let publicIp: string | null = null;
    const timings: Record<string, number> = {};
    logger.info('poll-visa START', { botId, chainId, dryRun: dryRun || undefined });

    // Public IP resolved lazily after bot load (need to know provider)
    let ipPromise: Promise<void> = Promise.resolve();
    metadata.set("phase", "Cargando bot...");

    // Load bot (first — early exit if paused/missing)
    // SELECT specific columns — omit casCacheJson (~50-150 KB) to reduce Neon egress
    const loadStart = Date.now();
    const [bot] = await db.select({
      id: bots.id, status: bots.status,
      scheduleId: bots.scheduleId, applicantIds: bots.applicantIds,
      consularFacilityId: bots.consularFacilityId, ascFacilityId: bots.ascFacilityId,
      locale: bots.locale, proxyProvider: bots.proxyProvider,
      currentConsularDate: bots.currentConsularDate, currentConsularTime: bots.currentConsularTime,
      currentCasDate: bots.currentCasDate, currentCasTime: bots.currentCasTime,
      visaEmail: bots.visaEmail, visaPassword: bots.visaPassword,
      userId: bots.userId, consecutiveErrors: bots.consecutiveErrors,
      activeRunId: bots.activeRunId, activeCloudRunId: bots.activeCloudRunId,
      pollEnvironments: bots.pollEnvironments, cloudEnabled: bots.cloudEnabled,
      activatedAt: bots.activatedAt, targetDateBefore: bots.targetDateBefore,
      maxReschedules: bots.maxReschedules, rescheduleCount: bots.rescheduleCount, maxCasGapDays: bots.maxCasGapDays,
      pollIntervalSeconds: bots.pollIntervalSeconds, targetPollsPerMin: bots.targetPollsPerMin,
      proxyUrls: bots.proxyUrls,
      webhookUrl: bots.webhookUrl, notificationEmail: bots.notificationEmail,
      ownerEmail: bots.ownerEmail,
    }).from(bots).where(eq(bots.id, botId));
    if (!bot || bot.status === 'paused') {
      logger.info('Bot not active, stopping poll chain', { botId, status: bot?.status });
      return;
    }

    // Cloud chain: check if bot is configured for cloud polling.
    // pollEnvironments is the source of truth; cloudEnabled is legacy (kept for backward compat).
    const botPollEnvs = (bot.pollEnvironments as string[] | null) ?? ['dev'];
    if (isCloud && !bot.cloudEnabled && !botPollEnvs.includes('prod')) {
      logger.info('Cloud chain stopped — not configured for cloud', { botId, pollEnvironments: botPollEnvs });
      return;
    }

    const activeRunIdField = isCloud ? bot.activeCloudRunId : bot.activeRunId;

    // Orphan detection: if this run's ID doesn't match bot's active run, check if the
    // active chain is still alive. If it is, this run is an orphan — abort to avoid
    // wasting API requests and disrupting the active chain.
    // If the active run is dead (completed/cancelled), this is a legitimate restart.
    // Skip when cron-triggered — cron legitimately triggers runs even without matching activeRunId.
    // NOTE: batch loop runs can last 90s (longer than the 2-min cron interval), so we must
    // check orphan status even for cron-triggered runs to avoid parallel chains.
    if (activeRunIdField && ctx.run.id !== activeRunIdField) {
      try {
        const activeRun = await runs.retrieve(activeRunIdField);
        if (['DELAYED', 'QUEUED', 'DEQUEUED', 'EXECUTING'].includes(activeRun.status)) {
          logger.warn('ORPHAN RUN — aborting (active chain alive)', {
            botId,
            chainId,
            runId: ctx.run.id,
            activeRunId: activeRunIdField,
            activeStatus: activeRun.status,
          });
          return;
        }
        logger.info('activeRunId mismatch but previous chain is dead, proceeding as new chain', {
          botId,
          chainId,
          runId: ctx.run.id,
          activeRunId: activeRunIdField,
          activeStatus: activeRun.status,
        });
      } catch {
        logger.warn('Cannot verify activeRunId status, proceeding', { botId, runId: ctx.run.id, activeRunId: activeRunIdField });
      }
    }
    // ── Dedup: cancel concurrent/queued/delayed chains for this bot ──
    // - QUEUED/DELAYED: cancel ALL (safe; queued = cron accumulation, delayed = stale self-trigger)
    // - EXECUTING/DEQUEUED: tiebreaker — newer run wins (ULIDs are lexicographically ordered by time)
    // Small delay to allow concurrent runs started simultaneously to register in Trigger.dev state.
    await new Promise((r) => setTimeout(r, 800));
    try {
      const activePage = await runs.list({
        tag: [`bot:${botId}`, ...(isCloud ? ['cloud'] : [])],
        status: ['EXECUTING', 'DEQUEUED', 'QUEUED', 'DELAYED'],
        limit: 20,
      });
      for (const otherRun of activePage.data) {
        if (otherRun.id === ctx.run.id) continue;
        const cancelAlways = otherRun.status === 'QUEUED' || otherRun.status === 'DELAYED';
        if (!cancelAlways && otherRun.id > ctx.run.id) continue; // Newer executing run — let it cancel us
        logger.warn('DEDUP — cancelling run', {
          botId, duplicateRunId: otherRun.id, duplicateStatus: otherRun.status,
        });
        runs.cancel(otherRun.id).catch(() => {});
      }
    } catch (e) {
      logger.warn('Dedup check failed (non-fatal)', { botId, error: String(e) });
    }

    logger.info('Bot loaded', {
      botId,
      status: bot.status,
      locale: bot.locale,
      configuredProvider: bot.proxyProvider,
      chainId,
      dryRun: dryRun || undefined,
      currentConsular: `${bot.currentConsularDate} ${bot.currentConsularTime}`,
      currentCas: bot.currentCasDate ? `${bot.currentCasDate} ${bot.currentCasTime}` : 'N/A',
    });

    // Resolve public IP via ipify (always — webshare with "direct" entries needs it as fallback)
    ipPromise = fetch('https://api.ipify.org?format=text', { signal: AbortSignal.timeout(3000) })
      .then(r => r.text())
      .then(ip => { publicIp = ip.trim(); logger.info('Public IP resolved', { botId, publicIp }); })
      .catch(() => { /* non-fatal */ });

    metadata.set("phase", "Cargando sesion...");
    // Load session + exclusions + last poll (for date diff) in parallel
    const [[session], exDates, exTimes, lastPollResult] = await Promise.all([
      db.select({
        yatriCookie: sessions.yatriCookie,
        csrfToken: sessions.csrfToken,
        authenticityToken: sessions.authenticityToken,
        createdAt: sessions.createdAt,
        lastUsedAt: sessions.lastUsedAt,
      }).from(sessions).where(eq(sessions.botId, botId)),
      db.select().from(excludedDates).where(eq(excludedDates.botId, botId)),
      db.select().from(excludedTimes).where(eq(excludedTimes.botId, botId)),
      db.select({ rawDatesCount: pollLogs.rawDatesCount, topDates: pollLogs.topDates }).from(pollLogs)
        .where(eq(pollLogs.botId, botId)).orderBy(desc(pollLogs.id)).limit(1)
        .catch(() => [] as { rawDatesCount: number | null; topDates: string[] | null }[]),
    ]);
    // Seed previousDates from last poll's topDates for dateChanges detection
    let previousDates: Set<string> | null = null;
    const lastTopDates = lastPollResult[0]?.topDates;
    if (lastTopDates && lastTopDates.length > 0) {
      previousDates = new Set(lastTopDates);
    }
    // lastDatesCount may not be passed on cron restart — recover from DB
    const effectiveLastDatesCount = payload.lastDatesCount ?? (lastPollResult[0]?.rawDatesCount ?? undefined);
    timings.load = Date.now() - loadStart;
    if (!session) {
      logger.warn('No session found, requesting manual login', { botId });
      await loginVisaTask.trigger({ botId }, { tags: [`bot:${botId}`] });
      return;
    }

    const sessionAgeMs = Date.now() - session.createdAt.getTime();
    const sessionAgeMin = Math.round(sessionAgeMs / 60000);
    logger.info('Session loaded', { botId, sessionAgeMin, lastUsedAt: session.lastUsedAt?.toISOString() });

    // Pre-emptive re-login: refresh session before the ~88min hard TTL.
    // 50min threshold — Peru sessions expire at ~60min (Colombia ~88min).
    const RE_LOGIN_THRESHOLD_MIN = 50;
    if (sessionAgeMin > RE_LOGIN_THRESHOLD_MIN && !dryRun) {
      logger.info('Pre-emptive re-login (session age > threshold)', { botId, sessionAgeMin, threshold: RE_LOGIN_THRESHOLD_MIN });
      metadata.set("phase", "Re-login preventivo...");
      const reloginStart = Date.now();
      try {
        let email: string, password: string;
        try {
          email = decrypt(bot.visaEmail);
          password = decrypt(bot.visaPassword);
        } catch (e) {
          throw new Error(`Failed to decrypt credentials: ${e}`);
        }
        const creds: LoginCredentials = {
          email,
          password,
          scheduleId: bot.scheduleId,
          applicantIds: bot.applicantIds,
          locale: bot.locale ?? 'es-co',
        };
        const loginResult = await performLogin(creds);

        if (loginResult.hasTokens) {
          logger.info('Pre-emptive re-login OK — cookie + tokens fresh', {
            botId,
            cookieLength: loginResult.cookie.length,
            csrfPrefix: loginResult.csrfToken.substring(0, 12),
          });
        } else {
          logger.warn('Pre-emptive re-login OK but tokens MISSING', { botId, cookieLength: loginResult.cookie.length });
        }

        // Update session in DB with new cookie + tokens
        const oldCsrf = session.csrfToken;
        const newSessionData: Record<string, unknown> = {
          yatriCookie: encrypt(loginResult.cookie),
          lastUsedAt: new Date(),
          createdAt: new Date(),
        };
        if (loginResult.hasTokens) {
          newSessionData.csrfToken = loginResult.csrfToken;
          newSessionData.authenticityToken = loginResult.authenticityToken;
        } else {
          // CRITICAL: old tokens are session-bound (authenticity_token) — invalid with new cookie.
          // Set to null to force refreshTokens() on next poll cycle.
          newSessionData.csrfToken = null;
          newSessionData.authenticityToken = null;
          logger.warn('Clearing stale tokens in DB (appointment page failed, old tokens invalid with new cookie)', { botId });
        }
        await db.update(sessions).set(newSessionData).where(eq(sessions.botId, botId));

        // Update in-memory session for this run
        session.yatriCookie = encrypt(loginResult.cookie);
        if (loginResult.hasTokens) {
          session.csrfToken = loginResult.csrfToken;
          session.authenticityToken = loginResult.authenticityToken;
        } else {
          // Clear in-memory too — forces refreshTokens() later in this run
          session.csrfToken = null as unknown as string;
          session.authenticityToken = null as unknown as string;
        }
        session.createdAt = new Date();

        reloginHappened = true;
        timings.relogin = Date.now() - reloginStart;
        const csrfChanged = loginResult.hasTokens ? loginResult.csrfToken !== oldCsrf : false;
        logger.info('Pre-emptive re-login: DB updated', {
          botId,
          csrfChanged,
          tokensFromFreshLogin: loginResult.hasTokens,
        });
      } catch (reloginErr) {
        if (reloginErr instanceof InvalidCredentialsError) {
          logger.error('Pre-emptive re-login: invalid credentials', { botId });
          await db.update(bots).set({ status: 'error', updatedAt: new Date() }).where(eq(bots.id, botId));
          return;
        }
        // Non-fatal: current session may still have ~44min left
        logger.warn('Pre-emptive re-login failed, continuing with existing session', {
          botId,
          error: reloginErr instanceof Error ? reloginErr.message : String(reloginErr),
          remainingMinutes: Math.round((88 - sessionAgeMin)),
        });
      }
    }

    let cookie: string;
    try {
      cookie = decrypt(session.yatriCookie);
    } catch (e) {
      throw new Error(`Failed to decrypt session for bot ${botId}: ${e}`);
    }

    logger.info(`Cookie: len=${cookie.length} prefix=${cookie.substring(0, 30)} csrf=${(session.csrfToken ?? '').substring(0, 15)}`, { botId });

    // Cloud: always direct — webshare fails TCP ~73% from cloud workers,
    // fallback always lands on the same cloud IP anyway (no diversity gain).
    // Dev: bot's configured provider (webshare rotates across proxy IPs + RPi direct).
    const effectiveProvider: ProxyProvider = isCloud ? 'direct' : bot.proxyProvider as ProxyProvider;
    const effectiveProxyUrls = isCloud ? null : bot.proxyUrls as string[] | null;
    if (effectiveProvider !== bot.proxyProvider) {
      logger.info('Provider override', { botId, configured: bot.proxyProvider, effective: effectiveProvider, reason: 'cloud_direct' });
    }

    const client = new VisaClient(
      {
        cookie,
        csrfToken: session.csrfToken ?? '',
        authenticityToken: session.authenticityToken ?? '',
      },
      {
        scheduleId: bot.scheduleId,
        applicantIds: bot.applicantIds,
        consularFacilityId: bot.consularFacilityId,
        ascFacilityId: bot.ascFacilityId,
        proxyProvider: effectiveProvider,
        proxyUrls: effectiveProxyUrls,
        userId: bot.userId,
        locale: bot.locale,
      },
    );

    const dateExclusions = exDates.map((d) => ({ startDate: d.startDate, endDate: d.endDate }));

    let capturedConnInfo: LogPollExtra['connectionInfo'] = null;
    try {
      let allDays: DaySlot[];
      let days: Array<{ date: string }>;
      let skipFinalLog = false;

      if (dryRun) {
        // Mock: generate a date 5 days before current consular date
        const currentDate = bot.currentConsularDate || '2026-12-20';
        const mockDate = new Date(currentDate);
        mockDate.setDate(mockDate.getDate() - 5);
        const mockDateStr = mockDate.toISOString().split('T')[0]!;
        allDays = [{ date: mockDateStr, business_day: true }, { date: currentDate, business_day: true }];
        days = allDays;
        logger.info('[DRY RUN] Using mock consular days', { botId, mockDate: mockDateStr, current: currentDate });
      } else {
        // refreshTokens: only needed on first run (to get userId) or if tokens are missing.
        // getConsularDays() keeps the session alive on its own — saves ~1s per poll.
        const needsRefresh = !bot.userId || !session.csrfToken || !session.authenticityToken;
        if (needsRefresh) {
          const oldCsrf = session.csrfToken;
          const oldAuth = session.authenticityToken;
          metadata.set("phase", "Refrescando tokens...");
          logger.info('Refreshing tokens (direct)...', { botId, reason: !bot.userId ? 'no_userId' : 'missing_tokens' });
          try {
            await client.refreshTokens();
            const newSession = client.getSession();
            const csrfChanged = newSession.csrfToken !== oldCsrf;
            const authChanged = newSession.authenticityToken !== oldAuth;
            logger.info('Tokens refreshed', { botId, csrfChanged, authChanged });

            // Persist userId on first successful refresh (fire-and-forget)
            if (!bot.userId && client.getUserId()) {
              pending.push(db.update(bots).set({ userId: client.getUserId(), updatedAt: new Date() }).where(eq(bots.id, botId)).catch((e) => logger.error('userId persist failed', { error: String(e) })));
              logger.info('userId persisted to DB', { botId, userId: client.getUserId() });
            }

            // Persist extracted ASC facility ID if bot doesn't have one set (fire-and-forget)
            const extractedAsc = client.getExtractedAscFacilityId();
            if (extractedAsc && !bot.ascFacilityId) {
              pending.push(db.update(bots).set({ ascFacilityId: extractedAsc, updatedAt: new Date() }).where(eq(bots.id, botId)).catch((e) => logger.error('ascFacilityId persist failed', { error: String(e) })));
              logger.info('ASC facility ID persisted from HTML', { botId, ascFacilityId: extractedAsc });
            }
          } catch (refreshErr) {
            if (refreshErr instanceof SessionExpiredError) throw refreshErr;
            logger.warn('Token refresh failed, continuing with existing tokens', {
              botId,
              error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
            });
          }
        } else {
          logger.info('Skipping refreshTokens (userId + tokens cached)', { botId });
        }

        // Fetch consular days + current appointment in parallel (zero extra latency)
        const superCritical = isInSuperCriticalWindow(bot.locale);
        // Skip appointment sync if: env var set, or appointment is >6 months away (won't change often)
        const apptFarAway = bot.currentConsularDate && (new Date(bot.currentConsularDate).getTime() - Date.now()) > 180 * 86400000;
        const skipSync = process.env.SKIP_APPOINTMENT_SYNC === 'true' || !!apptFarAway;
        metadata.set("phase", "Consultando dias...");
        logger.info('Fetching consular days...', { botId, provider: effectiveProvider, superCritical, skipSync });

        const fetchStart = Date.now();
        // Kick off consular days fetch first
        const daysPromise = client.getConsularDays().then((result) => {
          const proxyMeta = client.getLastProxyMeta();
          capturedConnInfo = captureConnInfo(proxyMeta);
          // Capture webshare IP immediately (before appointment fetch may update lastProxyMeta)
          if (proxyMeta.proxyAttemptIp) publicIp = proxyMeta.proxyAttemptIp;
          return result;
        });
        const apptPromise = skipSync ? Promise.resolve(null) : client.getCurrentAppointment().catch((err) => {
          logger.warn('Failed to fetch current appointment', {
            botId,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
        // ipPromise runs in parallel with consular days fetch (0 extra latency, resolved before logPoll)
        const [firstDaysResult, currentAppt] = await Promise.all([daysPromise, apptPromise, ipPromise]);
        timings.fetch = Date.now() - fetchStart;

        // Sync current appointment from website → DB if changed
        if (currentAppt) {
          logger.info('Current appointment from web', {
            botId,
            consular: `${currentAppt.consularDate} ${currentAppt.consularTime}`,
            cas: currentAppt.casDate ? `${currentAppt.casDate} ${currentAppt.casTime}` : 'N/A',
          });
          const changed =
            currentAppt.consularDate !== bot.currentConsularDate ||
            currentAppt.consularTime !== bot.currentConsularTime ||
            currentAppt.casDate !== bot.currentCasDate ||
            currentAppt.casTime !== bot.currentCasTime;

          if (changed) {
            logger.info('Appointment changed externally — syncing DB', {
              botId,
              dbConsular: `${bot.currentConsularDate} ${bot.currentConsularTime}`,
              dbCas: bot.currentCasDate ? `${bot.currentCasDate} ${bot.currentCasTime}` : 'N/A',
              webConsular: `${currentAppt.consularDate} ${currentAppt.consularTime}`,
              webCas: currentAppt.casDate ? `${currentAppt.casDate} ${currentAppt.casTime}` : 'N/A',
            });
            // Update in-memory for comparison, persist in background
            bot.currentConsularDate = currentAppt.consularDate;
            bot.currentConsularTime = currentAppt.consularTime;
            bot.currentCasDate = currentAppt.casDate;
            bot.currentCasTime = currentAppt.casTime;
            pending.push(
              db.update(bots).set({
                currentConsularDate: currentAppt.consularDate,
                currentConsularTime: currentAppt.consularTime,
                currentCasDate: currentAppt.casDate,
                currentCasTime: currentAppt.casTime,
                updatedAt: new Date(),
              }).where(eq(bots.id, botId)).catch((e) => logger.error('appt sync failed', { error: String(e) })),
            );
          }
        }

        allDays = firstDaysResult;
        runRawDatesCount = allDays.length;
        days = filterDates(allDays, dateExclusions, bot.targetDateBefore);
        metadata.set("phase", days.length > 0 ? `Analizando ${days.length} fechas...` : "Sin fechas disponibles");

        // Detect cross-run soft ban: previous run had 20+ dates, now ≤2
        // In cron mode, effectiveLastDatesCount is recovered from DB since payload doesn't carry it
        if (!softBanNotified && effectiveLastDatesCount && effectiveLastDatesCount > 20 && allDays.length <= 2) {
          softBanNotified = true;
          logger.warn('SOFT BAN suspected — dates dropped dramatically', {
            botId, previousCount: effectiveLastDatesCount, currentCount: allDays.length,
          });
          pending.push(
            notifyUserTask.trigger({
              botId,
              event: 'soft_ban_suspected',
              data: { previousCount: effectiveLastDatesCount, currentCount: allDays.length },
            }, { tags: [`bot:${botId}`] }).catch((e) => logger.error('soft_ban notify failed', { error: String(e) })),
          );
        }

        if (superCritical) {
          // === SUPER-CRITICAL CONTINUOUS LOOP (8:58–9:08) ===
          // Instead of 3 burst fetches + self-trigger with 10s delay,
          // loop continuously inside a single run with 3s between fetches.
          // Eliminates ~10s dead time between runs.
          const loopBudgetMs = 45_000; // 45s budget (maxDuration=120s, leave margin for inline reschedule)
          let loopFetchCount = 1;
          let consecutiveErrors = 0;
          let consecutive5xx = 0;
          let foundImprovement = false;

          // Log first fetch — use 'soft_ban' status if cross-run detection fired
          const firstEarliest = days[0]?.date;
          const firstStatus = softBanNotified ? 'soft_ban' : (days.length > 0 ? 'ok' : 'filtered_out');
          const firstDateChanges = computeDateChanges(allDays, previousDates);
          logPoll(pending, botId, firstEarliest ?? null, days.length, Date.now() - startMs, firstStatus, undefined, allDays.slice(0, 3).map(d => d.date), undefined, { rawDatesCount: allDays.length, provider: effectiveProvider, reloginHappened, phaseTimings: { ...timings }, allDates: allDays, chainId, pollPhase: 'super-critical', fetchIndex: 0, runId: ctx.run.id, publicIp, dateChanges: firstDateChanges, connectionInfo: capturedConnInfo });
          previousDates = new Set(allDays.map(d => d.date));
          logger.info('Super-critical fetch 1 result', { botId, total: allDays.length, afterFilter: days.length, earliest: firstEarliest });

          if (firstEarliest && bot.currentConsularDate && isAtLeastNDaysEarlier(firstEarliest, bot.currentConsularDate, 1)) {
            foundImprovement = true;
          }

          while (!foundImprovement) {
            // Budget check: exit if <4s remain
            const elapsed = Date.now() - startMs;
            if (elapsed > loopBudgetMs) {
              logger.info('Super-critical loop — budget exhausted', { botId, elapsed, fetches: loopFetchCount });
              break;
            }

            // Window check: exit if no longer in super-critical
            if (!isInSuperCriticalWindow(bot.locale)) {
              logger.info('Super-critical loop — window ended', { botId, fetches: loopFetchCount });
              break;
            }

            // 502 backoff: 15s after 2+ consecutive 5xx (server stressed), else 2s
            const sleepMs = consecutive5xx >= 2 ? 15000 : 2000;
            if (consecutive5xx >= 2) {
              logger.info(`502 backoff — ${sleepMs}ms delay`, { botId, consecutive5xx });
            }
            await new Promise((r) => setTimeout(r, sleepMs));

            // Fetch (only consular days — getCurrentAppointment doesn't change every 3s)
            loopFetchCount++;
            metadata.set("phase", `Loop #${loopFetchCount} — consultando...`);
            const fetchStart = Date.now();
            try {
              allDays = await client.getConsularDays();
              days = filterDates(allDays, dateExclusions, bot.targetDateBefore);
              consecutiveErrors = 0;
              consecutive5xx = 0;
            } catch (fetchErr) {
              if (fetchErr instanceof SessionExpiredError) throw fetchErr;
              const fetchMs = Date.now() - fetchStart;
              const errMsg = extractErrorMessage(fetchErr);

              // Classify error
              const tcpBlock = isTcpBlockError(errMsg);
              const serverOverload = is5xxError(errMsg);

              if (serverOverload) {
                // 5xx: backoff but don't break — server may recover
                consecutive5xx++;
                {
                  const proxyIp = client.getLastProxyMeta().proxyAttemptIp;
                  if (proxyIp) publicIp = proxyIp;
                }
                logPoll(pending, botId, null, 0, fetchMs, 'error', errMsg, undefined, undefined, { provider: effectiveProvider, chainId, pollPhase: 'super-critical', fetchIndex: loopFetchCount - 1, runId: ctx.run.id, publicIp, connectionInfo: captureConnInfo(client.getLastProxyMeta()) });
                logger.warn(`Super-critical fetch ${loopFetchCount} — HTTP 5xx (${consecutive5xx} consecutive)`, { botId, error: errMsg });
                if (consecutive5xx >= 2 && !throttleNotified) {
                  throttleNotified = true;
                  logger.warn('SERVER THROTTLE detected — backing off', { botId, consecutive5xx });
                  pending.push(
                    notifyUserTask.trigger({
                      botId,
                      event: 'server_throttled',
                      data: { consecutive5xx, window: 'super-critical', error: errMsg },
                    }, { tags: [`bot:${botId}`] }).catch((e) => logger.error('throttle notify failed', { error: String(e) })),
                  );
                }
                if (consecutive5xx >= 5) {
                  logger.warn('Too many 5xx errors, breaking super-critical loop', { botId, consecutive5xx });
                  break;
                }
                continue;
              }

              // Non-5xx errors (TCP block, etc.)
              consecutiveErrors++;
              consecutive5xx = 0;
              // Capture proxy IP even on failure (meta is set before HTTP request throws)
              {
                const proxyIp = client.getLastProxyMeta().proxyAttemptIp;
                if (proxyIp) publicIp = proxyIp;
              }
              logPoll(pending, botId, null, 0, fetchMs, tcpBlock ? 'tcp_blocked' : 'error', errMsg, undefined, undefined, { provider: effectiveProvider, chainId, pollPhase: 'super-critical', fetchIndex: loopFetchCount - 1, runId: ctx.run.id, publicIp, connectionInfo: captureConnInfo(client.getLastProxyMeta()) });
              logger.warn(`Super-critical fetch ${loopFetchCount} error`, { botId, consecutiveErrors, error: errMsg });
              if (tcpBlock && !tcpBlockNotified) {
                tcpBlockNotified = true;
                const errorSource = classifyProxyError(fetchErr, fetchMs);
                logger.error('TCP BLOCK detected during super-critical window', { botId, error: errMsg, errorSource });
                // Always notify during super-critical (high-value window)
                pending.push(
                  notifyUserTask.trigger({
                    botId,
                    event: 'tcp_blocked',
                    data: { error: errMsg, window: 'super-critical', fetchNumber: loopFetchCount, errorSource },
                  }, { tags: [`bot:${botId}`] }).catch((e) => logger.error('tcp_blocked notify failed', { error: String(e) })),
                );
              }
              if (consecutiveErrors >= 3) {
                logger.warn('Super-critical loop — 3 consecutive errors, breaking', { botId });
                break;
              }
              continue;
            }

            // Detect intra-run soft ban BEFORE logging (previous fetch had 20+ dates, now ≤2)
            const isSoftBan = !softBanNotified && runRawDatesCount > 20 && allDays.length <= 2;
            if (isSoftBan) {
              softBanNotified = true;
              logger.warn('SOFT BAN suspected (intra-run) — dates dropped dramatically', {
                botId, previousCount: runRawDatesCount, currentCount: allDays.length,
              });
              pending.push(
                notifyUserTask.trigger({
                  botId,
                  event: 'soft_ban_suspected',
                  data: { previousCount: runRawDatesCount, currentCount: allDays.length, window: 'super-critical' },
                }, { tags: [`bot:${botId}`] }).catch((e) => logger.error('soft_ban notify failed', { error: String(e) })),
              );
            }

            const fetchEarliest = days[0]?.date;
            const fetchMs2 = Date.now() - fetchStart;
            const fetchStatus = isSoftBan ? 'soft_ban' : (days.length > 0 ? 'ok' : 'filtered_out');
            const loopDateChanges = computeDateChanges(allDays, previousDates);
            logPoll(pending, botId, fetchEarliest ?? null, days.length, fetchMs2, fetchStatus, undefined, allDays.slice(0, 3).map(d => d.date), undefined, { rawDatesCount: allDays.length, provider: effectiveProvider, allDates: allDays, chainId, pollPhase: 'super-critical', fetchIndex: loopFetchCount - 1, runId: ctx.run.id, publicIp, dateChanges: loopDateChanges, connectionInfo: captureConnInfo(client.getLastProxyMeta()) });
            previousDates = new Set(allDays.map(d => d.date));
            logger.info(`Super-critical fetch ${loopFetchCount} result`, {
              botId,
              total: allDays.length,
              afterFilter: days.length,
              earliest: fetchEarliest,
              fetchMs: fetchMs2,
            });

            if (allDays.length > 0) runRawDatesCount = allDays.length;

            if (fetchEarliest && bot.currentConsularDate && isAtLeastNDaysEarlier(fetchEarliest, bot.currentConsularDate, 1)) {
              foundImprovement = true;
            }
          }

          logger.info('Super-critical loop done', { botId, fetches: loopFetchCount, foundImprovement, consecutive5xx, totalMs: Date.now() - startMs });
          skipFinalLog = true; // Already logged each fetch individually
        }
      }

      // Batch polling loop: run multiple polls within a single Trigger.dev run (~90s budget)
      // to reduce Trigger.dev overhead (1 dequeue per batch vs 1 per poll).
      const BATCH_BUDGET_MS = 90_000;
      let batchFetchCount = 0;
      let iterationStartMs = startMs;

      while (true) {
        batchFetchCount++;

        // Check for improvement and reschedule inline
        const earliest = days[0]?.date;
        let reschedulePersistedSession = false;
        let rescheduleResultLabel: string | null = null;
        let rescheduleResultObj: RescheduleResult | null = null;

        // Inline reschedule — hard limit: some embassies (e.g. Peru) have a max reschedule count
        // Dedup: skip if the other chain already rescheduled for this bot in the last 3 min
        if (bot.maxReschedules != null && bot.rescheduleCount >= bot.maxReschedules) {
          logger.warn('Reschedule BLOCKED — max reschedule limit reached', {
            botId, rescheduleCount: bot.rescheduleCount, maxReschedules: bot.maxReschedules,
          });
        } else if (earliest && bot.currentConsularDate && isAtLeastNDaysEarlier(earliest, bot.currentConsularDate, 1)) {
          const RESCHEDULE_DEDUP_MS = 3 * 60 * 1000;
          const [recentReschedule] = await db.select({ id: rescheduleLogs.id, newConsularDate: rescheduleLogs.newConsularDate })
            .from(rescheduleLogs)
            .where(and(eq(rescheduleLogs.botId, botId), eq(rescheduleLogs.success, true), gte(rescheduleLogs.createdAt, new Date(Date.now() - RESCHEDULE_DEDUP_MS))))
            .orderBy(desc(rescheduleLogs.createdAt)).limit(1);
          if (recentReschedule) {
            logger.info('Inline reschedule SKIPPED — other chain already rescheduled (dedup)', {
              botId, chainId, recentRescheduleId: recentReschedule.id, newDate: recentReschedule.newConsularDate,
            });
            // Update in-memory bot to reflect the new date from the other chain's reschedule
            bot.currentConsularDate = recentReschedule.newConsularDate;
          } else {
          logger.info('EARLIER DATE FOUND — rescheduling inline', {
            botId,
            earliest,
            current: bot.currentConsularDate,
            daysEarlier: Math.floor((new Date(bot.currentConsularDate).getTime() - new Date(earliest).getTime()) / 86400000),
          });

          const timeExclusions = exTimes.map((t) => ({
            date: t.date,
            timeStart: t.timeStart,
            timeEnd: t.timeEnd,
          }));
          metadata.set("phase", "Reagendando...");
          // Decrypt credentials for mid-reschedule re-login (non-fatal if fails)
          let loginCreds: { email: string; password: string; scheduleId: string; applicantIds: string[]; locale: string } | undefined;
          try {
            loginCreds = {
              email: decrypt(bot.visaEmail),
              password: decrypt(bot.visaPassword),
              scheduleId: bot.scheduleId,
              applicantIds: bot.applicantIds,
              locale: bot.locale ?? 'es-co',
            };
          } catch (e) {
            logger.warn('Failed to decrypt credentials for reschedule re-login', { botId, error: String(e) });
          }
          // Lazy load casCacheJson only when reschedule is needed (~50-150 KB, saves egress on every poll)
          const [cacheRow] = await db.select({ casCacheJson: bots.casCacheJson }).from(bots).where(eq(bots.id, botId));
          const cacheData = cacheRow?.casCacheJson as CasCacheData | null;
          const rescheduleStart = Date.now();
          const result = await executeReschedule({
            client,
            botId,
            bot,
            dateExclusions,
            timeExclusions,
            preFetchedDays: allDays,
            casCacheJson: cacheData,
            dryRun,
            pending,
            loginCredentials: loginCreds,
            maxReschedules: bot.maxReschedules,
          });
          timings.reschedule = Date.now() - rescheduleStart;
          rescheduleResultObj = result;
          rescheduleResultLabel = deriveRescheduleResult(result);
          if (result.success) {
            bot.currentConsularDate = result.date!;
            bot.currentConsularTime = result.consularTime!;
            bot.currentCasDate = result.casDate!;
            bot.currentCasTime = result.casTime!;
            reschedulePersistedSession = true; // session already persisted in executeReschedule
          } else if (result.reason === 'all_candidates_failed') {
            // Fire-and-forget — notify user that date was found but couldn't be booked
            pending.push(
              notifyUserTask.trigger({
                botId,
                event: 'reschedule_failed',
                data: {
                  totalDurationMs: result.totalDurationMs,
                  attempts: result.attempts,
                  currentDate: bot.currentConsularDate,
                },
              }, { tags: [`bot:${botId}`] }).catch((e) => logger.error('reschedule_failed notify failed', { error: String(e) })),
            );
          }
          logger.info('Inline reschedule done', { botId, success: result.success, reason: result.reason, rescheduleResult: rescheduleResultLabel });
          } // end else (no recent reschedule)
        } else if (earliest) {
          logger.info('No improvement — earliest is not ≥1 day before current', {
            botId,
            earliest,
            current: bot.currentConsularDate,
          });
        }

        // Log final result (skip if super-critical loop already logged each fetch)
        if (!skipFinalLog) {
          const responseTimeMs = Date.now() - iterationStartMs;
          const finalStatus = softBanNotified ? 'soft_ban' : (days.length > 0 ? 'ok' : 'filtered_out');
          const pollPhase = isInSuperCriticalWindow(bot.locale) ? 'super-critical' : 'normal';
          const finalDateChanges = computeDateChanges(allDays, previousDates);
          const extra: LogPollExtra = {
            rawDatesCount: allDays.length,
            provider: effectiveProvider,
            reloginHappened,
            phaseTimings: { ...timings },
            ...(rescheduleResultObj?.attempts ? { rescheduleDetails: { attempts: rescheduleResultObj.attempts } } : {}),
            allDates: allDays,
            chainId,
            pollPhase,
            fetchIndex: batchFetchCount - 1,
            runId: ctx.run.id,
            publicIp,
            dateChanges: finalDateChanges,
            connectionInfo: capturedConnInfo,
          };

          // topDates always uses raw (unfiltered) dates for consistent cancellation tracking
          const topDatesRaw = allDays.slice(0, 3).map(d => d.date);
          if (days.length === 0) {
            logger.info('No available dates', { botId, responseTimeMs, softBan: softBanNotified });
            logPoll(pending, botId, null, 0, responseTimeMs, finalStatus, undefined, topDatesRaw, undefined, extra);
          } else {
            logger.info('Dates found', {
              botId,
              total: allDays.length,
              afterFilter: days.length,
              earliest,
              current: bot.currentConsularDate,
              responseTimeMs,
            });
            logPoll(pending, botId, earliest!, days.length, responseTimeMs, finalStatus, undefined, topDatesRaw, rescheduleResultLabel, extra);
          }
        } else if (rescheduleResultLabel) {
          // Super-critical/burst: update the most recent poll_log with the reschedule result
          pending.push(
            db.select({ id: pollLogs.id }).from(pollLogs)
              .where(eq(pollLogs.botId, botId))
              .orderBy(desc(pollLogs.createdAt))
              .limit(1)
              .then(([row]) => row ? db.update(pollLogs).set({ rescheduleResult: rescheduleResultLabel }).where(eq(pollLogs.id, row.id)) : undefined)
              .catch((e) => logger.error('rescheduleResult update failed', { error: String(e) })),
          );
        }

        // Persist updated session (fire-and-forget, skip if reschedule already did it or dry run)
        if (!dryRun && !reschedulePersistedSession) {
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
        }

        // Reset error count on success + auto-recover from error/login_required status (fire-and-forget)
        if (bot.consecutiveErrors > 0 || bot.status === 'error' || bot.status === 'login_required') {
          logger.info('Resetting errors' + (bot.status !== 'active' ? ` + AUTO-RECOVERING from ${bot.status} status` : ''), { botId, oldErrors: bot.consecutiveErrors, oldStatus: bot.status });
          pending.push(db.update(bots).set({ consecutiveErrors: 0, status: 'active', updatedAt: new Date() }).where(eq(bots.id, botId)).catch((e) => logger.error('error reset failed', { error: String(e) })));
          bot.consecutiveErrors = 0;
          bot.status = 'active';
        }

        // ── [E] Batch loop exit conditions ──

        // TCP block / throttle → exit, self-trigger will use longer delay
        if (tcpBlockNotified || throttleNotified) break;

        // Super-critical window started → exit so next run runs the SC loop
        if (isInSuperCriticalWindow(bot.locale)) break;

        // Dry run → 1 iteration only (mock data doesn't change)
        if (dryRun) break;

        // Budget nearly exhausted (8s margin for self-trigger setup)
        if (Date.now() - startMs >= BATCH_BUDGET_MS - 8_000) break;

        // ── [F] Sleep between polls ──
        {
          const interPollDelayStr = getPollingDelay(bot.locale, getEffectiveInterval(bot.locale, bot.pollIntervalSeconds, bot.targetPollsPerMin));
          const interPollMs = parseInt(interPollDelayStr) * 1_000;
          await new Promise((r) => setTimeout(r, interPollMs));
        }

        // ── [G] Re-check phase post-sleep (may have transitioned during sleep) ──
        if (isInSuperCriticalWindow(bot.locale)) break;

        // ── [H] Next fetch ──
        iterationStartMs = Date.now();
        try {
          allDays = await client.getConsularDays();
          { const proxyMeta = client.getLastProxyMeta(); if (proxyMeta.proxyAttemptIp) publicIp = proxyMeta.proxyAttemptIp; capturedConnInfo = captureConnInfo(proxyMeta); }
          runRawDatesCount = allDays.length;
          days = filterDates(allDays, dateExclusions, bot.targetDateBefore);
          previousDates = new Set(allDays.map(d => d.date));
        } catch (fetchErr) {
          if (fetchErr instanceof SessionExpiredError) throw fetchErr;
          const errMsg = extractErrorMessage(fetchErr);
          const isTcp = isTcpBlockError(errMsg);
          const is5xx = is5xxError(errMsg);
          const fetchMs = Date.now() - iterationStartMs;
          { const proxyIp = client.getLastProxyMeta().proxyAttemptIp; if (proxyIp) publicIp = proxyIp; }
          logPoll(pending, botId, null, 0, fetchMs,
            isTcp ? 'tcp_blocked' : 'error', errMsg,
            undefined, undefined, {
              rawDatesCount: 0, provider: effectiveProvider, reloginHappened,
              chainId, pollPhase: isInSuperCriticalWindow(bot.locale) ? 'super-critical' : 'normal',
              fetchIndex: batchFetchCount,
              runId: ctx.run.id, publicIp, connectionInfo: captureConnInfo(client.getLastProxyMeta()),
            });
          if (isTcp && !tcpBlockNotified) {
            tcpBlockNotified = true;
            const errorSource = classifyProxyError(fetchErr, fetchMs);
            pending.push(notifyUserTask.trigger({ botId, event: 'tcp_blocked',
              data: { error: errMsg, errorSource } }, { tags: [`bot:${botId}`] })
              .catch((e) => logger.error('tcp_blocked notify failed', { error: String(e) })));
          }
          if (is5xx && !throttleNotified) {
            throttleNotified = true;
            pending.push(notifyUserTask.trigger({ botId, event: 'server_throttled',
              data: { consecutive5xx: 1, error: errMsg, window: 'normal' } }, { tags: [`bot:${botId}`] })
              .catch((e) => logger.error('throttle notify failed', { error: String(e) })));
          }
          break;
        }

      } // ── END BATCH LOOP ──
      logger.info('Batch loop done', { botId, batchFetchCount, totalBatchMs: Date.now() - startMs });
    } catch (error) {
      const errMsg = extractErrorMessage(error);
      const responseTimeMs = Date.now() - startMs;
      const tcpBlock = isTcpBlockError(errMsg);
      const serverOverload = is5xxError(errMsg);
      const logStatus = tcpBlock ? 'tcp_blocked' : 'error';
      // Capture proxy IP even on failure (null = direct, ipify already resolved)
      {
        const proxyIp = client.getLastProxyMeta().proxyAttemptIp;
        if (proxyIp) publicIp = proxyIp;
      }
      logger.error(`Poll error: ${errMsg}`, { botId, responseTimeMs, tcpBlock, serverOverload });
      logPoll(pending, botId, null, 0, responseTimeMs, logStatus, errMsg, undefined, undefined, { rawDatesCount: runRawDatesCount > 0 ? runRawDatesCount : undefined, provider: effectiveProvider, reloginHappened, phaseTimings: { ...timings }, chainId, pollPhase: isInSuperCriticalWindow(bot.locale) ? 'super-critical' : 'normal', runId: ctx.run.id, publicIp, connectionInfo: capturedConnInfo });

      if (error instanceof SessionExpiredError) {
        logger.warn(`SESSION EXPIRED: ${errMsg} — attempting inline re-login`, { botId });
        metadata.set("phase", "Re-login inline (401)...");
        let email: string | undefined;
        let password: string | undefined;
        try {
          try {
            email = decrypt(bot.visaEmail);
            password = decrypt(bot.visaPassword);
          } catch (decErr) {
            throw new Error(`Failed to decrypt credentials: ${decErr}`);
          }
          const creds: LoginCredentials = {
            email,
            password,
            scheduleId: bot.scheduleId,
            applicantIds: bot.applicantIds,
            locale: bot.locale ?? 'es-co',
          };
          const loginResult = await performLogin(creds);
          logger.info(`Inline re-login OK — cookie=${loginResult.cookie.length}chars hasTokens=${loginResult.hasTokens}`, { botId });
          logAuth({ email, action: 'inline_relogin', locale: bot.locale ?? 'es-co', result: 'ok', botId });

          // Save new session to DB
          const newSessionData: Record<string, unknown> = {
            yatriCookie: encrypt(loginResult.cookie),
            lastUsedAt: new Date(),
            createdAt: new Date(),
          };
          if (loginResult.hasTokens) {
            newSessionData.csrfToken = loginResult.csrfToken;
            newSessionData.authenticityToken = loginResult.authenticityToken;
          }
          await db.update(sessions).set(newSessionData).where(eq(sessions.botId, botId));

          // Reset error count on successful re-login
          await db.update(bots).set({ consecutiveErrors: 0, updatedAt: new Date() }).where(eq(bots.id, botId));

          // Don't retry fetch in this run — self-reschedule with short delay to poll immediately
          logger.info('Re-login saved, self-rescheduling with short delay to retry', { botId, chainId });
          cancelPreviousRun(ctx.run.id, activeRunIdField);
          await Promise.allSettled(pending);

          const reloginConcKey = isCloud ? `poll-cloud-${botId}` : `poll-${botId}`;
          const handle = await pollVisaTask.trigger(
            { botId, ...(isCloud ? { chainId: 'cloud' as const } : {}) },
            {
              delay: '3s',
              queue: 'visa-polling-per-bot',
              concurrencyKey: reloginConcKey,
              tags: [`bot:${botId}`, ...(isCloud ? ['cloud'] : [])],
              ...(bot.activatedAt ? { priority: calculatePriority(bot.activatedAt) } : {}),
            },
          );
          const reloginRunField = isCloud ? { activeCloudRunId: handle.id } : { activeRunId: handle.id };
          await db.update(bots).set({ ...reloginRunField, updatedAt: new Date() }).where(eq(bots.id, botId));
          return;
        } catch (loginErr) {
          if (loginErr instanceof InvalidCredentialsError) {
            logger.error('Inline re-login: invalid credentials', { botId });
            logAuth({ email, action: 'inline_relogin', locale: bot.locale ?? 'es-co', result: 'error', errorMessage: 'invalid_credentials', botId });
            await db.update(bots).set({ status: 'error', updatedAt: new Date() }).where(eq(bots.id, botId));
            pending.push(
              notifyUserTask.trigger({
                botId,
                event: 'invalid_credentials',
                data: { message: 'Login failed: invalid email or password. Update credentials and re-activate.' },
              }, { tags: [`bot:${botId}`] }).catch((e) => logger.error('notify failed', { error: String(e) })),
            );
            await Promise.allSettled(pending);
            return;
          }
          // Login failed — fall through to normal error handling below
          const loginErrMsg = loginErr instanceof Error ? loginErr.message : String(loginErr);
          logger.error(`Inline re-login FAILED: ${loginErrMsg}`, { botId });
          logAuth({ email, action: 'inline_relogin', locale: bot.locale ?? 'es-co', result: 'error', errorMessage: loginErrMsg, botId });
          // Trigger login-visa as last resort (cloud re-login)
          const handle = await loginVisaTask.trigger({ botId, chainId }, { tags: [`bot:${botId}`] });
          logger.info('Fallback: login-visa task triggered', { botId, runId: handle.id });
          await Promise.allSettled(pending);
          return;
        }
      }

      // Notify on TCP block — but only when the block STARTS (previous poll was not tcp_blocked).
      // Pool state is in-memory and resets per fork, so we use poll_logs for persistent state.
      // sustainedTcpBlockCount is declared at function scope (line ~79) so it's available
      // regardless of which code path (outer catch vs batch-loop inner catch) set tcpBlockNotified.
      if (tcpBlock) {
        const recentStatuses = await db
          .select({ status: pollLogs.status })
          .from(pollLogs)
          .where(eq(pollLogs.botId, botId))
          .orderBy(desc(pollLogs.createdAt))
          .limit(5);
        const firstNonTcp = recentStatuses.findIndex((r) => r.status !== 'tcp_blocked');
        sustainedTcpBlockCount = firstNonTcp === -1 ? recentStatuses.length : firstNonTcp;
      }
      if (tcpBlock && !tcpBlockNotified) {
        tcpBlockNotified = true;
        const errorSource = classifyProxyError(error, responseTimeMs);
        logger.error('TCP BLOCK detected', { botId, error: errMsg, sustainedTcpBlockCount, errorSource });
        if (sustainedTcpBlockCount === 0) {
          // First block in this episode — notify once
          pending.push(
            notifyUserTask.trigger({
              botId,
              event: 'tcp_blocked',
              data: { error: errMsg, errorSource },
            }, { tags: [`bot:${botId}`] }).catch((e) => logger.error('tcp_blocked notify failed', { error: String(e) })),
          );
        }
      }

      // Notify on first 5xx throttle (once per run)
      if (serverOverload && !throttleNotified) {
        throttleNotified = true;
        logger.warn('SERVER THROTTLE detected — will backoff 3min', { botId, error: errMsg });
        pending.push(
          notifyUserTask.trigger({
            botId,
            event: 'server_throttled',
            data: { consecutive5xx: 1, error: errMsg, window: 'normal' },
          }, { tags: [`bot:${botId}`] }).catch((e) => logger.error('throttle notify failed', { error: String(e) })),
        );
      }

      // TCP/5xx errors are transient (site down, server overload) — don't count towards kill threshold.
      // Only count session/logic errors that indicate a real problem with the bot.
      if (tcpBlock || serverOverload) {
        logger.warn('Transient error (TCP/5xx) — NOT incrementing consecutiveErrors, will backoff', { botId, tcpBlock, serverOverload });
      } else {
        const newErrors = bot.consecutiveErrors + 1;
        pending.push(db.update(bots).set({ consecutiveErrors: sql`${bots.consecutiveErrors} + 1`, updatedAt: new Date() }).where(eq(bots.id, botId)).catch((e) => logger.error('error count failed', { error: String(e) })));
        logger.warn('Consecutive errors incremented', { botId, errors: newErrors });

        if (newErrors >= 5) {
          logger.error('TOO MANY ERRORS — marking bot as error (chain stays alive for auto-recovery)', { botId, chainId, errors: newErrors });
          await db.update(bots).set({ status: 'error', consecutiveErrors: 0, updatedAt: new Date() }).where(eq(bots.id, botId));
          pending.push(
            notifyUserTask.trigger({
              botId,
              event: 'bot_error',
              data: { message: `Bot marked error after ${newErrors} consecutive errors — will auto-retry in 30min`, lastError: errMsg },
            }).catch((e) => logger.error('bot_error notify failed', { error: String(e) })),
          );
          // Don't return — fall through to self-reschedule with 30min backoff.
          // Chain stays alive. Next successful poll will set status=active.
        }
      }
    }

    // Re-read bot status + consecutiveErrors from DB (may have been changed by other chain or /pause)
    const [freshState] = await db.select({ status: bots.status, consecutiveErrors: bots.consecutiveErrors })
      .from(bots).where(eq(bots.id, botId));
    const freshStatus = freshState?.status ?? bot.status;
    const freshErrors = freshState?.consecutiveErrors ?? bot.consecutiveErrors;

    // #4: If bot was paused/stopped externally, don't self-trigger
    if (freshStatus !== 'active' && freshStatus !== 'error' && freshStatus !== 'login_required') {
      logger.info('Bot no longer active — stopping chain', { botId, freshStatus });
      await Promise.allSettled(pending);
      return;
    }

    // Always chain — cron acts as watchdog if run dies unexpectedly.
    const hadTransientError = tcpBlockNotified || throttleNotified;
    const botJustErrored = freshStatus === 'error' || (freshErrors >= 4 && !hadTransientError);
    const shouldChain = !botJustErrored;

    if (shouldChain) {
      // Self-reschedule (cancel previous delayed run first to prevent pile-up)
      cancelPreviousRun(ctx.run.id, activeRunIdField);
      const normalDelay = getPollingDelay(bot.locale, getEffectiveInterval(bot.locale, bot.pollIntervalSeconds, bot.targetPollsPerMin));
      // tcp_blocked:
      //   webshare → ProxyPoolManager rotates to a healthy IP, use normalDelay (or 5min if sustained)
      //   direct/brightdata/firecrawl → escalating backoff to avoid escalating a single-IP ban
      // 5xx throttle → 3min (server-side, not IP-specific)
      let delay: string;
      if (tcpBlockNotified && bot.proxyProvider === 'webshare') {
        // ≥3 consecutive tcp_blocks = sustained block → 5min backoff to avoid spam.
        delay = sustainedTcpBlockCount >= 3 ? '5m' : normalDelay;
      } else if (tcpBlockNotified) {
        // 0-2 consecutive: normalDelay, 3-4: 10min, 5+: 30min
        delay = sustainedTcpBlockCount <= 2 ? normalDelay
          : sustainedTcpBlockCount <= 4 ? '10m'
          : '30m';
      } else if (throttleNotified) {
        delay = '3m';
      } else {
        delay = normalDelay;
      }
      const priority = calculatePriority(bot.activatedAt);
      const concurrencyKey = isCloud ? `poll-cloud-${botId}` : `poll-${botId}`;
      logger.info('Self-rescheduling (chain)', { botId, chainId, delay, priority, ...(hadTransientError ? { tcpBlock: tcpBlockNotified, throttle: throttleNotified } : {}) });

      metadata.set("phase", "Auto-programando...");
      const handle = await pollVisaTask.trigger(
        {
          botId,
          ...(isCloud ? { chainId: 'cloud' as const } : {}),
          ...(dryRun ? { dryRun } : {}),
          ...(runRawDatesCount > 0 ? { lastDatesCount: runRawDatesCount } : {}),
        },
        {
          delay: dryRun ? '30s' : delay,
          idempotencyKey: isCloud ? `poll-chain-cloud-${botId}` : `poll-chain-${botId}`,
          queue: 'visa-polling-per-bot',
          concurrencyKey,
          priority,
          tags: [`bot:${botId}`, ...(isCloud ? ['cloud'] : []), ...(dryRun ? ['dry-run'] : [])],
        },
      );

      const runIdField = isCloud ? { activeCloudRunId: handle.id } : { activeRunId: handle.id };
      pending.push(
        db.update(bots)
          .set({ ...runIdField, updatedAt: new Date() })
          .where(eq(bots.id, botId))
          .catch((e) => logger.error('activeRunId persist failed', { error: String(e) })),
      );

      await Promise.allSettled(pending);
      logger.info('poll-visa DONE (chain)', { botId, chainId, nextRunId: handle.id, delay, totalMs: Date.now() - startMs });
    } else {
      // Bot in error state — stop chain, cron will restart when status recovers.
      logger.info('Bot errored — stopping chain, cron will restart', { botId, chainId });
      const clearField = isCloud ? { activeCloudRunId: null } : { activeRunId: null };
      pending.push(
        db.update(bots)
          .set({ ...clearField, updatedAt: new Date() } as Record<string, unknown>)
          .where(eq(bots.id, botId))
          .catch((e) => logger.error('activeRunId clear failed', { error: String(e) })),
      );
      await Promise.allSettled(pending);
      logger.info('poll-visa DONE (chain stopped)', { botId, chainId, totalMs: Date.now() - startMs });
    }
  },
});

interface LogPollExtra {
  rawDatesCount?: number;
  provider?: string;
  reloginHappened?: boolean;
  phaseTimings?: Record<string, number>;
  rescheduleDetails?: object;
  allDates?: Array<{date: string, business_day: boolean}>;
  chainId?: string;
  pollPhase?: string;
  fetchIndex?: number;
  runId?: string;
  publicIp?: string | null;
  dateChanges?: { appeared: string[], disappeared: string[] } | null;
  connectionInfo?: {
    proxyAttemptIp?: string | null;
    fallbackReason?: string;
    websharePoolSize?: number;
    errorSource?: 'proxy_infra' | 'embassy_block' | 'proxy_quota';
  } | null;
}

function captureConnInfo(meta: ProxyFetchMeta): LogPollExtra['connectionInfo'] {
  return (meta.proxyAttemptIp || meta.websharePoolSize > 0) ? {
    proxyAttemptIp: meta.proxyAttemptIp,
    fallbackReason: meta.fallbackReason || undefined,
    websharePoolSize: meta.websharePoolSize > 0 ? meta.websharePoolSize : undefined,
    errorSource: meta.errorSource ?? undefined,
  } : null;
}

function logPoll(
  pending: Promise<unknown>[],
  botId: number,
  earliestDate: string | null,
  datesCount: number,
  responseTimeMs: number,
  status: string,
  error?: string,
  topDates?: string[],
  rescheduleResult?: string | null,
  extra?: LogPollExtra,
): void {
  pending.push(
    db.insert(pollLogs).values({
      botId,
      earliestDate,
      datesCount,
      responseTimeMs,
      status,
      error: error ?? null,
      topDates: topDates ?? null,
      rawDatesCount: extra?.rawDatesCount ?? null,
      provider: extra?.provider ?? null,
      reloginHappened: extra?.reloginHappened ?? null,
      phaseTimings: extra?.phaseTimings ?? null,
      rescheduleResult: rescheduleResult ?? null,
      rescheduleDetails: extra?.rescheduleDetails ?? null,
      allDates: extra?.allDates ?? null, // Kept in DB (ingress free); loaded on-demand via /logs/polls/:id
      chainId: extra?.chainId ?? null,
      pollPhase: extra?.pollPhase ?? null,
      fetchIndex: extra?.fetchIndex ?? null,
      runId: extra?.runId ?? null,
      publicIp: extra?.publicIp ?? null,
      dateChanges: extra?.dateChanges ?? null,
      connectionInfo: extra?.connectionInfo ?? null,
    }).catch((e) => logger.error('logPoll failed', { error: String(e) })),
  );
}

/** Derive a short reschedule result label from executeReschedule output. */
function deriveRescheduleResult(result: RescheduleResult): string {
  if (result.success) return 'success';
  if (result.reason === 'race_condition_stale_data') return 'stale_data';
  if (result.reason === 'all_candidates_failed' && result.attempts?.length) {
    // Pick the predominant failReason from attempts
    const counts = new Map<string, number>();
    for (const a of result.attempts) {
      counts.set(a.failReason, (counts.get(a.failReason) ?? 0) + 1);
    }
    let best = result.attempts[0]!.failReason;
    let bestCount = 0;
    for (const [reason, count] of counts) {
      if (count > bestCount) { best = reason as typeof best; bestCount = count; }
    }
    return best;
  }
  return result.reason ?? 'unknown';
}

/** Compute appeared/disappeared dates between two consecutive polls (pure, no I/O). */
function computeDateChanges(
  currentDates: DaySlot[],
  previousDates: Set<string> | null,
): { appeared: string[], disappeared: string[] } | null {
  if (currentDates.length === 0 && !previousDates) return null;
  const currentSet = new Set(currentDates.map(d => d.date));
  // First poll after restart: treat all current dates as newly appeared
  const prev = previousDates ?? new Set<string>();
  const appeared = [...currentSet].filter(d => !prev.has(d));
  const disappeared = [...prev].filter(d => !currentSet.has(d));
  return { appeared, disappeared };
}

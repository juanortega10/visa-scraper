import { task, logger, metadata, runs } from '@trigger.dev/sdk/v3';
import { visaPollingQueue, visaPollingPerBotQueue } from './queues.js';
import { db, withDbRetry } from '../db/client.js';
import { bots, sessions, excludedDates, excludedTimes, pollLogs, rescheduleLogs, bookableEvents, dateSightings, banEpisodes, type BanPollDetail } from '../db/schema.js';
import { eq, and, desc, gte, sql, isNotNull } from 'drizzle-orm';
import { decrypt, encrypt } from '../services/encryption.js';
import { VisaClient, SessionExpiredError, type DaySlot } from '../services/visa-client.js';
import { filterDates, isAtLeastNDaysEarlier, isActionableDate, computeDaysImprovement, computeMinDate, isSniperActive, isWithinWindow } from '../utils/date-helpers.js';
import { getPollingDelay, calculatePriority, isInSuperCriticalWindow, getEffectiveInterval, accountBanBackoffDelay, scheduleBlockedBackoffDelay, countSustainedAccountBans, alignToReleaseWindow, debeDespertar } from '../services/scheduling.js';
import { periodoDesdeIntervalo, faseAleatoria, siguienteEnRejilla } from '../services/experimento-estadistica.js';
import { executeReschedule, MAX_EDAD_TOKEN_MS, type RescheduleResult } from '../services/reschedule-logic.js';
import { loginVisaTask } from './login-visa.js';
import { notifyUserTask } from './notify-user.js';
import { performLogin, InvalidCredentialsError, AccountLockedError, type LoginCredentials } from '../services/login.js';
import { classifyProxyError, classifyTcpSubcategory, extractBytesRead, deriveBlockClassification, probeScheduleBlock, type ProxyProvider, type ProxyFetchMeta, type BlockClassification } from '../services/proxy-fetch.js';
import { logAuth } from '../utils/auth-logger.js';
import type { CasCacheData, DateFailureEntry } from '../db/schema.js';
import { isBlocked, pruneDisappeared, CROSS_POLL_WINDOW_MS } from '../services/date-failure-tracker.js';
import { shouldSkipHeartbeatPoll, type HeartbeatState } from '../services/poll-logging.js';
import { Agent } from 'undici';

/**
 * Public IP resolution — cached across polls in the long-lived worker process.
 * Previously this hit api.ipify.org on EVERY poll via the global undici dispatcher;
 * aborted/errored requests left bodies unconsumed → sockets stuck in CLOSE-WAIT
 * (377 leaked sockets observed over ~2.5d uptime). Fix: dedicated short-keepalive
 * Agent + always consume the body + 10min TTL cache (the Pi's egress IP rarely changes).
 */
const IPIFY_AGENT = new Agent({ keepAliveTimeout: 5_000, keepAliveMaxTimeout: 10_000, connections: 2, connectTimeout: 5_000 });
const PUBLIC_IP_TTL_MS = 10 * 60_000;
let cachedPublicIp: { ip: string; at: number } | null = null;

async function resolvePublicIp(): Promise<string | null> {
  if (cachedPublicIp && Date.now() - cachedPublicIp.at < PUBLIC_IP_TTL_MS) {
    return cachedPublicIp.ip;
  }
  try {
    const res = await fetch('https://api.ipify.org?format=text', {
      signal: AbortSignal.timeout(3000),
      // @ts-expect-error undici dispatcher works with global fetch
      dispatcher: IPIFY_AGENT,
    });
    const ip = (await res.text()).trim(); // always consume body so the socket is released
    if (ip) cachedPublicIp = { ip, at: Date.now() };
  } catch {
    /* non-fatal: fall back to stale cache (if any) */
  }
  return cachedPublicIp?.ip ?? null;
}

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
    let sustainedAccountBanCount = 0; // subset of sustainedTcpBlockCount: consecutive account_ban polls
    let runRawDatesCount = -1; // latest raw (unfiltered) dates count in this run
    let reloginHappened = false;
    let publicIp: string | null = null;
    let connInfoExtra: { sessionAgeMs?: number; pollRateRecentPerMin?: number } = {};
    const timings: Record<string, number> = {};
    let hasOpenBanEpisode = false; // true if bot currently has an open ban_episode
    let closedBanThisRun = false;  // true if this run's success closed a ban episode
    logger.info('poll-visa START', { botId, chainId, dryRun: dryRun || undefined });

    // Public IP resolved lazily after bot load (need to know provider)
    let ipPromise: Promise<void> = Promise.resolve();
    metadata.set("phase", "Cargando bot...");

    // Load bot (first — early exit if paused/missing)
    // SELECT specific columns — omit casCacheJson (~50-150 KB) to reduce Neon egress
    const loadStart = Date.now();
    const [bot] = await withDbRetry(() => db.select({
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
      activatedAt: bots.activatedAt, targetDateBefore: bots.targetDateBefore, targetDateAfter: bots.targetDateAfter, sniperMode: bots.sniperMode,
      maxReschedules: bots.maxReschedules, portalRemainingReschedules: bots.portalRemainingReschedules, phaseAligned: bots.phaseAligned, phaseExperiment: bots.phaseExperiment, rescheduleCount: bots.rescheduleCount, maxCasGapDays: bots.maxCasGapDays, skipCas: bots.skipCas, speculativeTimeFallback: bots.speculativeTimeFallback, speculativeTimes: bots.speculativeTimes, minDaysFromToday: bots.minDaysFromToday, excludedWeekdays: bots.excludedWeekdays,
      pollIntervalSeconds: bots.pollIntervalSeconds, targetPollsPerMin: bots.targetPollsPerMin,
      skippedPollsSinceLog: bots.skippedPollsSinceLog,
      proxyUrls: bots.proxyUrls,
      webhookUrl: bots.webhookUrl, notificationEmail: bots.notificationEmail,
      ownerEmail: bots.ownerEmail,
      applicantNames: bots.applicantNames,
      testMode: bots.testMode,
    }).from(bots).where(eq(bots.id, botId)));
    if (!bot || bot.status === 'paused') {
      logger.info('Bot not active, stopping poll chain', { botId, status: bot?.status });
      return;
    }
    // Defensive guard: if a test-mode bot somehow gets enqueued (e.g. legacy cron
    // or a flag-flip race), exit before contacting the embassy. The dashboard still
    // shows the bot as 'active' but no portal traffic happens.
    if (bot.testMode) {
      logger.info('Bot in test mode, skipping poll', { botId });
      return;
    }

    // Environment guard: stop chains running in the wrong environment.
    // pollEnvironments is the source of truth; cloudEnabled is legacy (kept for backward compat).
    const botPollEnvs = (bot.pollEnvironments as string[] | null) ?? ['dev'];
    const runtimeEnv = ctx.environment.type; // 'PRODUCTION' | 'DEVELOPMENT' | 'STAGING'
    const isRuntimeCloud = runtimeEnv === 'PRODUCTION';
    if (isRuntimeCloud && !bot.cloudEnabled && !botPollEnvs.includes('prod')) {
      logger.info('Chain stopped — bot not configured for cloud polling', { botId, chainId, runtimeEnv, pollEnvironments: botPollEnvs });
      return;
    }
    // Symmetric DEV guard: stop a DEV (RPi) self-chain once the bot no longer includes 'dev'
    // (e.g. flipped to ['prod']). Without this the dev chain keeps self-triggering and collides
    // with the cloud chain on the same account → ban (canary 221 stall, 2026-06-11). Clear the
    // stale dev activeRunId so the orphan check can't resurrect a ghost and a later flip-back is clean.
    if (!isRuntimeCloud && !botPollEnvs.includes('dev')) {
      logger.info('Chain stopped — bot not configured for dev polling', { botId, chainId, runtimeEnv, pollEnvironments: botPollEnvs });
      await db.update(bots).set({ activeRunId: null, updatedAt: new Date() }).where(eq(bots.id, botId))
        .catch((e) => logger.error('dev guard activeRunId clear failed', { botId, error: String(e) }));
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
          console.warn(`[chain] bot ${botId}: ABORTA por run huerfano · activo=${activeRunIdField} estado=${activeRun.status}`);
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
    // El sleep existe para que corridas simultaneas se registren antes del dedup.
    // Solo hace falta cuando este run NO es el que el bot tiene registrado: ahi si
    // puede haber otra cadena viva. Cuando coincide, no hay nada que esperar, y esos
    // 800 ms salian de la cadencia de deteccion en el 100% de los polls.
    if (activeRunIdField !== ctx.run.id) {
      await new Promise((r) => setTimeout(r, 800));
    }
    try {
      const activePage = await runs.list({
        tag: [`bot:${botId}`, ...(isCloud ? ['cloud'] : [])],
        status: ['EXECUTING', 'DEQUEUED', 'QUEUED', 'DELAYED'],
        limit: 20,
      });
      for (const otherRun of activePage.data) {
        if (otherRun.id === ctx.run.id) continue;
        // DEDUP FALLBACK: any DELAYED run for this bot is an intentional backoff chain.
        // Abort this run (cron) rather than cancelling the backoff, regardless of activeRunIdField.
        // (activeRunIdField may lag if the DB update failed silently after the previous self-trigger.)
        if (otherRun.status === 'DELAYED') {
          // Antes de abortar: ¿ese retraso todavia tiene sentido? Un run DELAYED viejo
          // hace abortar TODOS los runs del cron y el bot deja de pollear por horas,
          // aunque siga `active`. Se compara el silencio real contra el backoff que si
          // esta justificado. Un ban de cuenta nunca se acorta.
          let despertar = false;
          try {
            const ultimos = await db.select({
              status: pollLogs.status,
              createdAt: pollLogs.createdAt,
              blockCls: sql<string | null>`${pollLogs.connectionInfo}->>'blockClassification'`,
            }).from(pollLogs).where(eq(pollLogs.botId, botId)).orderBy(desc(pollLogs.id)).limit(5);
            const msSinPoll = ultimos[0] ? Date.now() - ultimos[0].createdAt.getTime() : Number.MAX_SAFE_INTEGER;
            const bansSeguidos = countSustainedAccountBans(ultimos);
            despertar = debeDespertar({ msSinPoll, bansSeguidos, blockCls: ultimos[0]?.blockCls ?? null });
            if (despertar) {
              console.warn(`[chain] bot ${botId}: DESPIERTA · cancela DELAYED ${otherRun.id} tras ${Math.round(msSinPoll / 60_000)} min sin pollear`);
              logger.warn('CADENA DORMIDA — cancelling stale DELAYED run and polling now', {
                botId, chainId, runId: ctx.run.id, delayedRunId: otherRun.id,
                minSinPoll: Math.round(msSinPoll / 60_000), bansSeguidos,
              });
              await runs.cancel(otherRun.id).catch(() => {});
            }
          } catch (e) {
            logger.warn('No se pudo evaluar la cadena dormida, se aborta como antes', { botId, error: String(e) });
          }
          if (despertar) continue;
          console.warn(`[chain] bot ${botId}: ABORTA por run DELAYED · ${otherRun.id}`);
          logger.warn('DEDUP FALLBACK — found DELAYED run, aborting this run', {
            botId, chainId, runId: ctx.run.id, delayedRunId: otherRun.id, activeRunId: activeRunIdField,
          });
          await Promise.allSettled(pending);
          return;
        }
        const cancelAlways = otherRun.status === 'QUEUED';
        if (!cancelAlways && otherRun.id > ctx.run.id) continue; // Newer executing run — let it cancel us
        console.warn(`[chain] bot ${botId}: cancela duplicado ${otherRun.id} (${otherRun.status})`);
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

    // Resolve public IP via ipify (always — webshare with "direct" entries needs it as fallback).
    // Cached (10min TTL) + dedicated dispatcher to avoid the per-poll CLOSE-WAIT socket leak.
    ipPromise = resolvePublicIp()
      .then(ip => { if (ip) { publicIp = ip; logger.info('Public IP resolved', { botId, publicIp }); } });

    metadata.set("phase", "Cargando sesion...");
    // Load session + exclusions + last poll (for date diff) in parallel
    const [[session], exDates, exTimes, lastPollResult] = await withDbRetry(() => Promise.all([
      db.select({
        yatriCookie: sessions.yatriCookie,
        csrfToken: sessions.csrfToken,
        authenticityToken: sessions.authenticityToken,
        tokensRefreshedAt: sessions.tokensRefreshedAt,
        createdAt: sessions.createdAt,
        lastUsedAt: sessions.lastUsedAt,
      }).from(sessions).where(eq(sessions.botId, botId)),
      db.select().from(excludedDates).where(eq(excludedDates.botId, botId)),
      db.select().from(excludedTimes).where(eq(excludedTimes.botId, botId)),
      db.select({ rawDatesCount: pollLogs.rawDatesCount, topDates: pollLogs.topDates, allDates: pollLogs.allDates }).from(pollLogs)
        .where(and(eq(pollLogs.botId, botId), isNotNull(pollLogs.topDates)))
        .orderBy(desc(pollLogs.id)).limit(1)
        .catch(() => [] as { rawDatesCount: number | null; topDates: string[] | null; allDates: Array<{date: string}> | null }[]),
    ]));
    // Seed previousDates from last poll's allDates (full set) for accurate dateChanges detection
    // Falls back to topDates (3 entries) if allDates is missing (old polls)
    let previousDates: Set<string> | null = null;
    const lastAllDates = lastPollResult[0]?.allDates;
    if (lastAllDates && lastAllDates.length > 0) {
      previousDates = new Set(lastAllDates.map(d => d.date));
    } else {
      const lastTopDates = lastPollResult[0]?.topDates;
      if (lastTopDates && lastTopDates.length > 0) {
        previousDates = new Set(lastTopDates);
      }
    }
    // lastDatesCount may not be passed on cron restart — recover from DB
    const effectiveLastDatesCount = payload.lastDatesCount ?? (lastPollResult[0]?.rawDatesCount ?? undefined);
    timings.load = Date.now() - loadStart;
    if (!session) {
      console.warn(`[chain] bot ${botId}: SIN SESION, pide login manual`);
      logger.warn('No session found, requesting manual login', { botId, chainId });
      // Propagate chainId so a cloud-owned bot's login-recovery restarts in cloud, not on the RPi (dev).
      await loginVisaTask.trigger({ botId, chainId }, { tags: [`bot:${botId}`] });
      return;
    }

    const sessionAgeMs = Date.now() - session.createdAt.getTime();
    const sessionAgeMin = Math.round(sessionAgeMs / 60000);
    connInfoExtra.sessionAgeMs = sessionAgeMs;

    // Compute poll rate from last 5 polls (for all polls, not just tcp blocks)
    const rateQuery = await db
      .select({ createdAt: pollLogs.createdAt })
      .from(pollLogs)
      .where(eq(pollLogs.botId, botId))
      .orderBy(desc(pollLogs.createdAt))
      .limit(5);
    // Heartbeat gate state: createdAt of the most recent poll_log row for this bot.
    // The DB is the only cross-run state (Trigger.dev runs are stateless; the self-trigger
    // payload is unreliable on cron restart — see effectiveLastDatesCount above). logPoll
    // skips steady-state "nothing happened" polls unless this is >HEARTBEAT_MS old.
    // Mutable per-run heartbeat state: logPoll skips quiet polls and counts them in `skipped`,
    // updating `lastLoggedAt` on each write. `skipped` is seeded from / persisted to the bot row
    // so the count carries across runs (handles batch bursts AND cron 1-poll/run exactly).
    const hb: HeartbeatState = { lastLoggedAt: rateQuery[0]?.createdAt ?? null, lastPolledAt: rateQuery[0]?.createdAt ?? null, skipped: bot.skippedPollsSinceLog ?? 0 };
    if (rateQuery.length >= 2) {
      const newest = rateQuery[0]!.createdAt.getTime();
      const oldest = rateQuery[rateQuery.length - 1]!.createdAt.getTime();
      const spanMin = (newest - oldest) / 60_000;
      if (spanMin > 0) {
        connInfoExtra.pollRateRecentPerMin = Math.round((rateQuery.length / spanMin) * 10) / 10;
      }
    }

    logger.info('Session loaded', { botId, sessionAgeMin, lastUsedAt: session.lastUsedAt?.toISOString() });

    // Check if bot currently has an open ban episode (for banPhase tagging)
    const [openEp] = await db.select({ id: banEpisodes.id })
      .from(banEpisodes)
      .where(and(eq(banEpisodes.botId, botId), sql`${banEpisodes.endedAt} IS NULL`))
      .limit(1);
    hasOpenBanEpisode = !!openEp;

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
          botId,
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
          // Token nuevo: el sello arranca de cero. El `authenticity_token` esta atado
          // a la sesion de Rails, entonces un login nuevo invalida el anterior.
          newSessionData.tokensRefreshedAt = new Date();
        } else {
          // CRITICAL: old tokens are session-bound (authenticity_token) — invalid with new cookie.
          // Set to null to force refreshTokens() on next poll cycle.
          newSessionData.csrfToken = null;
          newSessionData.authenticityToken = null;
          newSessionData.tokensRefreshedAt = null;
          logger.warn('Clearing stale tokens in DB (appointment page failed, old tokens invalid with new cookie)', { botId });
        }
        await db.update(sessions).set(newSessionData).where(eq(sessions.botId, botId));

        // Update in-memory session for this run
        session.yatriCookie = encrypt(loginResult.cookie);
        if (loginResult.hasTokens) {
          session.csrfToken = loginResult.csrfToken;
          session.authenticityToken = loginResult.authenticityToken;
          session.tokensRefreshedAt = new Date();
        } else {
          // Clear in-memory too — forces refreshTokens() later in this run
          session.csrfToken = null as unknown as string;
          session.authenticityToken = null as unknown as string;
          session.tokensRefreshedAt = null;
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
        // Frescura heredada del run anterior. Permite que `ensureTokens()` se salte
        // la pagina del appointment cuando el token ya venia precalentado.
        tokensRefreshedAt: session.tokensRefreshedAt,
      },
    );

    const dateExclusions = exDates.map((d) => ({ startDate: d.startDate, endDate: d.endDate }));
    const minDate = computeMinDate(bot.minDaysFromToday);

    // SNIPER MODE: hunt ANY consular date inside [targetDateAfter, targetDateBefore), even if it is
    // NOT earlier than the current appointment (owner-authorized override of the strictly-earlier rule).
    // `days` is already window-bounded via filterDates(targetDateAfter) below, so a present `earliest`
    // implies an in-window slot. executeReschedule enforces the same window + the secure-then-improve loop.
    const sniperMode = isSniperActive(bot.sniperMode, bot.targetDateAfter, bot.targetDateBefore);
    const inSniperWindow = (d: string | null | undefined): boolean =>
      isWithinWindow(d, bot.targetDateAfter, bot.targetDateBefore);
    // The sniper override (take ANY in-window date, even a later one) applies ONLY while the
    // current appointment is still OUTSIDE the window. Once the appointment is inside it, the
    // strictly-earlier rule returns: the bot only improves, it never trades an in-window date
    // for a later in-window one.
    // Evaluated at each use — bot.currentConsularDate changes in-memory during the batch loop.
    const sniperFreeMove = (): boolean => sniperMode && !inSniperWindow(bot.currentConsularDate);

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
          capturedConnInfo = captureConnInfo(proxyMeta, connInfoExtra);
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

        // Backfill applicant names — the groups page we just parsed carries them, so
        // any bot onboarded before they were stored (or created without them) fills
        // itself in on its first poll. Zero extra requests, one UPDATE, once per bot.
        if (currentAppt?.applicantNames.length && !(bot.applicantNames?.length)) {
          bot.applicantNames = currentAppt.applicantNames;
          logger.info('Backfilling applicant names', { botId, names: currentAppt.applicantNames });
          pending.push(
            db.update(bots)
              .set({ applicantNames: currentAppt.applicantNames, updatedAt: new Date() })
              .where(eq(bots.id, botId))
              .catch((e) => logger.error('applicant names backfill failed', { error: String(e) })),
          );
        }

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
            // Guard against portal propagation delay: if portal shows a worse consular date than DB
            // and a reschedule succeeded in the last 2 min, the portal likely hasn't propagated yet.
            // Only skip consular fields — CAS is independent and always safe to sync.
            const PROPAGATION_GUARD_MS = 2 * 60 * 1000;
            const portalConsularWorse = bot.currentConsularDate && currentAppt.consularDate &&
              new Date(currentAppt.consularDate) > new Date(bot.currentConsularDate);

            let skipConsularSync = false;
            if (portalConsularWorse) {
              const [recentSuccess] = await db.select({ id: rescheduleLogs.id })
                .from(rescheduleLogs)
                .where(and(
                  eq(rescheduleLogs.botId, botId),
                  eq(rescheduleLogs.success, true),
                  gte(rescheduleLogs.createdAt, new Date(Date.now() - PROPAGATION_GUARD_MS)),
                ))
                .orderBy(desc(rescheduleLogs.createdAt))
                .limit(1);

              if (recentSuccess) {
                skipConsularSync = true;
                logger.warn('Skipping consular sync — portal propagation delay suspected', {
                  botId,
                  dbConsular: `${bot.currentConsularDate} ${bot.currentConsularTime}`,
                  webConsular: `${currentAppt.consularDate} ${currentAppt.consularTime}`,
                  recentRescheduleId: recentSuccess.id,
                });
              }
            }

            logger.info('Appointment changed externally — syncing DB', {
              botId,
              dbConsular: `${bot.currentConsularDate} ${bot.currentConsularTime}`,
              dbCas: bot.currentCasDate ? `${bot.currentCasDate} ${bot.currentCasTime}` : 'N/A',
              webConsular: `${currentAppt.consularDate} ${currentAppt.consularTime}`,
              webCas: currentAppt.casDate ? `${currentAppt.casDate} ${currentAppt.casTime}` : 'N/A',
              skipConsularSync,
            });

            // Update in-memory for comparison, persist in background
            if (!skipConsularSync) {
              bot.currentConsularDate = currentAppt.consularDate;
              bot.currentConsularTime = currentAppt.consularTime;
            }
            bot.currentCasDate = currentAppt.casDate;
            bot.currentCasTime = currentAppt.casTime;
            pending.push(
              db.update(bots).set({
                ...(skipConsularSync ? {} : {
                  currentConsularDate: currentAppt.consularDate,
                  currentConsularTime: currentAppt.consularTime,
                }),
                currentCasDate: currentAppt.casDate,
                currentCasTime: currentAppt.casTime,
                updatedAt: new Date(),
              }).where(eq(bots.id, botId)).catch((e) => logger.error('appt sync failed', { error: String(e) })),
            );
          }
        }

        allDays = firstDaysResult;
        runRawDatesCount = allDays.length;
        days = filterDates(allDays, dateExclusions, bot.targetDateBefore, minDate, bot.targetDateAfter, bot.excludedWeekdays);
        metadata.set("phase", days.length > 0 ? `Analizando ${days.length} fechas...` : "Sin fechas disponibles");

        // Detect soft ban: dramatic date count drop.
        // Cross-run: previous run or DB had 15+ dates, now ≤2 (lowered from 20→15 threshold)
        // Intra-bot: query last 5 ok/filtered polls — if median rawDatesCount > 15 and current ≤ 2
        if (!softBanNotified && allDays.length <= 2) {
          const crossRunDrop = effectiveLastDatesCount && effectiveLastDatesCount > 15;
          let intraBotDrop = false;
          if (!crossRunDrop) {
            // Query recent successful polls for this bot to detect gradual → sudden drop
            const recentOkPolls = await db
              .select({ rawDatesCount: pollLogs.rawDatesCount })
              .from(pollLogs)
              .where(and(eq(pollLogs.botId, botId), sql`${pollLogs.status} IN ('ok', 'filtered_out')`, isNotNull(pollLogs.rawDatesCount)))
              .orderBy(desc(pollLogs.createdAt))
              .limit(5);
            const counts = recentOkPolls.map(r => r.rawDatesCount!).filter(n => n > 0);
            if (counts.length >= 2) {
              const sorted = [...counts].sort((a, b) => a - b);
              const median = sorted[Math.floor(sorted.length / 2)];
              intraBotDrop = (median ?? 0) > 15;
            }
          }
          if (crossRunDrop || intraBotDrop) {
            softBanNotified = true;
            const prevCount = crossRunDrop ? effectiveLastDatesCount : 'median>15';
            logger.warn('SOFT BAN suspected — dates dropped dramatically', {
              botId, previousCount: prevCount, currentCount: allDays.length, source: crossRunDrop ? 'cross_run' : 'intra_bot',
            });
            pending.push(
              notifyUserTask.trigger({
                botId,
                event: 'soft_ban_suspected',
                data: { previousCount: prevCount, currentCount: allDays.length, source: crossRunDrop ? 'cross_run' : 'intra_bot' },
              }, { tags: [`bot:${botId}`] }).catch((e) => logger.error('soft_ban notify failed', { error: String(e) })),
            );
          }
        }

        if (superCritical) {
          // === SUPER-CRITICAL CONTINUOUS LOOP (8:58–9:08) ===
          // Instead of 3 burst fetches + self-trigger with 10s delay,
          // loop continuously inside a single run with 3s between fetches.
          // Eliminates ~10s dead time between runs.
          const loopBudgetMs = 45_000; // 45s budget (maxDuration=300s, leave margin for inline reschedule)
          let loopFetchCount = 1;
          let consecutiveErrors = 0;
          let consecutive5xx = 0;
          let foundImprovement = false;

          // Log first fetch — use 'soft_ban' status if cross-run detection fired
          const firstEarliest = days[0]?.date;
          const firstStatus = softBanNotified ? 'soft_ban' : (days.length > 0 ? 'ok' : 'filtered_out');
          const firstDateChanges = computeDateChanges(allDays, previousDates);
          logPoll(pending, botId, firstEarliest ?? null, days.length, Date.now() - startMs, firstStatus, undefined, allDays.slice(0, 10).map(d => d.date), undefined, { rawDatesCount: allDays.length, provider: effectiveProvider, reloginHappened, phaseTimings: { ...timings }, allDates: allDays, chainId, pollPhase: 'super-critical', fetchIndex: 0, runId: ctx.run.id, publicIp, dateChanges: firstDateChanges, banPhase: getBanPhase(firstStatus, hasOpenBanEpisode), connectionInfo: capturedConnInfo }, undefined, hb);
          if (hasOpenBanEpisode) hasOpenBanEpisode = false; // recovery consumed
          persistDateSightings(pending, botId, firstDateChanges, bot.currentConsularDate, bot.targetDateBefore);
          previousDates = new Set(allDays.map(d => d.date));
          logger.info('Super-critical fetch 1 result', { botId, total: allDays.length, afterFilter: days.length, earliest: firstEarliest });

          if (firstEarliest && isActionableDate(firstEarliest, bot.currentConsularDate, sniperFreeMove())) {
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
              days = filterDates(allDays, dateExclusions, bot.targetDateBefore, minDate, bot.targetDateAfter, bot.excludedWeekdays);
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
                logPoll(pending, botId, null, 0, fetchMs, 'error', errMsg, undefined, undefined, { provider: effectiveProvider, chainId, pollPhase: 'super-critical', fetchIndex: loopFetchCount - 1, runId: ctx.run.id, publicIp, banPhase: null, connectionInfo: captureConnInfo(client.getLastProxyMeta(), connInfoExtra) }, undefined, hb);
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
              const scLogStatus = tcpBlock ? 'tcp_blocked' : 'error';
              logPoll(pending, botId, null, 0, fetchMs, scLogStatus, errMsg, undefined, undefined, { provider: effectiveProvider, chainId, pollPhase: 'super-critical', fetchIndex: loopFetchCount - 1, runId: ctx.run.id, publicIp, banPhase: getBanPhase(scLogStatus, hasOpenBanEpisode), connectionInfo: captureConnInfo(client.getLastProxyMeta(), connInfoExtra) }, undefined, hb);
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
            logPoll(pending, botId, fetchEarliest ?? null, days.length, fetchMs2, fetchStatus, undefined, allDays.slice(0, 10).map(d => d.date), undefined, { rawDatesCount: allDays.length, provider: effectiveProvider, allDates: allDays, chainId, pollPhase: 'super-critical', fetchIndex: loopFetchCount - 1, runId: ctx.run.id, publicIp, dateChanges: loopDateChanges, banPhase: getBanPhase(fetchStatus, hasOpenBanEpisode), connectionInfo: captureConnInfo(client.getLastProxyMeta(), connInfoExtra) }, undefined, hb);
            if (hasOpenBanEpisode) hasOpenBanEpisode = false;
            persistDateSightings(pending, botId, loopDateChanges, bot.currentConsularDate, bot.targetDateBefore);
            previousDates = new Set(allDays.map(d => d.date));
            logger.info(`Super-critical fetch ${loopFetchCount} result`, {
              botId,
              total: allDays.length,
              afterFilter: days.length,
              earliest: fetchEarliest,
              fetchMs: fetchMs2,
            });

            if (allDays.length > 0) runRawDatesCount = allDays.length;

            if (fetchEarliest && isActionableDate(fetchEarliest, bot.currentConsularDate, sniperFreeMove())) {
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
      const interPollS = getEffectiveInterval(bot.locale, bot.pollIntervalSeconds, bot.targetPollsPerMin);
      let batchFetchCount = 0;
      let iterationStartMs = startMs;
      logger.info('[BATCH] Starting batch loop', { botId, budget: '90s', interPollS, locale: bot.locale });

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
          // Insert bookable_event only when date just appeared (avoid flood on every blocked poll)
          if (earliest && previousDates && !previousDates.has(earliest)) {
            pending.push(
              db.insert(bookableEvents).values({
                botId, date: earliest, outcome: 'blocked_limit',
                consularDateAtDetection: bot.currentConsularDate,
                daysImprovement: computeDaysImprovement(earliest, bot.currentConsularDate),
                locale: bot.locale,
              }).catch(e => logger.error('bookable_event insert failed', { error: String(e) }))
            );
          }
        } else if (earliest && isActionableDate(earliest, bot.currentConsularDate, sniperFreeMove())) {
          const isInitialBooking = bot.currentConsularDate === null;
          const RESCHEDULE_DEDUP_MS = 3 * 60 * 1000;

          // TRES consultas independientes del camino critico, lanzadas a la vez.
          // Ninguna necesita el resultado de otra:
          //   A  dedup          ¿la otra cadena ya reagendo hace menos de 3 min?
          //   B  cache de CAS   solo si la cuenta usa CAS. Peru no la usa.
          //   C  guarda de carrera  ¿otro worker ya dejo una cita mejor?
          // En serie sumaban ~170 ms mientras corre el reloj del cupo. La C se PASA a
          // `executeReschedule`, que la espera antes del POST: se adelanta el viaje a
          // la base de datos, la guarda sigue igual de dura.
          const usaCas = !!bot.ascFacilityId && !bot.skipCas;
          const dedupPromesa = Promise.resolve(
            db.select({ id: rescheduleLogs.id, newConsularDate: rescheduleLogs.newConsularDate })
              .from(rescheduleLogs)
              .where(and(eq(rescheduleLogs.botId, botId), eq(rescheduleLogs.success, true), gte(rescheduleLogs.createdAt, new Date(Date.now() - RESCHEDULE_DEDUP_MS))))
              .orderBy(desc(rescheduleLogs.createdAt)).limit(1),
          );
          const cachePromesa: Promise<Array<{ casCacheJson: unknown }>> = usaCas
            ? Promise.resolve(db.select({ casCacheJson: bots.casCacheJson }).from(bots).where(eq(bots.id, botId)))
            : Promise.resolve([]);
          const fechaFrescaPromesa = Promise.resolve(
            db.select({ currentConsularDate: bots.currentConsularDate }).from(bots).where(eq(bots.id, botId)),
          );
          // Si el dedup corta el flujo, las otras dos quedan sin esperar. Sin este
          // manejador vacio, un rechazo tumbaria el proceso entero.
          cachePromesa.catch(() => {});
          fechaFrescaPromesa.catch(() => {});

          const [recentReschedule] = await dedupPromesa;
          if (recentReschedule) {
            logger.info('Inline reschedule SKIPPED — other chain already rescheduled (dedup)', {
              botId, chainId, recentRescheduleId: recentReschedule.id, newDate: recentReschedule.newConsularDate,
            });
            // Update in-memory bot to reflect the new date from the other chain's reschedule
            bot.currentConsularDate = recentReschedule.newConsularDate;
          } else {
          logger.info(isInitialBooking ? 'INITIAL BOOKING — booking inline' : 'EARLIER DATE FOUND — rescheduling inline', {
            botId,
            earliest,
            current: bot.currentConsularDate,
            initialBooking: isInitialBooking,
            daysEarlier: bot.currentConsularDate
              ? Math.floor((new Date(bot.currentConsularDate).getTime() - new Date(earliest).getTime()) / 86400000)
              : null,
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
          // Se carga solo si este bot USA CAS. Peru y las renovaciones tienen
          // `ascFacilityId` vacio, entonces `needsCas` sera false en
          // `reschedule-logic.ts:236` y el cache nunca se lee. Ese SELECT costaba
          // ~85 ms dentro del camino critico, justo cuando corre el reloj del cupo.
          // (El comentario viejo decia 50-150 KB; medido son 212-1.228 bytes.)
          // La consulta ya salio arriba, en paralelo con el dedup.
          const [cacheRow] = await cachePromesa;
          const cacheData = cacheRow?.casCacheJson as CasCacheData | null;

          // Filter out consular dates blocked due to repeated no_cas_days failures
          const nowMs = Date.now();
          const rawBlocked = cacheData?.blockedConsularDates ?? {};
          const activeBlocked = Object.fromEntries(
            Object.entries(rawBlocked).filter(([, until]) => new Date(until).getTime() > nowMs),
          );

          // ── Cross-poll tracker prune/cap/filter (TRACK-04 flapping-aware) ──
          const allDayDates = new Set(allDays.map(d => d.date));
          const rawTracker: Record<string, DateFailureEntry> = cacheData?.dateFailureTracking ?? {};

          let prunedTracker: Record<string, DateFailureEntry> = {};
          for (const [date, entry] of Object.entries(rawTracker)) {
            const stillBlocked = !!entry.blockedUntil && new Date(entry.blockedUntil).getTime() > nowMs;
            const inPortal = allDayDates.has(date);
            const windowOpen = (nowMs - new Date(entry.windowStartedAt).getTime()) <= CROSS_POLL_WINDOW_MS;
            if (stillBlocked) {
              prunedTracker[date] = entry; // preserve regardless of portal/window
              continue;
            }
            if (!inPortal) {
              logger.info('tracker.cleared', { botId, date, reason: 'portal_disappeared' });
              continue;
            }
            if (!windowOpen) {
              logger.info('tracker.cleared', { botId, date, reason: 'window_expired' });
              continue;
            }
            prunedTracker[date] = entry;
          }

          // Defensive currentConsularDate safety net — never count failures on the bot's own date
          if (bot.currentConsularDate && prunedTracker[bot.currentConsularDate]) {
            logger.warn('tracker.cleared (currentConsularDate safety net)', {
              botId, date: bot.currentConsularDate,
              prevEntry: prunedTracker[bot.currentConsularDate],
            });
            logger.info('tracker.cleared', {
              botId, date: bot.currentConsularDate, reason: 'current_consular_safety',
            });
            delete prunedTracker[bot.currentConsularDate];
          }

          // Cap at 100 entries — evict lowest totalCount first, never evict blocked entries
          const TRACKER_CAP = 100;
          const trackerEntries = Object.entries(prunedTracker);
          if (trackerEntries.length > TRACKER_CAP) {
            const blockedEntries = trackerEntries.filter(([, e]) => isBlocked(e, nowMs));
            const evictable = trackerEntries
              .filter(([, e]) => !isBlocked(e, nowMs))
              .sort(([, a], [, b]) =>
                a.totalCount - b.totalCount
                || new Date(a.lastFailureAt).getTime() - new Date(b.lastFailureAt).getTime(),
              );
            const keepCount = Math.max(0, TRACKER_CAP - blockedEntries.length);
            const kept = evictable.slice(-keepCount);
            const evicted = evictable.slice(0, evictable.length - kept.length);
            for (const [date] of evicted) {
              logger.info('tracker.cleared', { botId, date, reason: 'pruned' });
            }
            prunedTracker = Object.fromEntries([...blockedEntries, ...kept]);
          }

          // Extend blockedDateSet with tracker-blocked dates
          const blockedDateSet = new Set(Object.keys(activeBlocked));
          for (const [date, entry] of Object.entries(prunedTracker)) {
            if (isBlocked(entry, nowMs)) blockedDateSet.add(date);
          }

          const daysForReschedule = blockedDateSet.size > 0
            ? allDays.filter(d => !blockedDateSet.has(d.date))
            : allDays;
          if (blockedDateSet.size > 0) {
            const skipped = allDays.filter(d => blockedDateSet.has(d.date)).map(d => d.date);
            logger.info('CAS blocker: skipping dates with no CAS availability', { botId, skipped, activeBlocked });
          }

          // If all candidates were blocked, no point calling executeReschedule — skip silently.
          // For initial booking (currentConsularDate=null), any unblocked date is a valid candidate.
          const effectiveEarliest = daysForReschedule.find(
            d => sniperFreeMove()
              ? inSniperWindow(d.date)
              : (bot.currentConsularDate === null || isAtLeastNDaysEarlier(d.date, bot.currentConsularDate, 1)),
          )?.date;
          if (!effectiveEarliest) {
            logger.info('All earlier dates blocked — skipping reschedule', {
              botId, earliest, blockedCount: blockedDateSet.size,
            });
            metadata.set("phase", "Esperando...");
            // fall through to normal poll completion (no reschedule log written)
          } else {

          const rescheduleStart = Date.now();
          const result = await executeReschedule({
            client,
            botId,
            bot,
            dateExclusions,
            timeExclusions,
            preFetchedDays: daysForReschedule,
            casCacheJson: cacheData ? { ...cacheData, dateFailureTracking: prunedTracker } : null,
            dryRun,
            pending,
            loginCredentials: loginCreds,
            maxReschedules: bot.maxReschedules,
            portalRemaining: bot.portalRemainingReschedules,
            runId: ctx.run.id,
            sessionAgeMs,
            fechaFrescaPromesa,
          });
          timings.reschedule = Date.now() - rescheduleStart;
          rescheduleResultObj = result;
          rescheduleResultLabel = deriveRescheduleResult(result);

          // ── Persist blockedConsularDates + dateFailureTracking ──
          // Build updatedBlocked (always, not only on failure, so tracker blocks are persisted too)
          const updatedBlocked = { ...activeBlocked };

          if (!result.success) {
            const fpDates = result.falsePositiveDates ?? [];
            const rfDates = result.repeatedlyFailingDates ?? [];
            // no_cas_days: no short-term block — cross-poll tracker handles blocking after 5 failures in 1h
            if (fpDates.length > 0) {
              const blockUntil6h = new Date(nowMs + 6 * 60 * 60 * 1000).toISOString();
              for (const d of fpDates) updatedBlocked[d] = blockUntil6h;
              logger.info('CAS blocker: blocked dates after false_positive_verification', { botId, dates: fpDates, until: blockUntil6h });
            }
            if (rfDates.length > 0) {
              const blockUntil3h = new Date(nowMs + 3 * 60 * 60 * 1000).toISOString();
              for (const d of rfDates) {
                if (!updatedBlocked[d] || new Date(updatedBlocked[d]!).getTime() < new Date(blockUntil3h).getTime()) {
                  updatedBlocked[d] = blockUntil3h;
                }
              }
              logger.info('CAS blocker: blocked dates after repeated failures', { botId, dates: rfDates, until: blockUntil3h });
            }
          }

          // Merge newlyBlockedDates from cross-poll tracker (OUTSIDE !result.success guard)
          const newlyBlocked = result.newlyBlockedDates ?? [];
          if (newlyBlocked.length > 0) {
            const blockUntil6hIso = new Date(nowMs + 6 * 60 * 60 * 1000).toISOString();
            for (const d of newlyBlocked) {
              const existing = updatedBlocked[d];
              if (!existing || new Date(existing).getTime() < new Date(blockUntil6hIso).getTime()) {
                updatedBlocked[d] = blockUntil6hIso;
              }
            }
            logger.info('tracker: blocked dates from cross-poll tracker', { botId, dates: newlyBlocked, until: new Date(nowMs + 6 * 60 * 60 * 1000).toISOString() });
          }

          // Persist blockedConsularDates + dateFailureTracking in a single nested jsonb_set
          const finalTracker = result.dateFailureTrackingDelta ?? prunedTracker;
          pending.push(
            db.execute(sql`
              UPDATE bots SET cas_cache_json = jsonb_set(
                jsonb_set(COALESCE(cas_cache_json, '{}'::jsonb), '{blockedConsularDates}', ${JSON.stringify(updatedBlocked)}::jsonb),
                '{dateFailureTracking}', ${JSON.stringify(finalTracker)}::jsonb
              ) WHERE id = ${botId}
            `).catch(e => logger.warn('cas_cache write failed', { botId, error: String(e) })),
          );

          const originalConsularDate = bot.currentConsularDate;
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

          // Persist bookable_events: one row per failed attempt + one for success
          const beRows: (typeof bookableEvents.$inferInsert)[] = [];
          for (const attempt of result.attempts ?? []) {
            beRows.push({
              botId, date: attempt.date, outcome: attempt.failReason,
              consularDateAtDetection: originalConsularDate,
              daysImprovement: computeDaysImprovement(attempt.date, originalConsularDate),
              locale: bot.locale,
            });
          }
          if (result.success && result.date) {
            beRows.push({
              botId, date: result.date, outcome: 'success',
              consularDateAtDetection: originalConsularDate,
              daysImprovement: computeDaysImprovement(result.date, originalConsularDate),
              locale: bot.locale,
            });
          }
          if (beRows.length > 0) {
            pending.push(
              db.insert(bookableEvents).values(beRows)
                .catch(e => logger.error('bookable_event insert failed', { error: String(e) }))
            );
          }

          } // end else (effectiveEarliest found — ran executeReschedule)
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
            ...(rescheduleResultObj?.dateFailureTrackingDelta ? { trackerSize: Object.keys(rescheduleResultObj.dateFailureTrackingDelta).length } : {}),
            allDates: allDays,
            chainId,
            pollPhase,
            fetchIndex: batchFetchCount - 1,
            runId: ctx.run.id,
            publicIp,
            dateChanges: finalDateChanges,
            banPhase: getBanPhase(finalStatus, hasOpenBanEpisode),
            connectionInfo: capturedConnInfo,
          };
          // Mark recovery consumed so only the first success poll gets tagged
          if (hasOpenBanEpisode) hasOpenBanEpisode = false;

          // topDates always uses raw (unfiltered) dates for consistent cancellation tracking
          const topDatesRaw = allDays.slice(0, 10).map(d => d.date);
          persistDateSightings(pending, botId, finalDateChanges, bot.currentConsularDate, bot.targetDateBefore);
          if (days.length === 0) {
            logger.info('No available dates', { botId, responseTimeMs, softBan: softBanNotified });
            logPoll(pending, botId, null, 0, responseTimeMs, finalStatus, undefined, topDatesRaw, undefined, extra, hb);
          } else {
            logger.info('Dates found', {
              botId,
              total: allDays.length,
              afterFilter: days.length,
              earliest,
              current: bot.currentConsularDate,
              responseTimeMs,
            });
            logPoll(pending, botId, earliest!, days.length, responseTimeMs, finalStatus, undefined, topDatesRaw, rescheduleResultLabel, extra, hb);
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

        // ── PRECALENTADO DEL TOKEN ──────────────────────────────────────────
        // Se corre AQUI a proposito: el poll ya decidio y ya no hay cupo en juego.
        // El `authenticity_token` vive con la sesion de Rails, entonces pedirlo con
        // calma ahora vale igual que pedirlo con el cupo a la vista, y ahi costaba
        // entre 4 y 14 segundos del camino critico (bot 299, 2026-08-27).
        //
        // Solo aplica a cuentas SIN CAS. Con CAS, `reschedule-logic` necesita
        // `getHasAscFields()` de la lectura del momento y no se salta el refresco,
        // entonces precalentar solo sumaria una peticion sin ahorrar nada.
        //
        // La cadencia es la mitad de `MAX_EDAD_TOKEN_MS`, para que el token todavia
        // este dentro de la ventana cuando el poll siguiente lo quiera usar.
        const usaCasEsteBot = !!bot.ascFacilityId && !bot.skipCas;
        if (!dryRun && !usaCasEsteBot && !reschedulePersistedSession
            && client.getTokensAgeMs() > MAX_EDAD_TOKEN_MS / 2) {
          const t0Token = Date.now();
          try {
            const pedido = await client.ensureTokens(MAX_EDAD_TOKEN_MS / 2);
            if (pedido) {
              logger.info('Token precalentado fuera del camino critico', { botId, ms: Date.now() - t0Token });
            }
          } catch (e) {
            // Nunca tumba el poll: el token se vuelve a intentar en el siguiente.
            logger.warn('Precalentado del token fallo', { botId, ms: Date.now() - t0Token, error: e instanceof Error ? e.message : String(e) });
          }
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
                tokensRefreshedAt: client.getTokensRefreshedAt(),
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

        // ── Close any open ban episode on successful poll ──
        pending.push(
          db.update(banEpisodes)
            .set({
              endedAt: new Date(),
              durationMin: sql`EXTRACT(EPOCH FROM now() - ${banEpisodes.startedAt})::int / 60`,
              recoveryContext: {
                provider: effectiveProvider,
                publicIp: publicIp || undefined,
                recoveryStatus: softBanNotified ? 'soft_ban' : (days.length > 0 ? 'ok' : 'filtered_out'),
              },
            })
            .where(and(eq(banEpisodes.botId, botId), sql`${banEpisodes.endedAt} IS NULL`))
            .then((result) => {
              if (result.rowCount && result.rowCount > 0) {
                closedBanThisRun = true;
                hasOpenBanEpisode = false;
                logger.info('Ban episode CLOSED', { botId });
              }
            })
            .catch((e) => logger.error('ban_episode close failed', { error: String(e) })),
        );

        // ── [E] Batch loop exit conditions ──

        // Throttle → always exit (server-side, no point retrying immediately)
        if (throttleNotified) {
          logger.info('[BATCH] Exit: throttle', { botId, batchFetchCount, elapsedMs: Date.now() - startMs });
          break;
        }
        // TCP block → only exit if pool is fully exhausted; otherwise reset and continue
        // with fresh IPs (ProxyPoolManager already penalized the failed ones).
        if (tcpBlockNotified) {
          const poolExhausted = capturedConnInfo?.poolExhausted === true;
          if (poolExhausted) {
            logger.info('[BATCH] Exit: tcp_block pool_exhausted', { botId, batchFetchCount, elapsedMs: Date.now() - startMs });
            break;
          }
          logger.info('[BATCH] TCP block but pool has healthy IPs — continuing batch', { botId, batchFetchCount, elapsedMs: Date.now() - startMs });
          tcpBlockNotified = false;
        }

        // Super-critical window started → exit so next run runs the SC loop
        if (isInSuperCriticalWindow(bot.locale)) {
          logger.info('[BATCH] Exit: super_critical', { botId, batchFetchCount, elapsedMs: Date.now() - startMs });
          break;
        }

        // Dry run → 1 iteration only (mock data doesn't change)
        if (dryRun) break;

        // Budget nearly exhausted (8s margin for self-trigger setup)
        const elapsedMs = Date.now() - startMs;
        if (elapsedMs >= BATCH_BUDGET_MS - 8_000) {
          logger.info('[BATCH] Exit: budget_exhausted', { botId, batchFetchCount, elapsedMs });
          break;
        }

        // ── [F] Sleep between polls (start-to-start timing) ──
        {
          const iterationElapsedMs = Date.now() - iterationStartMs;
          const interPollDelayStr = getPollingDelay(bot.locale, interPollS, iterationElapsedMs);
          const interPollMs = parseInt(interPollDelayStr) * 1_000;
          logger.info('[BATCH] Poll done, sleeping', { botId, poll: batchFetchCount, interPollMs, iterationElapsedMs, elapsedMs: Date.now() - startMs });
          await new Promise((r) => setTimeout(r, interPollMs));
        }

        // ── [G] Re-check phase post-sleep (may have transitioned during sleep) ──
        if (isInSuperCriticalWindow(bot.locale)) break;

        // ── [H] Next fetch ──
        previousDates = new Set(allDays.map(d => d.date));
        iterationStartMs = Date.now();
        try {
          allDays = await client.getConsularDays();
          { const proxyMeta = client.getLastProxyMeta(); if (proxyMeta.proxyAttemptIp) publicIp = proxyMeta.proxyAttemptIp; capturedConnInfo = captureConnInfo(proxyMeta, connInfoExtra); }
          runRawDatesCount = allDays.length;
          days = filterDates(allDays, dateExclusions, bot.targetDateBefore, minDate, bot.targetDateAfter, bot.excludedWeekdays);
        } catch (fetchErr) {
          if (fetchErr instanceof SessionExpiredError) throw fetchErr;
          const errMsg = extractErrorMessage(fetchErr);
          const isTcp = isTcpBlockError(errMsg);
          const is5xx = is5xxError(errMsg);
          const fetchMs = Date.now() - iterationStartMs;
          { const proxyIp = client.getLastProxyMeta().proxyAttemptIp; if (proxyIp) publicIp = proxyIp; }
          const batchLogStatus = isTcp ? 'tcp_blocked' : 'error';
          logPoll(pending, botId, null, 0, fetchMs,
            batchLogStatus, errMsg,
            undefined, undefined, {
              rawDatesCount: 0, provider: effectiveProvider, reloginHappened,
              chainId, pollPhase: isInSuperCriticalWindow(bot.locale) ? 'super-critical' : 'normal',
              fetchIndex: batchFetchCount,
              runId: ctx.run.id, publicIp, banPhase: getBanPhase(batchLogStatus, hasOpenBanEpisode), connectionInfo: captureConnInfo(client.getLastProxyMeta(), connInfoExtra),
            }, undefined, hb);
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
      // For direct provider TCP blocks, capturedConnInfo may be null — enrich from error metadata
      if (tcpBlock && !capturedConnInfo) {
        // proxy-fetch.ts now populates proxyMeta on direct provider errors
        const errMeta = (error as Error & { proxyMeta?: ProxyFetchMeta })?.proxyMeta;
        if (errMeta) {
          capturedConnInfo = captureConnInfo(errMeta, connInfoExtra);
        } else {
          // Fallback: derive from bytesRead + error message
          const bytesRead = extractBytesRead(error);
          capturedConnInfo = {
            blockClassification: bytesRead === 0 ? 'account_ban' : 'transient',
            socketBytesRead: bytesRead ?? undefined,
            errorSource: classifyProxyError(error, 0),
            tcpSubcategory: classifyTcpSubcategory(error, false),
            ...connInfoExtra,
          };
        }
      } else if (tcpBlock && capturedConnInfo) {
        // Enrich existing capturedConnInfo with sessionAgeMs/pollRateRecentPerMin if missing
        if (connInfoExtra.sessionAgeMs !== undefined && !capturedConnInfo.sessionAgeMs) {
          capturedConnInfo.sessionAgeMs = connInfoExtra.sessionAgeMs;
        }
      }
      logger.error(`Poll error: ${errMsg}`, { botId, responseTimeMs, tcpBlock, serverOverload });
      logPoll(pending, botId, null, 0, responseTimeMs, logStatus, errMsg, undefined, undefined, { rawDatesCount: runRawDatesCount > 0 ? runRawDatesCount : undefined, provider: effectiveProvider, reloginHappened, phaseTimings: { ...timings }, chainId, pollPhase: isInSuperCriticalWindow(bot.locale) ? 'super-critical' : 'normal', runId: ctx.run.id, publicIp, banPhase: getBanPhase(logStatus, hasOpenBanEpisode), connectionInfo: capturedConnInfo }, undefined, hb);

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
            botId,
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
            logAuth({ email: email ?? '', action: 'inline_relogin', locale: bot.locale ?? 'es-co', result: 'error', errorMessage: 'invalid_credentials', botId });
            await db.update(bots).set({ status: 'invalid_credentials', updatedAt: new Date() }).where(eq(bots.id, botId));
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
          if (loginErr instanceof AccountLockedError) {
            const lockMsg = loginErr.lockedUntil
              ? `Account locked until ${loginErr.lockedUntil.toISOString()}. Will auto-retry via cron.`
              : 'Account locked after too many failed login attempts. Will auto-retry in ~1h.';
            logger.error('Inline re-login: account locked — stopping chain', { botId, lockedUntil: loginErr.lockedUntil?.toISOString() });
            logAuth({ email: email ?? '', action: 'inline_relogin', locale: bot.locale ?? 'es-co', result: 'error', errorMessage: `account_locked${loginErr.lockedUntil ? ` until ${loginErr.lockedUntil.toISOString()}` : ''}`, botId });
            await db.update(bots).set({ status: 'login_required', updatedAt: new Date() }).where(eq(bots.id, botId));
            pending.push(
              notifyUserTask.trigger({
                botId,
                event: 'account_locked',
                data: { message: lockMsg, lockedUntil: loginErr.lockedUntil?.toISOString() },
              }, { tags: [`bot:${botId}`] }).catch((e) => logger.error('notify failed', { error: String(e) })),
            );
            await Promise.allSettled(pending);
            return; // No login-visa fallback, no self-chain — cron retries in 2min but login will keep failing until lockout expires
          }
          // Login failed — fall through to normal error handling below
          const loginErrMsg = loginErr instanceof Error ? loginErr.message : String(loginErr);
          logger.error(`Inline re-login FAILED: ${loginErrMsg}`, { botId });
          logAuth({ email: email ?? '', action: 'inline_relogin', locale: bot.locale ?? 'es-co', result: 'error', errorMessage: loginErrMsg, botId });
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
          .select({
            status: pollLogs.status,
            blockCls: sql<string>`${pollLogs.connectionInfo}->>'blockClassification'`,
            createdAt: pollLogs.createdAt,
          })
          .from(pollLogs)
          .where(eq(pollLogs.botId, botId))
          .orderBy(desc(pollLogs.createdAt))
          .limit(5);
        const firstNonTcp = recentStatuses.findIndex((r) => r.status !== 'tcp_blocked');
        sustainedTcpBlockCount = firstNonTcp === -1 ? recentStatuses.length : firstNonTcp;
        // null blockCls (502/unknown) treated conservatively — does not reset escalation
        sustainedAccountBanCount = countSustainedAccountBans(recentStatuses);
        // Compute pollRateRecentPerMin from last 5 polls timestamps
        if (recentStatuses.length >= 2) {
          const newest = recentStatuses[0]!.createdAt?.getTime() ?? 0;
          const oldest = recentStatuses[recentStatuses.length - 1]!.createdAt?.getTime() ?? 0;
          const spanMin = (newest - oldest) / 60_000;
          if (spanMin > 0) {
            connInfoExtra.pollRateRecentPerMin = Math.round((recentStatuses.length / spanMin) * 10) / 10;
          }
        }
      }
      // ── Schedule-level block probe ──
      // When account_ban is detected for the first time, probe the login page directly.
      // If the domain responds, the ban is on the schedule URL path (nginx 444), not the account.
      // Se refina en CADA bloqueo, no solo en el primero. Antes el gate era
      // `sustainedAccountBanCount === 0`, entonces un bloqueo de schedule quedaba
      // marcado `account_ban` para siempre y cargaba el backoff de 8h que no le toca
      // (caso real: bot 299, schedule 75610929, 2026-08-27). La sonda tiene cache de
      // 5 min por locale, entonces repetirla no agrega peticiones notables.
      if (tcpBlock && (capturedConnInfo?.blockClassification === 'account_ban')) {
        const refined = await probeScheduleBlock(bot.locale ?? 'es-co', bot.scheduleId);
        if (refined === 'schedule_blocked' && capturedConnInfo) {
          capturedConnInfo.blockClassification = 'schedule_blocked';
          logger.warn('Schedule-level URL block detected — nginx 444 on schedule path, not account ban', {
            botId,
            scheduleId: bot.scheduleId,
            locale: bot.locale,
          });
          // La fila de `poll_logs` ya salio marcada `account_ban`: se escribe antes de la sonda.
          // Corregirla en la DB es lo que deja ver el veredicto real a `ensure-chain` (elige el
          // backoff largo), al dashboard y al contador de rachas. Se esperan los INSERT pendientes
          // primero para no actualizar una fila que todavia no existe.
          pending.push(
            Promise.allSettled([...pending])
              .then(() => db.execute(sql`
                UPDATE poll_logs
                SET connection_info = jsonb_set(coalesce(connection_info, '{}'::jsonb), '{blockClassification}', '"schedule_blocked"')
                WHERE id = (SELECT id FROM poll_logs WHERE bot_id = ${botId} ORDER BY id DESC LIMIT 1)
                  AND status = 'tcp_blocked'
                  AND run_id = ${ctx.run.id}
              `))
              .then(() => undefined)
              .catch((e) => logger.error('schedule_blocked reclassify failed', { botId, error: String(e) })),
          );
        }
      }

      // ── Ban episode tracking ──
      if (tcpBlock) {
        const blockCls = capturedConnInfo?.blockClassification ?? 'transient';
        const pollDetail: BanPollDetail = {
          at: new Date().toISOString(),
          cls: blockCls,
          sub: capturedConnInfo?.tcpSubcategory ?? undefined,
          provider: effectiveProvider,
          ip: publicIp || undefined,
          ms: responseTimeMs,
          bytesRead: capturedConnInfo?.socketBytesRead ?? undefined,
          err: errMsg?.substring(0, 120),
        };

        if (sustainedTcpBlockCount === 0) {
          // First block — open new episode
          pending.push(
            db.insert(banEpisodes).values({
              botId,
              classification: blockCls,
              pollCount: 1,
              pollDetails: [pollDetail],
              triggerContext: {
                provider: effectiveProvider,
                publicIp: publicIp || undefined,
                pollRateRecentPerMin: connInfoExtra.pollRateRecentPerMin,
                sessionAgeMs: connInfoExtra.sessionAgeMs,
                locale: bot.locale ?? 'es-co',
              },
            }).catch((e) => logger.error('ban_episode insert failed', { error: String(e) })),
          );
          hasOpenBanEpisode = true;
          logger.info('Ban episode OPENED', { botId, classification: blockCls });
        } else {
          // Ongoing ban — update open episode (set to 'mixed' if classification differs)
          pending.push(
            db.update(banEpisodes)
              .set({
                pollCount: sql`${banEpisodes.pollCount} + 1`,
                pollDetails: sql`${banEpisodes.pollDetails} || ${JSON.stringify([pollDetail])}::jsonb`,
                classification: sql`CASE WHEN ${banEpisodes.classification} = ${blockCls} THEN ${blockCls} ELSE 'mixed' END`,
              })
              .where(and(eq(banEpisodes.botId, botId), sql`${banEpisodes.endedAt} IS NULL`))
              .catch((e) => logger.error('ban_episode update failed', { error: String(e) })),
          );
        }
      }

      if (tcpBlock && !tcpBlockNotified) {
        tcpBlockNotified = true;
        const blockClsNow = capturedConnInfo?.blockClassification ?? 'transient';
        const errorSource = classifyProxyError(error, responseTimeMs);
        logger.error('TCP BLOCK detected', { botId, error: errMsg, sustainedTcpBlockCount, errorSource, blockCls: blockClsNow });
        if (sustainedTcpBlockCount === 0 && blockClsNow !== 'schedule_blocked') {
          // First block in this episode — notify once (skip if schedule_blocked: internal infra issue, not user-facing)
          pending.push(
            notifyUserTask.trigger({
              botId,
              event: 'tcp_blocked',
              data: { error: errMsg, errorSource },
            }, { tags: [`bot:${botId}`] }).catch((e) => logger.error('tcp_blocked notify failed', { error: String(e) })),
          );
        }

        // NO auto-pause. Un bloqueo de la ruta del schedule ya NO pausa el bot (quitado el
        // 2026-08-30): el bot quedaba mudo hasta una reactivacion manual y nadie se enteraba
        // (bots 281 y 298, 2 y 3 dias sin pollear). La compensacion es la curva mas larga de
        // `scheduleBlockedBackoffDelay()`: 240m -> 480m -> 720m, y el bot se recupera solo.
        if (blockClsNow === 'schedule_blocked') {
          logger.warn('Schedule path blocked by server — long backoff, bot stays active', { botId, scheduleId: bot.scheduleId, sustainedAccountBanCount });
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
      const elapsedMs = Date.now() - startMs;
      const baseInterval = getEffectiveInterval(bot.locale, bot.pollIntervalSeconds, bot.targetPollsPerMin);
      let normalDelay = getPollingDelay(bot.locale, baseInterval, elapsedMs);
      // Fase alineada (opt-in): mueve el proximo poll a la ventana donde el portal
      // libera cupos. Ver `analyze-release-clock.ts` para la medicion.
      // El experimento manda sobre `phaseAligned`: cuando esta prendido, el brazo lo
      // decide la hora y el botId, y el bot alterna solo. Ver `experimento-fase.ts`.
      const enExperimento = bot.phaseExperiment === true;
      if (enExperimento) {
        // ── Fase por REJILLA, sorteada cada minuto ──────────────────────────────
        //
        // Antes el brazo alineado ESPERABA a que llegara la ventana s22-32. Medido el
        // 2026-09-01, esa espera le costo throughput: hueco p50 de 98,2 s contra 75,9 s
        // del control. Un brazo con menos polls por hora tiene menos oportunidades, y
        // entonces el experimento dejaba de medir la fase y media el throughput.
        //
        // Una rejilla no espera: el intervalo es SIEMPRE el periodo y la fase es libre.
        // La fase se sortea por (bot, minuto), que hace dos cosas de una vez: cubre todo
        // el minuto a lo largo del dia, y convierte el minuto en un bloque. Comparar
        // segundos dentro del mismo minuto baja la sobredispersion de 6,52 a 2,89.
        //
        // El brazo ya no se decide de antemano: al analizar se mira EN QUE SEGUNDO
        // aterrizo cada poll. La aleatorizacion sigue siendo real porque la fase se
        // sorteo antes de conocer el resultado.
        const periodo = periodoDesdeIntervalo(baseInterval);
        const fase = faseAleatoria(botId, Date.now(), periodo);
        const seg = siguienteEnRejilla({
          nowMs: Date.now(), periodoSec: periodo, faseSec: fase,
          // Piso: lo que falte del intervalo natural, para no adelantar un poll.
          minSec: Math.max(0, baseInterval - elapsedMs / 1000 - periodo),
        });
        logger.info('Fase por rejilla (experimento)', {
          botId, locale: bot.locale, periodo, fase, delaySeconds: Math.round(seg),
        });
        normalDelay = `${Math.round(seg)}s`;
      } else if (bot.phaseAligned === true) {
        const startToStart = Math.max(1, baseInterval - elapsedMs / 1000);
        const al = alignToReleaseWindow({ locale: bot.locale ?? undefined, baseSeconds: startToStart, nowMs: Date.now() });
        if (al.aligned) {
          logger.info('Fase alineada a la ventana de liberacion', {
            botId, locale: bot.locale, naturalSeconds: Math.round(startToStart), alignedSeconds: Math.round(al.seconds),
          });
        }
        normalDelay = `${Math.round(al.seconds)}s`;
      }
      // Recompute backoff escalation counters here (shared path) so they are correct
      // regardless of how the TCP block was detected. The in-catch recompute only runs when an
      // exception propagates to the outer catch; the common webshare path handles blocks INSIDE
      // the batch loop (inner catch → break, no throw), which bypassed the recompute and left the
      // counters at 0 → backoff was stuck at the lowest tier and never escalated (30m/120m/240m).
      if (tcpBlockNotified) {
        const recentForBackoff = await db
          // `createdAt` hace falta: `countSustainedAccountBans` corta la racha cuando dos
          // bloqueos quedan separados por mas que el backoff que se programo.
          .select({ status: pollLogs.status, createdAt: pollLogs.createdAt, blockCls: sql<string>`${pollLogs.connectionInfo}->>'blockClassification'` })
          .from(pollLogs)
          .where(eq(pollLogs.botId, botId))
          .orderBy(desc(pollLogs.createdAt))
          .limit(5);
        const firstNonTcp = recentForBackoff.findIndex((r) => r.status !== 'tcp_blocked');
        sustainedTcpBlockCount = firstNonTcp === -1 ? recentForBackoff.length : firstNonTcp;
        sustainedAccountBanCount = countSustainedAccountBans(recentForBackoff);
      }

      // NOTE: a sustained account ban is NEVER auto-paused — the bot must recover on its
      // own without manual reactivation. It holds at the aggressive backoff cap (480m) and
      // keeps probing every ~8h; the first `ok` poll drops straight back to normal cadence.

      // tcp_blocked:
      //   webshare → ProxyPoolManager rotates to a healthy IP, use normalDelay (or 5min if sustained)
      //   direct/brightdata/firecrawl → escalating backoff to avoid escalating a single-IP ban
      // 5xx throttle → 3min (server-side, not IP-specific)
      let delay: string;
      const blockCls = capturedConnInfo?.blockClassification;
      if (tcpBlockNotified && blockCls === 'schedule_blocked') {
        // La ruta del schedule esta bloqueada (nginx 444). Reintentar seguido no sirve.
        // Curva propia, mas larga que la de cuenta: 240m -> 480m -> 720m (tope 12h).
        // Reemplaza a la auto-pausa que se quito el 2026-08-30. Fuente unica en scheduling.ts,
        // compartida con la compuerta de ensure-chain.
        delay = scheduleBlockedBackoffDelay(sustainedAccountBanCount);
      } else if (tcpBlockNotified && blockCls === 'account_ban') {
        // Account-level ban — provider-agnostic aggressive backoff. Rotating the
        // webshare pool does nothing (ban is on the account, not the IP), so webshare
        // and direct share one curve. Single source of truth in scheduling.ts, also
        // used by ensure-chain's resurrect gate so the guardian never re-polls early.
        delay = accountBanBackoffDelay(sustainedAccountBanCount);
      } else if (tcpBlockNotified && bot.proxyProvider === 'webshare') {
        // ip_ban / pool partially degraded — pool rotates IPs, 5min is fine
        delay = sustainedTcpBlockCount >= 3 ? '5m' : normalDelay;
      } else if (tcpBlockNotified) {
        // Transient / connection_reset (direct) — existing behavior
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
      logger.info('Self-rescheduling (chain)', { botId, chainId, delay, priority, ...(hadTransientError ? { tcpBlock: tcpBlockNotified, throttle: throttleNotified, blockCls, sustainedAccountBanCount } : {}) });

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
          .set({ ...runIdField, skippedPollsSinceLog: hb.skipped, updatedAt: new Date() })
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
          .set({ ...clearField, skippedPollsSinceLog: hb.skipped, updatedAt: new Date() } as Record<string, unknown>)
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
  trackerSize?: number;
  allDates?: Array<{date: string, business_day: boolean}>;
  chainId?: string;
  pollPhase?: string;
  fetchIndex?: number;
  runId?: string;
  publicIp?: string | null;
  dateChanges?: { appeared: string[], disappeared: string[] } | null;
  banPhase?: 'trigger' | 'sustained' | 'recovery' | null;
  connectionInfo?: {
    proxyAttemptIp?: string | null;
    fallbackReason?: string;
    websharePoolSize?: number;
    errorSource?: 'proxy_infra' | 'embassy_block' | 'proxy_quota';
    tcpSubcategory?: 'socket_immediate_close' | 'pool_exhausted' | 'connection_reset' | 'connection_timeout' | 'dns_fail' | 'proxy_tunnel_fail' | 'connection_refused';
    poolExhausted?: boolean;
    socketBytesRead?: number;
    blockClassification?: BlockClassification;
    sessionAgeMs?: number;
    pollRateRecentPerMin?: number;
  } | null;
}

function captureConnInfo(meta: ProxyFetchMeta, extra?: { sessionAgeMs?: number; pollRateRecentPerMin?: number }): LogPollExtra['connectionInfo'] {
  // Always return connectionInfo when there's any proxy metadata OR when we have enrichment data.
  // Previously only returned when proxyAttemptIp/websharePoolSize/poolExhausted was set,
  // causing 67% of tcp_blocked polls (especially direct provider) to have null connectionInfo.
  const hasProxyData = meta.proxyAttemptIp || meta.websharePoolSize > 0 || meta.poolExhausted;
  const hasErrorData = meta.errorSource !== null || meta.tcpSubcategory !== null || meta.socketBytesRead !== null;
  const hasExtraData = extra?.sessionAgeMs !== undefined || extra?.pollRateRecentPerMin !== undefined;

  if (!hasProxyData && !hasErrorData && !hasExtraData) return null;

  return {
    proxyAttemptIp: meta.proxyAttemptIp,
    fallbackReason: meta.fallbackReason || undefined,
    websharePoolSize: meta.websharePoolSize > 0 ? meta.websharePoolSize : undefined,
    errorSource: meta.errorSource ?? undefined,
    tcpSubcategory: meta.tcpSubcategory ?? undefined,
    poolExhausted: meta.poolExhausted || undefined,
    socketBytesRead: meta.socketBytesRead ?? undefined,
    // Always derive blockClassification when ANY classification data is available
    blockClassification: (meta.poolExhausted || meta.socketBytesRead !== null)
      ? deriveBlockClassification(meta) : undefined,
    sessionAgeMs: extra?.sessionAgeMs,
    pollRateRecentPerMin: extra?.pollRateRecentPerMin,
  };
}

/** Determine ban lifecycle phase for this poll based on current state. */
function getBanPhase(status: string, hasOpenBan: boolean): 'trigger' | 'sustained' | 'recovery' | null {
  if (status === 'tcp_blocked') return hasOpenBan ? 'sustained' : 'trigger';
  if (status === 'error') return null; // non-TCP errors are not ban-related
  // Success statuses (ok, filtered_out, soft_ban)
  return hasOpenBan ? 'recovery' : null;
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
  // Steady-state write reduction: when `heartbeat` is provided and this poll is a quiet 'ok'
  // within the heartbeat window, skip the INSERT and just count it (~94% fewer rows). Only the
  // normal path passes it — super-critical/burst always log every fetch. Uptime (5-min buckets) +
  // 30-min date trends are preserved because a row is written at least every HEARTBEAT_MS.
  // `heartbeat` is mutated: skips increment `skipped`, writes flush it into polls_since_prev.
  heartbeat?: HeartbeatState,
  // El reloj va SEPARADO del heartbeat a proposito. `heartbeat` decide si la fila
  // se escribe, y las rutas de rafaga no lo reciben porque tienen que escribir
  // siempre. Si la ceguera se midiera con `heartbeat`, esas rutas quedarian sin
  // medir, y son justo las de error y bloqueo, donde la ceguera importa mas.
  reloj?: Pick<HeartbeatState, 'lastPolledAt'>,
): void {
  const now = Date.now();
  const marcador = reloj ?? heartbeat;
  const blindMs = marcador?.lastPolledAt ? now - marcador.lastPolledAt.getTime() : null;
  if (marcador) marcador.lastPolledAt = new Date(now);
  if (
    heartbeat &&
    shouldSkipHeartbeatPoll(
      {
        status,
        pollPhase: extra?.pollPhase,
        rescheduleResult,
        reloginHappened: extra?.reloginHappened,
        banPhase: extra?.banPhase,
        dateChanges: extra?.dateChanges,
      },
      heartbeat.lastLoggedAt,
      now,
    )
  ) {
    heartbeat.skipped++; // counted, not logged — flushed into the next written row's polls_since_prev
    return;
  }
  // This row stands for itself + every quiet poll skipped since the last written row (exact count).
  let pollsSincePrev = 1;
  if (heartbeat) {
    pollsSincePrev = 1 + heartbeat.skipped;
    heartbeat.skipped = 0;
    heartbeat.lastLoggedAt = new Date(now);
  }
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
      banPhase: extra?.banPhase ?? null,
      connectionInfo: extra?.connectionInfo ?? null,
      pollsSincePrev,
      blindMs,
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

/** Persist date sightings to date_sightings table (fire-and-forget).
 *  Only stores dates strictly before currentConsularDate (actual improvements). */
function persistDateSightings(
  pending: Promise<unknown>[],
  botId: number,
  dateChanges: { appeared: string[], disappeared: string[] } | null,
  currentConsularDate: string | null,
  targetDateBefore: string | null,
): void {
  if (!dateChanges) return;
  // Filter: improvements (before appointment) + dates up to 3 months after appointment
  const cutoff = targetDateBefore ?? currentConsularDate;
  const filter = (dates: string[]) => {
    if (!cutoff) return dates;
    const cutoffMs = new Date(cutoff).getTime();
    const maxMs = cutoffMs + 90 * 864e5; // 3 months after appointment
    return dates.filter(d => new Date(d).getTime() <= maxMs);
  };
  const appeared = filter(dateChanges.appeared);
  const disappeared = filter(dateChanges.disappeared);
  if (appeared.length === 0 && disappeared.length === 0) return;

  // Compute daysFromNow relative to Bogota time
  const nowBog = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const todayMs = new Date(nowBog.getFullYear(), nowBog.getMonth(), nowBog.getDate()).getTime();
  function daysFr(ds: string): number {
    const [y, m, d] = ds.split('-').map(Number) as [number, number, number];
    return Math.round((new Date(y, m - 1, d).getTime() - todayMs) / 864e5);
  }

  // Use ISO string to ensure UTC regardless of server timezone (RPi may be UTC-5)
  const nowIso = new Date().toISOString();

  if (appeared.length > 0) {
    pending.push(
      db.execute(sql`
        INSERT INTO date_sightings (bot_id, date, appeared_at, days_from_now)
        VALUES ${sql.join(appeared.map(date =>
          sql`(${botId}, ${date}, ${nowIso}::timestamp, ${daysFr(date)})`
        ), sql`, `)}
      `).catch(e => logger.error('dateSighting insert failed', { error: String(e) })),
    );
  }

  if (disappeared.length > 0) {
    // Update the most recent open sighting for each disappeared date
    for (const date of disappeared) {
      pending.push(
        db.execute(sql`
          UPDATE date_sightings
          SET disappeared_at = ${nowIso}::timestamp,
              duration_ms = EXTRACT(EPOCH FROM (${nowIso}::timestamp - appeared_at)) * 1000
          WHERE id = (
            SELECT id FROM date_sightings
            WHERE bot_id = ${botId} AND date = ${date} AND disappeared_at IS NULL
            ORDER BY appeared_at DESC LIMIT 1
          )
        `).catch(e => logger.error('dateSighting update failed', { error: String(e) })),
      );
    }
  }
}

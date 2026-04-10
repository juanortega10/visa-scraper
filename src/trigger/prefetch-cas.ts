import { schedules, logger } from '@trigger.dev/sdk/v3';
import { notifyUserTask } from './notify-user.js';
import { db } from '../db/client.js';
import { bots, sessions, casPrefetchLogs } from '../db/schema.js';
import type { CasCacheData, CasCacheEntry, CasSlotChange, PrefetchReliability, DateFailureEntry } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { decrypt, encrypt } from '../services/encryption.js';
import { VisaClient, SessionExpiredError } from '../services/visa-client.js';
import { performLogin, InvalidCredentialsError } from '../services/login.js';
import { clearOnCasAvailable, isBlocked } from '../services/date-failure-tracker.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Returns active (non-expired) blockedConsularDates from existing cache. */
function getActiveBlockedConsularDates(existing: CasCacheData | null): Record<string, string> {
  if (!existing?.blockedConsularDates) return {};
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(existing.blockedConsularDates).filter(([, until]) => new Date(until).getTime() > now),
  );
}

/**
 * CAS Prefetch — scheduled cron (every 30 min, PRODUCTION only).
 *
 * Runs from Trigger.dev cloud so it doesn't consume the RPi/dev request budget.
 * Loops through all active bots and discovers real CAS dates via getCasDays(),
 * then fetches getCasTimes() for each. Saves to bots.casCacheJson.
 *
 * Algorithm per bot:
 * 1. getConsularDays() -> get a valid consular time from any real date
 * 2. Generate probe dates every ~5 days across [today+5, today+WINDOW+10]
 * 3. For each probe: getCasDays(probeDate, consularTime) -> discover CAS dates
 * 4. Filter discovered CAS dates to [today, today+WINDOW]
 * 5. For each CAS date: getCasTimes() -> slots + times
 */
export const prefetchCasSchedule = schedules.task({
  id: 'prefetch-cas',
  cron: {
    pattern: '*/30 * * * *',
    environments: ['PRODUCTION'],
  },
  machine: { preset: 'micro' },
  maxDuration: 240,

  run: async () => {
    // SELECT only needed columns — casCacheJson needed for dedup + diff
    const activeBots = await db.select({
      id: bots.id, status: bots.status, locale: bots.locale,
      scheduleId: bots.scheduleId, applicantIds: bots.applicantIds,
      consularFacilityId: bots.consularFacilityId, ascFacilityId: bots.ascFacilityId,
      proxyProvider: bots.proxyProvider, userId: bots.userId,
      visaEmail: bots.visaEmail, visaPassword: bots.visaPassword,
      casCacheJson: bots.casCacheJson,
      skipCas: bots.skipCas,
      currentConsularDate: bots.currentConsularDate,
    }).from(bots).where(eq(bots.status, 'active'));
    logger.info('prefetch-cas cron START', { botCount: activeBots.length });

    if (activeBots.length === 0) {
      logger.info('No active bots, skipping');
      return;
    }

    for (const bot of activeBots) {
      // Skip bots that don't require a CAS appointment (no ASC facility or skipCas)
      if (!bot.ascFacilityId || bot.ascFacilityId === '') {
        logger.info('Skipping bot without ASC facility', { botId: bot.id, locale: bot.locale });
        continue;
      }
      if (bot.skipCas) {
        logger.info('Skipping bot with skipCas=true', { botId: bot.id });
        continue;
      }

      let result: PrefetchResult;
      try {
        result = await prefetchForBot(bot);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('prefetch-cas failed for bot', { botId: bot.id, error: errMsg });
        result = { updated: false, reason: `exception: ${errMsg}` };
      }

      // Notify if cache is stale (>30 min) and this run failed to update it.
      // Deduped to once per hour via idempotencyKey.
      if (!result.updated) {
        const cache = bot.casCacheJson as CasCacheData | null;
        const cacheAgeMin = cache?.refreshedAt
          ? Math.round((Date.now() - new Date(cache.refreshedAt).getTime()) / 60000)
          : Infinity;

        if (cacheAgeMin > 30) {
          const hourKey = new Date().toISOString().slice(0, 13); // "2026-02-12T03"
          logger.warn('CAS cache stale, notifying', { botId: bot.id, cacheAgeMin, reason: result.reason });
          await notifyUserTask.trigger({
            botId: bot.id,
            event: 'cas_prefetch_failed',
            data: { reason: result.reason, cacheAgeMin },
          }, {
            tags: [`bot:${bot.id}`],
            idempotencyKey: `cas-stale-${bot.id}-${hourKey}`,
          }).catch((e) => logger.error('stale notify failed', { error: String(e) }));
        }
      }
    }

    logger.info('prefetch-cas cron DONE', { botCount: activeBots.length });
  },
});

interface PrefetchResult {
  updated: boolean;
  reason?: string;
}

interface PrefetchBot {
  id: number;
  locale: string;
  scheduleId: string;
  applicantIds: string[];
  consularFacilityId: string;
  ascFacilityId: string;
  proxyProvider: string;
  userId: string | null;
  visaEmail: string;
  visaPassword: string;
  casCacheJson: CasCacheData | null;
  currentConsularDate: string | null;
}

export async function prefetchForBot(bot: PrefetchBot): Promise<PrefetchResult> {
  const botId = bot.id;
  const startMs = Date.now();
  let requestCount = 0; // declare early so logAndReturn can capture it
  logger.info('prefetch-cas bot START', { botId });

  /** Write a failure log entry and return the result. */
  const logAndReturn = async (reason: string): Promise<PrefetchResult> => {
    const durationMs = Date.now() - startMs;
    await db.insert(casPrefetchLogs).values({
      botId, totalDates: 0, fullDates: 0, lowDates: 0,
      durationMs, requestCount, error: reason,
    }).catch((e) => logger.warn('Failed to write prefetch failure log', { botId, error: String(e) }));
    return { updated: false, reason };
  };

  // Dedup: skip if cache was refreshed recently (another run or manual trigger)
  const existingCache = bot.casCacheJson as CasCacheData | null;
  if (existingCache?.refreshedAt) {
    const cacheAgeMin = (Date.now() - new Date(existingCache.refreshedAt).getTime()) / 60000;
    if (cacheAgeMin < 10) {
      logger.info('Cache fresh, skipping', { botId, cacheAgeMin: Math.round(cacheAgeMin) });
      return { updated: true }; // cache is fine, no alert needed — don't log as failure
    }
  }

  const [session] = await db.select({
    yatriCookie: sessions.yatriCookie,
    csrfToken: sessions.csrfToken,
    authenticityToken: sessions.authenticityToken,
    createdAt: sessions.createdAt,
  }).from(sessions).where(eq(sessions.botId, botId));
  if (!session) {
    logger.warn('No session, skipping', { botId });
    return logAndReturn('no_session');
  }

  let cookie: string;
  try {
    cookie = decrypt(session.yatriCookie);
  } catch (e) {
    logger.error('Failed to decrypt session', { botId, error: String(e) });
    return logAndReturn('decrypt_failed');
  }

  // Pre-emptive re-login: if session > 44 min, login inline from cloud
  const RE_LOGIN_THRESHOLD_MIN = 44;
  const sessionAgeMin = Math.round((Date.now() - session.createdAt.getTime()) / 60000);
  if (sessionAgeMin > RE_LOGIN_THRESHOLD_MIN) {
    logger.info('Session old, attempting inline re-login from cloud', { botId, sessionAgeMin });
    try {
      let email: string, password: string;
      try {
        email = decrypt(bot.visaEmail);
        password = decrypt(bot.visaPassword);
      } catch (e) {
        logger.error('Failed to decrypt credentials', { botId, error: String(e) });
        return logAndReturn('decrypt_creds_failed');
      }

      const creds = {
        email,
        password,
        scheduleId: bot.scheduleId,
        applicantIds: bot.applicantIds,
        locale: bot.locale ?? 'es-co',
      };
      const loginResult = await performLogin(creds);
      cookie = loginResult.cookie;

      // Update session in DB
      const newSessionData: Record<string, unknown> = {
        yatriCookie: encrypt(loginResult.cookie),
        createdAt: new Date(),
        lastUsedAt: new Date(),
      };
      if (loginResult.hasTokens) {
        newSessionData.csrfToken = loginResult.csrfToken;
        newSessionData.authenticityToken = loginResult.authenticityToken;
      }
      await db.update(sessions).set(newSessionData).where(eq(sessions.botId, botId));
      // Update in-memory session variables so VisaClient uses fresh tokens
      if (loginResult.hasTokens) {
        session.csrfToken = loginResult.csrfToken;
        session.authenticityToken = loginResult.authenticityToken;
      }
      logger.info('Inline re-login OK', { botId, cookieLen: cookie.length, hasTokens: loginResult.hasTokens });
    } catch (e) {
      if (e instanceof InvalidCredentialsError) {
        logger.error('Invalid credentials during prefetch re-login', { botId });
        return logAndReturn('invalid_credentials');
      }
      logger.warn('Inline re-login failed, continuing with existing session', {
        botId,
        sessionAgeMin,
        error: e instanceof Error ? e.message : String(e),
      });
      // Non-fatal: try with existing session anyway
    }
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
      // prefetch-cas always runs from cloud — force direct regardless of bot config
      proxyProvider: 'direct',
      userId: bot.userId,
      locale: bot.locale,
    },
  );

  const WINDOW_DAYS = 30;
  const MAX_CONSULAR_PROBES = 5;   // max earlier consular dates to probe
  const MAX_REQUESTS = 45;

  const entries: CasCacheEntry[] = [];
  // requestCount declared at top of function (needed by logAndReturn)
  let errorCount = 0;
  const failedProbes: string[] = [];
  const failedTimeFetches: string[] = [];

  // -- Phase 1: Get real consular dates and pick probes --
  let consularDays;
  try {
    consularDays = await client.getConsularDays();
    requestCount++;
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      logger.error('Session expired fetching consular days', { botId });
      return logAndReturn('session_expired');
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to fetch consular days', { botId, error: errMsg });
    return logAndReturn(`fetch_error: ${errMsg}`);
  }

  logger.info('Consular days', { botId, total: consularDays.length, first: consularDays[0]?.date });

  // Prefer consular dates earlier than bot's current appointment (what it would reschedule to).
  // Fallback to first 3 consular dates if none are earlier (general cache).
  const currentConsular = bot.currentConsularDate;
  const earlierDates = currentConsular
    ? consularDays.filter(d => d.date < currentConsular)
    : [];
  const probeDates = earlierDates.length > 0
    ? earlierDates.slice(0, MAX_CONSULAR_PROBES)
    : consularDays.slice(0, 3);

  logger.info('Consular probes', {
    botId, currentConsular, earlierCount: earlierDates.length,
    probeCount: probeDates.length, probeDates: probeDates.map(d => d.date),
  });

  if (probeDates.length === 0) {
    logger.warn('No consular dates to probe, aborting', { botId });
    return logAndReturn('no_consular_dates');
  }

  // -- Phase 2: For each probe consular date, get times + CAS days + CAS times --
  const todayStr = new Date().toISOString().split('T')[0]!;
  const seenCasDates = new Set<string>(); // dedup across consular probes

  for (const probeDay of probeDates) {
    if (requestCount >= MAX_REQUESTS) {
      logger.warn('Request budget exhausted', { botId, requestCount });
      break;
    }

    // Get consular times for this date
    let consularTimes: string[];
    try {
      const timesData = await client.getConsularTimes(probeDay.date);
      requestCount++;
      consularTimes = timesData.available_times ?? [];
    } catch (err) {
      requestCount++;
      if (err instanceof SessionExpiredError) {
        logger.error('Session expired fetching consular times', { botId });
        break;
      }
      failedProbes.push(probeDay.date);
      errorCount++;
      logger.warn('getConsularTimes failed', { botId, date: probeDay.date, error: err instanceof Error ? err.message : String(err) });
      await sleep(3000);
      continue;
    }

    if (consularTimes.length === 0) {
      logger.info(`No consular times for ${probeDay.date}, skip`, { botId });
      await sleep(3000);
      continue;
    }

    // Use first available time as representative
    const probeTime = consularTimes[0]!;

    // Get CAS days for this specific consular date+time
    let casDays;
    try {
      casDays = await client.getCasDays(probeDay.date, probeTime);
      requestCount++;
    } catch (err) {
      requestCount++;
      if (err instanceof SessionExpiredError) {
        logger.error('Session expired during CAS discovery', { botId });
        break;
      }
      failedProbes.push(probeDay.date);
      errorCount++;
      logger.warn(`getCasDays error for ${probeDay.date}`, { botId, error: err instanceof Error ? err.message : String(err) });
      await sleep(3000);
      continue;
    }

    const validCasDays = casDays.filter(d => d.date >= todayStr && !seenCasDates.has(d.date));
    logger.info(`getCasDays(${probeDay.date}, ${probeTime}): ${casDays.length} total, ${validCasDays.length} new valid`, { botId });

    // Fetch CAS times for each discovered date WITH consular context
    for (const casDay of validCasDays) {
      if (requestCount >= MAX_REQUESTS) break;
      seenCasDates.add(casDay.date);
      try {
        const timesData = await client.getCasTimes(casDay.date, probeDay.date, probeTime);
        requestCount++;
        const times = timesData.available_times ?? [];
        entries.push({ date: casDay.date, slots: times.length, times, forConsularDate: probeDay.date, forConsularTime: probeTime });
        logger.info(`CAS ${casDay.date} (for ${probeDay.date}@${probeTime}): ${times.length} slots`, { botId });
      } catch (err) {
        requestCount++;
        if (err instanceof SessionExpiredError) break;
        errorCount++;
        failedTimeFetches.push(casDay.date);
        entries.push({ date: casDay.date, slots: -1, times: [], forConsularDate: probeDay.date, forConsularTime: probeTime });
        logger.warn(`CAS ${casDay.date}: error`, { botId, error: err instanceof Error ? err.message : String(err) });
      }
      await sleep(3000);
    }

    if (validCasDays.length === 0) {
      logger.info(`No CAS days for consular ${probeDay.date}@${probeTime}`, { botId });
    }

    await sleep(3000);
  }

  logger.info('CAS discovery done', { botId, totalEntries: entries.length, requestCount });

  if (entries.length === 0) {
    const durationMs = Date.now() - startMs;
    // Don't overwrite good cache with empty results (likely soft ban or transient error)
    if (existingCache && existingCache.entries.length > 0) {
      logger.warn('No CAS dates found but existing cache has data — keeping old cache', {
        botId, existingEntries: existingCache.entries.length, requestCount,
      });
      await db.insert(casPrefetchLogs).values({ botId, totalDates: 0, fullDates: 0, lowDates: 0, durationMs, requestCount, error: 'empty_result_kept_old_cache' });
      return { updated: false, reason: 'empty_result_kept_old_cache' };
    }
    logger.info('No CAS dates found, saving empty cache', { botId });
    // Use jsonb merge (||) to update only metadata fields — preserves blockedConsularDates
    // and dateFailureTracking already in the DB (written by poll-visa via jsonb_set).
    // A full db.update replacement would wipe those fields even if poll-visa just wrote them.
    const emptyMeta = {
      refreshedAt: new Date().toISOString(),
      windowDays: WINDOW_DAYS,
      totalDates: 0,
      fullDates: 0,
      entries: [] as CasCacheEntry[],
    };
    await Promise.all([
      db.execute(sql`
        UPDATE bots SET
          cas_cache_json = COALESCE(cas_cache_json, '{}'::jsonb) || ${JSON.stringify(emptyMeta)}::jsonb,
          updated_at = NOW()
        WHERE id = ${botId}
      `),
      db.insert(casPrefetchLogs).values({ botId, totalDates: 0, fullDates: 0, lowDates: 0, durationMs, requestCount }),
    ]);
    return { updated: true };
  }

  // -- Phase 5: Compute diff, persist cache + log --
  const fullDates = entries.filter((e) => e.slots === 0).length;
  const lowDates = entries.filter((e) => e.slots > 0 && e.slots <= 10).length;
  const durationMs = Date.now() - startMs;

  // Build reliability metadata
  const totalApiCalls = requestCount;
  const failedCalls = failedProbes.length + failedTimeFetches.length;
  const successfulCalls = totalApiCalls - failedCalls;
  const failureRate = totalApiCalls > 0 ? failedCalls / totalApiCalls : 0;
  const reliability: PrefetchReliability = {
    totalApiCalls,
    successfulCalls,
    failedCalls,
    failureRate: Math.round(failureRate * 1000) / 1000,
    reliable: failureRate < 0.3,
    failedProbes,
    failedTimeFetches,
  };

  // Compute changes between old and new cache
  const failedDates = new Set(failedTimeFetches);
  const changes = computeCasChanges(existingCache?.entries ?? [], entries, failedDates, reliability.reliable);

  // CAS escape hatch: clear tracker entries for dates where fresh CAS is now available
  // This unblocks dates that the cross-poll tracker blocked but CAS has since freed up.
  const nowMs = Date.now();
  let trackerAfterEscape: Record<string, DateFailureEntry> = existingCache?.dateFailureTracking ?? {};
  const escapedDates: string[] = [];
  for (const cas of entries) {
    if (cas.slots <= 0) continue;
    const entry = trackerAfterEscape[cas.date];
    if (entry && isBlocked(entry, nowMs)) {
      trackerAfterEscape = clearOnCasAvailable(trackerAfterEscape, cas.date);
      escapedDates.push(cas.date);
    }
  }
  if (escapedDates.length > 0) {
    logger.info('CAS escape hatch: clearing tracker blocks', { botId, dates: escapedDates });
    for (const date of escapedDates) {
      logger.info('tracker.cleared', { botId, date, reason: 'cas_available' });
    }
    // Persist updated tracker via jsonb_set (separate from the main cache write below)
    await db.execute(sql`
      UPDATE bots SET cas_cache_json = jsonb_set(
        COALESCE(cas_cache_json, '{}'::jsonb),
        '{dateFailureTracking}',
        ${JSON.stringify(trackerAfterEscape)}::jsonb
      ) WHERE id = ${botId}
    `).catch(e => logger.warn('tracker escape write failed', { botId, error: String(e) }));
  }

  const activeBlocked2 = getActiveBlockedConsularDates(existingCache);
  const cacheData: CasCacheData = {
    refreshedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    totalDates: entries.length,
    fullDates,
    entries,
    ...(Object.keys(activeBlocked2).length > 0 ? { blockedConsularDates: activeBlocked2 } : {}),
    ...(Object.keys(trackerAfterEscape).length > 0 ? { dateFailureTracking: trackerAfterEscape } : {}),
  };

  await Promise.all([
    db.update(bots).set({ casCacheJson: cacheData, updatedAt: new Date() }).where(eq(bots.id, botId)),
    db.insert(casPrefetchLogs).values({
      botId,
      totalDates: entries.length,
      fullDates,
      lowDates,
      durationMs,
      requestCount,
      changesJson: changes.length > 0 ? changes : null,
      reliabilityJson: reliability,
      error: errorCount > 0 ? `${errorCount} dates failed` : null,
    }),
  ]);

  logger.info('prefetch-cas bot DONE', {
    botId,
    probes: probeDates.length,
    uniqueCasDates: seenCasDates.size,
    totalEntries: entries.length,
    fullDates,
    lowDates,
    requestCount,
    durationMs,
    changes: changes.length,
  });

  // Notify on slot changes (appeared/went_full/disappeared/slots_changed)
  if (changes.length > 0 && existingCache) {
    await notifyUserTask.trigger({
      botId,
      event: 'cas_slots_changed',
      data: {
        changes,
        totalDates: entries.length,
        fullDates,
        lowDates,
        reliability,
      },
    }, { tags: [`bot:${botId}`] }).catch((e) => logger.error('CAS change notify failed', { error: String(e) }));
  }

  // Notify if first run or CAS filling up
  const isFirstRun = !existingCache;
  let casFillingUp = false;
  if (existingCache?.entries) {
    const oldMap = new Map(existingCache.entries.map((e) => [e.date, e]));
    for (const entry of entries) {
      const old = oldMap.get(entry.date);
      if (old && old.slots > 0 && entry.slots === 0) {
        casFillingUp = true;
        break;
      }
    }
  }

  if (isFirstRun || casFillingUp) {
    const dangerEntries = entries
      .filter((e) => e.slots >= 0 && e.slots <= 10)
      .slice(0, 10);

    await notifyUserTask.trigger({
      botId,
      event: 'cas_prefetch_complete',
      data: {
        isFirstRun,
        casFillingUp,
        totalDates: entries.length,
        fullDates,
        lowDates,
        durationMs,
        dangerEntries,
      },
    }, { tags: [`bot:${botId}`] }).catch((e) => logger.error('CAS notify failed', { error: String(e) }));
  }

  return { updated: true };
}

/**
 * Compare old and new CAS cache entries to detect slot changes with time-level diffs.
 * - appeared: date had 0 slots (or didn't exist) → now has slots > 0
 * - went_full: date had slots > 0 → now has 0 slots
 * - disappeared: date existed in old cache with slots > 0 → not in new cache
 * - slots_changed: both old and new have slots > 0 but different count/times
 *
 * Each change includes addedTimes/removedTimes and a confidence level.
 */
function computeCasChanges(
  oldEntries: CasCacheEntry[],
  newEntries: CasCacheEntry[],
  failedDates: Set<string>,
  runReliable: boolean,
): CasSlotChange[] {
  const changes: CasSlotChange[] = [];
  const oldMap = new Map(oldEntries.map((e) => [e.date, e]));
  const newMap = new Map(newEntries.map((e) => [e.date, e]));

  function getConfidence(date: string): 'high' | 'low' | 'error' {
    if (failedDates.has(date)) return 'error';
    if (!runReliable) return 'low';
    return 'high';
  }

  // Check new entries against old
  for (const entry of newEntries) {
    const old = oldMap.get(entry.date);
    const oldTimes = new Set(old?.times ?? []);
    const newTimes = new Set(entry.times ?? []);

    if (!old || old.slots <= 0) {
      // Didn't exist or was FULL/error → now has slots
      if (entry.slots > 0) {
        changes.push({
          date: entry.date, type: 'appeared',
          oldSlots: old?.slots ?? -1, newSlots: entry.slots,
          addedTimes: entry.times ?? [],
          removedTimes: [],
          confidence: getConfidence(entry.date),
        });
      }
    } else if (old.slots > 0 && entry.slots === 0) {
      // Had slots → now FULL
      changes.push({
        date: entry.date, type: 'went_full',
        oldSlots: old.slots, newSlots: 0,
        addedTimes: [],
        removedTimes: old.times ?? [],
        confidence: getConfidence(entry.date),
      });
    } else if (old.slots > 0 && entry.slots > 0 && old.slots !== entry.slots) {
      // Both have slots but count changed → slots_changed with time diff
      const added = (entry.times ?? []).filter((t) => !oldTimes.has(t));
      const removed = (old.times ?? []).filter((t) => !newTimes.has(t));
      changes.push({
        date: entry.date, type: 'slots_changed',
        oldSlots: old.slots, newSlots: entry.slots,
        addedTimes: added,
        removedTimes: removed,
        confidence: getConfidence(entry.date),
      });
    }
  }

  // Check for dates that disappeared (were in old with slots > 0, not in new)
  for (const old of oldEntries) {
    if (old.slots > 0 && !newMap.has(old.date)) {
      changes.push({
        date: old.date, type: 'disappeared',
        oldSlots: old.slots, newSlots: -1,
        addedTimes: [],
        removedTimes: old.times ?? [],
        confidence: getConfidence(old.date),
      });
    }
  }

  changes.sort((a, b) => a.date.localeCompare(b.date));
  return changes;
}

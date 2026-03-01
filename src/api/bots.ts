import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { bots, excludedDates, excludedTimes, sessions, pollLogs, authLogs } from '../db/schema.js';
import type { CasCacheData } from '../db/schema.js';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { encrypt, decrypt } from '../services/encryption.js';
import { logAuth } from '../utils/auth-logger.js';
import { pureFetchLogin, InvalidCredentialsError, discoverAccount } from '../services/login.js';
import type { DiscoverResult } from '../services/login.js';
import { pollVisaTask } from '../trigger/poll-visa.js';
import { getPollingDelay } from '../services/scheduling.js';
import { clerkAuth } from '../middleware/clerk-auth.js';
import { isValidLocale, VALID_LOCALES, resolveLocale, MAX_SCOUTS_PER_FACILITY } from '../utils/constants.js';
import { runs } from '@trigger.dev/sdk/v3';

export const botsRouter = new Hono();


function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string | null {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}

// ── Country-specific defaults for new bots ───────────────
const COUNTRY_DEFAULTS: Record<string, { maxReschedules?: number; targetDateBefore?: string }> = {
  pe: { maxReschedules: 1, targetDateBefore: '2026-04-01' },
};

// ── Discovery token cache (in-memory, 5 min TTL) ────────

interface DiscoveryCache {
  result: DiscoverResult;
  expiresAt: number;
}

const discoveryTokens = new Map<string, DiscoveryCache>();

function cleanExpiredTokens(): void {
  const now = Date.now();
  for (const [key, entry] of discoveryTokens) {
    if (entry.expiresAt < now) discoveryTokens.delete(key);
  }
}

// ── Validation helpers ─────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const DIGITS_RE = /^\d+$/;
const VALID_PROXY_PROVIDERS = ['direct', 'brightdata', 'webshare'];

function validateExclusions(body: Record<string, unknown>): string | null {
  if (body.excludedDateRanges !== undefined) {
    if (!Array.isArray(body.excludedDateRanges)) return 'excludedDateRanges must be an array';
    for (const r of body.excludedDateRanges) {
      if (!r.startDate || !DATE_RE.test(r.startDate)) return 'excludedDateRanges[].startDate must be YYYY-MM-DD';
      if (!r.endDate || !DATE_RE.test(r.endDate)) return 'excludedDateRanges[].endDate must be YYYY-MM-DD';
      if (r.startDate > r.endDate) return `excludedDateRanges: startDate (${r.startDate}) must be <= endDate (${r.endDate})`;
    }
  }
  if (body.excludedTimeRanges !== undefined) {
    if (!Array.isArray(body.excludedTimeRanges)) return 'excludedTimeRanges must be an array';
    for (const r of body.excludedTimeRanges) {
      if (r.date !== undefined && r.date !== null && !DATE_RE.test(r.date)) return 'excludedTimeRanges[].date must be YYYY-MM-DD if provided';
      if (!r.timeStart || !TIME_RE.test(r.timeStart)) return 'excludedTimeRanges[].timeStart must be HH:MM';
      if (!r.timeEnd || !TIME_RE.test(r.timeEnd)) return 'excludedTimeRanges[].timeEnd must be HH:MM';
      if (r.timeStart >= r.timeEnd) return `excludedTimeRanges: timeStart (${r.timeStart}) must be before timeEnd (${r.timeEnd})`;
    }
  }
  return null;
}

function validateCreateBot(body: Record<string, unknown>): string | null {
  if (!body.visaEmail || typeof body.visaEmail !== 'string' || !EMAIL_RE.test(body.visaEmail))
    return 'visaEmail must be a valid email address';
  if (!body.visaPassword || typeof body.visaPassword !== 'string')
    return 'visaPassword is required';
  if (!body.scheduleId || typeof body.scheduleId !== 'string' || !DIGITS_RE.test(body.scheduleId))
    return 'scheduleId must be a non-empty string of digits';
  if (!Array.isArray(body.applicantIds) || body.applicantIds.length === 0 ||
      !body.applicantIds.every((id: unknown) => typeof id === 'string' && DIGITS_RE.test(id)))
    return 'applicantIds must be a non-empty array of digit strings';

  if (body.consularFacilityId !== undefined &&
      (typeof body.consularFacilityId !== 'string' || !DIGITS_RE.test(body.consularFacilityId)))
    return 'consularFacilityId must be a numeric string';
  if (body.ascFacilityId !== undefined &&
      (typeof body.ascFacilityId !== 'string' || (body.ascFacilityId !== '' && !DIGITS_RE.test(body.ascFacilityId))))
    return 'ascFacilityId must be a numeric string or empty';
  if (body.currentConsularDate && !DATE_RE.test(body.currentConsularDate as string))
    return 'currentConsularDate must be YYYY-MM-DD';
  if (body.currentConsularTime && !TIME_RE.test(body.currentConsularTime as string))
    return 'currentConsularTime must be HH:MM';
  if (body.currentCasDate && !DATE_RE.test(body.currentCasDate as string))
    return 'currentCasDate must be YYYY-MM-DD';
  if (body.currentCasTime && !TIME_RE.test(body.currentCasTime as string))
    return 'currentCasTime must be HH:MM';

  if (body.webhookUrl !== undefined && body.webhookUrl !== null) {
    try { new URL(body.webhookUrl as string); } catch {
      return 'webhookUrl must be a valid URL';
    }
  }

  return validateExclusions(body);
}

function validateUpdateBot(body: Record<string, unknown>): string | null {
  if (body.proxyProvider !== undefined && !VALID_PROXY_PROVIDERS.includes(body.proxyProvider as string))
    return `proxyProvider must be one of: ${VALID_PROXY_PROVIDERS.join(', ')}`;
  if (body.ascFacilityId !== undefined &&
      (typeof body.ascFacilityId !== 'string' || (body.ascFacilityId !== '' && !DIGITS_RE.test(body.ascFacilityId))))
    return 'ascFacilityId must be a numeric string or empty';
  if (body.consularFacilityId !== undefined &&
      (typeof body.consularFacilityId !== 'string' || !DIGITS_RE.test(body.consularFacilityId)))
    return 'consularFacilityId must be a numeric string';
  if (body.currentConsularDate !== undefined && body.currentConsularDate !== null &&
      !DATE_RE.test(body.currentConsularDate as string))
    return 'currentConsularDate must be YYYY-MM-DD';
  if (body.currentConsularTime !== undefined && body.currentConsularTime !== null &&
      !TIME_RE.test(body.currentConsularTime as string))
    return 'currentConsularTime must be HH:MM';
  if (body.currentCasDate !== undefined && body.currentCasDate !== null &&
      !DATE_RE.test(body.currentCasDate as string))
    return 'currentCasDate must be YYYY-MM-DD';
  if (body.currentCasTime !== undefined && body.currentCasTime !== null &&
      !TIME_RE.test(body.currentCasTime as string))
    return 'currentCasTime must be HH:MM';
  if (body.webhookUrl !== undefined && body.webhookUrl !== null) {
    try { new URL(body.webhookUrl as string); } catch {
      return 'webhookUrl must be a valid URL';
    }
  }
  if (body.pollEnvironments !== undefined) {
    if (!Array.isArray(body.pollEnvironments) ||
        !body.pollEnvironments.every((e: unknown) => e === 'dev' || e === 'prod'))
      return 'pollEnvironments must be an array of "dev" and/or "prod"';
  }
  return validateExclusions(body);
}

// ── Routes ─────────────────────────────────────────────────

// List all bots (summary for dashboard)
botsRouter.get('/', async (c) => {
  const allBots = await db
    .select({
      id: bots.id,
      locale: bots.locale,
      status: bots.status,
      isScout: bots.isScout,
      isSubscriber: bots.isSubscriber,
      currentConsularDate: bots.currentConsularDate,
      currentConsularTime: bots.currentConsularTime,
      currentCasDate: bots.currentCasDate,
      currentCasTime: bots.currentCasTime,
      consularFacilityId: bots.consularFacilityId,
      consecutiveErrors: bots.consecutiveErrors,
      targetDateBefore: bots.targetDateBefore,
      maxReschedules: bots.maxReschedules,
      rescheduleCount: bots.rescheduleCount,
      createdAt: bots.createdAt,
    })
    .from(bots)
    .orderBy(bots.id);
  return c.json(allBots);
});

// List bots for authenticated Clerk user (frontend)
botsRouter.get('/me', clerkAuth({ required: true }), async (c) => {
  const clerkUser = c.get('clerkUser')!;
  const userBots = await db
    .select({
      id: bots.id,
      status: bots.status,
      isScout: bots.isScout,
      isSubscriber: bots.isSubscriber,
      visaEmail: bots.visaEmail,
      scheduleId: bots.scheduleId,
      consularFacilityId: bots.consularFacilityId,
      locale: bots.locale,
      currentConsularDate: bots.currentConsularDate,
      currentConsularTime: bots.currentConsularTime,
      currentCasDate: bots.currentCasDate,
      currentCasTime: bots.currentCasTime,
      createdAt: bots.createdAt,
    })
    .from(bots)
    .where(eq(bots.clerkUserId, clerkUser.clerkUserId))
    .orderBy(desc(bots.createdAt));

  return c.json({
    bots: userBots.map((b) => ({
      ...b,
      visaEmail: (() => { try { return decrypt(b.visaEmail); } catch { return null; } })(),
    })),
  });
});

// Get supported countries (for frontend country picker)
// Returns { code, country }[] — frontend sends `code` (2-letter) to API
botsRouter.get('/countries', (c) => {
  const byCountry = new Map<string, string>(); // countryCode → countryName
  for (const [locale, country] of Object.entries(VALID_LOCALES)) {
    const cc = locale.split('-')[1]!;
    if (!byCountry.has(cc)) byCountry.set(cc, country);
  }
  const countries = [...byCountry.entries()]
    .map(([code, country]) => ({ code, country }))
    .sort((a, b) => a.country.localeCompare(b.country));
  return c.json(countries);
});

// Create bot
botsRouter.post('/', clerkAuth({ required: false }), async (c) => {
  const body = await c.req.json();

  const validationError = validateCreateBot(body);
  if (validationError) return c.json({ error: validationError }, 400);

  const {
    visaEmail,
    visaPassword,
    scheduleId,
    applicantIds,
    consularFacilityId = '25',
    ascFacilityId = '26',
    currentConsularDate,
    currentConsularTime,
    currentCasDate,
    currentCasTime,
    excludedDateRanges = [],
    excludedTimeRanges = [],
    webhookUrl,
    notificationEmail,
    ownerEmail,
    locale = 'es-co',
    clerkUserId,
    discoveryToken,
    targetDateBefore,
    maxReschedules,
  } = body;

  // Check if discoveryToken has a cached session we can reuse
  let cachedDiscovery: DiscoveryCache | undefined;
  if (discoveryToken && typeof discoveryToken === 'string') {
    cachedDiscovery = discoveryTokens.get(discoveryToken);
    if (cachedDiscovery && cachedDiscovery.expiresAt < Date.now()) {
      discoveryTokens.delete(discoveryToken);
      cachedDiscovery = undefined;
    }
    if (cachedDiscovery) {
      discoveryTokens.delete(discoveryToken); // one-time use
    }
  }

  // Validate credentials (skip if discoveryToken cached — already validated during discover)
  const clerkUser = c.get('clerkUser');
  console.log(`[create-bot] email=${visaEmail} locale=${locale} facility=${consularFacilityId} clerk=${clerkUser?.clerkUserId ?? 'anon'} discovery=${!!cachedDiscovery}`);
  if (!cachedDiscovery) {
    try {
      await pureFetchLogin(
        { email: visaEmail, password: visaPassword, scheduleId, applicantIds, locale: locale || 'es-co' },
        { skipTokens: true },
      );
      console.log(`[create-bot] creds OK email=${visaEmail}`);
    } catch (e: any) {
      if (e instanceof InvalidCredentialsError) {
        console.log(`[create-bot] INVALID creds email=${visaEmail}`);
        logAuth({ email: visaEmail, action: 'create_bot', locale, result: 'invalid', clerkUserId: clerkUser?.clerkUserId, ip: getClientIp(c) });
        return c.json({ error: 'invalid_credentials', message: e.message }, 400);
      }
      console.log(`[create-bot] login ERROR email=${visaEmail} err=${e instanceof Error ? e.message : e}`);
      logAuth({ email: visaEmail, action: 'create_bot', locale, result: 'error', errorMessage: e instanceof Error ? e.message : String(e), clerkUserId: clerkUser?.clerkUserId, ip: getClientIp(c) });
      return c.json({ error: 'login_failed', message: 'Could not validate credentials' }, 502);
    }
  }

  // Auto-assign scout: if facility has fewer scouts than MAX, become scout
  const scoutCount = await db.select({ count: sql<number>`count(*)::int` }).from(bots)
    .where(and(
      eq(bots.consularFacilityId, consularFacilityId),
      eq(bots.isScout, true),
      inArray(bots.status, ['active', 'login_required', 'paused']),
    ));
  const autoScout = (scoutCount[0]?.count ?? 0) < MAX_SCOUTS_PER_FACILITY;
  const [bot] = await db
    .insert(bots)
    .values({
      visaEmail: encrypt(visaEmail),
      visaPassword: encrypt(visaPassword),
      scheduleId,
      applicantIds,
      consularFacilityId,
      ascFacilityId,
      locale,
      targetDateBefore: targetDateBefore ?? COUNTRY_DEFAULTS[locale.split('-')[1] ?? '']?.targetDateBefore ?? null,
      maxReschedules: maxReschedules != null ? parseInt(maxReschedules, 10) : COUNTRY_DEFAULTS[locale.split('-')[1] ?? '']?.maxReschedules ?? null,
      currentConsularDate,
      currentConsularTime,
      currentCasDate,
      currentCasTime,
      webhookUrl,
      notificationEmail,
      ownerEmail,
      proxyProvider: 'direct',
      isScout: autoScout,
      isSubscriber: true,  // All new bots receive dispatches by default
      clerkUserId: c.get('clerkUser')?.clerkUserId || clerkUserId || null,
      // Scouts need login_required to start their poll chain
      // Pure subscribers are active immediately (no poll chain needed, dispatch handles them)
      status: autoScout ? 'login_required' : 'active',
      activatedAt: new Date(),
    })
    .returning();

  if (!bot) return c.json({ error: 'Failed to create bot' }, 500);

  // Log successful bot creation with botId
  logAuth({ email: visaEmail, action: 'create_bot', locale, result: 'ok', clerkUserId: clerkUser?.clerkUserId, ip: getClientIp(c), botId: bot.id });

  // Insert exclusions
  if (excludedDateRanges.length > 0) {
    await db.insert(excludedDates).values(
      excludedDateRanges.map((r: { startDate: string; endDate: string }) => ({
        botId: bot.id,
        startDate: r.startDate,
        endDate: r.endDate,
      })),
    );
  }

  if (excludedTimeRanges.length > 0) {
    await db.insert(excludedTimes).values(
      excludedTimeRanges.map((r: { date?: string; timeStart: string; timeEnd: string }) => ({
        botId: bot.id,
        date: r.date ?? null,
        timeStart: r.timeStart,
        timeEnd: r.timeEnd,
      })),
    );
  }

  // ── Auto-activate ────────────────────────────────────────
  // Scouts need a poll chain — start it automatically.
  // Pure subscribers are already active (no poll chain needed).
  if (autoScout) {
    let runId: string | undefined;

    if (cachedDiscovery) {
      // Reuse session from discover-account → activate immediately + start poll chain
      await db.insert(sessions).values({
        botId: bot.id,
        yatriCookie: encrypt(cachedDiscovery.result.cookie),
      });
      await db.update(bots)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(bots.id, bot.id));

      const handle = await pollVisaTask.trigger(
        { botId: bot.id },
        { delay: '3s', concurrencyKey: `poll-${bot.id}`, tags: [`bot:${bot.id}`] },
      );
      runId = handle.id;
      await db.update(bots).set({ activeRunId: handle.id, updatedAt: new Date() }).where(eq(bots.id, bot.id));

      return c.json({ id: bot.id, status: 'active', isScout: bot.isScout, isSubscriber: bot.isSubscriber, runId }, 201);
    } else {
      // No cached session → trigger login-visa to login from cloud + start poll chain
      const { loginVisaTask } = await import('../trigger/login-visa.js');
      const handle = await loginVisaTask.trigger({ botId: bot.id }, { tags: [`bot:${bot.id}`] });
      runId = handle.id;
      await db.update(bots).set({ activeRunId: handle.id, updatedAt: new Date() }).where(eq(bots.id, bot.id));

      return c.json({ id: bot.id, status: bot.status as string, isScout: bot.isScout, isSubscriber: bot.isSubscriber, runId }, 201);
    }
  }

  return c.json({ id: bot.id, status: bot.status as string, isScout: bot.isScout, isSubscriber: bot.isSubscriber }, 201);
});

// Validate credentials (must be before /:id routes)
botsRouter.post('/validate-credentials', async (c) => {
  const body = await c.req.json();
  const { email, password, country } = body;

  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return c.json({ error: 'email must be a valid email address' }, 400);
  }
  if (!password || typeof password !== 'string') {
    return c.json({ error: 'password is required' }, 400);
  }
  if (!country || typeof country !== 'string') {
    return c.json({ error: 'country is required (2-letter code, e.g. "co", "pe", "br")' }, 400);
  }
  const locale = resolveLocale(country);
  if (!locale) {
    return c.json({ error: `Unknown country '${country}'. Use GET /api/bots/countries for valid codes.` }, 400);
  }

  console.log(`[validate-credentials] email=${email} country=${country} locale=${locale}`);
  try {
    await pureFetchLogin(
      { email, password, scheduleId: '', applicantIds: [], locale },
      { skipTokens: true },
    );
    console.log(`[validate-credentials] OK email=${email}`);
    logAuth({ email, action: 'validate', locale, result: 'ok', ip: getClientIp(c) });
    return c.json({ valid: true });
  } catch (e) {
    if (e instanceof InvalidCredentialsError) {
      console.log(`[validate-credentials] INVALID email=${email}`);
      logAuth({ email, action: 'validate', locale, result: 'invalid', ip: getClientIp(c) });
      return c.json({ valid: false, message: 'invalid_credentials' });
    }
    console.log(`[validate-credentials] ERROR email=${email} err=${e instanceof Error ? e.message : e}`);
    logAuth({ email, action: 'validate', locale, result: 'error', errorMessage: e instanceof Error ? e.message : String(e), ip: getClientIp(c) });
    return c.json({ valid: false, message: 'service_unavailable' }, 503);
  }
});

// Discover account details (login + extract scheduleId, applicants, etc.)
botsRouter.post('/discover-account', clerkAuth({ required: false }), async (c) => {
  const body = await c.req.json();
  const { email, password, country } = body;

  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return c.json({ error: 'email must be a valid email address' }, 400);
  }
  if (!password || typeof password !== 'string') {
    return c.json({ error: 'password is required' }, 400);
  }
  if (!country || typeof country !== 'string') {
    return c.json({ error: 'country is required (2-letter code, e.g. "co", "pe", "br")' }, 400);
  }
  const locale = resolveLocale(country);
  if (!locale) {
    return c.json({ error: `Unknown country '${country}'. Use GET /api/bots/countries for valid codes.` }, 400);
  }

  const clerkUser = c.get('clerkUser');
  console.log(`[discover-account] email=${email} country=${country} locale=${locale} clerk=${clerkUser?.clerkUserId ?? 'anon'}`);
  try {
    const result = await discoverAccount(email, password, locale);

    // Store discovery result with a token for session reuse when creating bot
    cleanExpiredTokens();
    console.log(`[discover-account] OK email=${email} schedule=${result.scheduleId} applicants=${result.applicantIds.length} consular=${result.currentConsularDate}`);
    logAuth({ email, action: 'discover', locale, result: 'ok', clerkUserId: clerkUser?.clerkUserId, ip: getClientIp(c) });
    const discoveryToken = randomUUID();
    discoveryTokens.set(discoveryToken, {
      result,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
    });

    return c.json({
      discoveryToken,
      locale,
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
    });
  } catch (e) {
    if (e instanceof InvalidCredentialsError) {
      console.log(`[discover-account] INVALID email=${email}`);
      logAuth({ email, action: 'discover', locale, result: 'invalid', clerkUserId: clerkUser?.clerkUserId, ip: getClientIp(c) });
      return c.json({ error: 'invalid_credentials' }, 401);
    }
    console.error(`[discover-account] ERROR email=${email}`, e);
    logAuth({ email, action: 'discover', locale, result: 'error', errorMessage: e instanceof Error ? e.message : String(e), clerkUserId: clerkUser?.clerkUserId, ip: getClientIp(c) });
    return c.json({ error: 'discovery_failed', message: e instanceof Error ? e.message : 'Unknown error' }, 503);
  }
});

// Auth logs (global, not per-bot)
botsRouter.get('/auth-logs', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const logs = await db
    .select()
    .from(authLogs)
    .orderBy(desc(authLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json(logs.map((log) => ({
    ...log,
    email: (() => { try { return decrypt(log.email); } catch { return '[decrypt_failed]'; } })(),
  })));
});

// Get bot
botsRouter.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid bot ID' }, 400);
  // SELECT specific — casCacheJson loaded separately below for summary
  const [bot] = await db.select({
    id: bots.id, scheduleId: bots.scheduleId, locale: bots.locale,
    status: bots.status, isScout: bots.isScout, isSubscriber: bots.isSubscriber, proxyProvider: bots.proxyProvider,
    consularFacilityId: bots.consularFacilityId, ascFacilityId: bots.ascFacilityId,
    currentConsularDate: bots.currentConsularDate, currentConsularTime: bots.currentConsularTime,
    currentCasDate: bots.currentCasDate, currentCasTime: bots.currentCasTime,
    targetDateBefore: bots.targetDateBefore,
    maxReschedules: bots.maxReschedules, rescheduleCount: bots.rescheduleCount,
    consecutiveErrors: bots.consecutiveErrors,
    activeRunId: bots.activeRunId, activeCloudRunId: bots.activeCloudRunId,
    pollEnvironments: bots.pollEnvironments, cloudEnabled: bots.cloudEnabled,
    activatedAt: bots.activatedAt, createdAt: bots.createdAt, updatedAt: bots.updatedAt,
    casCacheJson: bots.casCacheJson,
  }).from(bots).where(eq(bots.id, id));
  if (!bot) return c.json({ error: 'Not found' }, 404);

  const [session] = await db
    .select({ createdAt: sessions.createdAt, lastUsedAt: sessions.lastUsedAt })
    .from(sessions)
    .where(eq(sessions.botId, id))
    .orderBy(desc(sessions.createdAt))
    .limit(1);

  const exDates = await db.select({
    startDate: excludedDates.startDate,
    endDate: excludedDates.endDate,
  }).from(excludedDates).where(eq(excludedDates.botId, id));

  // Scout info for subscriber-only bots
  let scoutInfo: { id: number; status: string; lastPollAt: string | null } | null = null;
  if (bot.isSubscriber && !bot.isScout) {
    const [scout] = await db
      .select({
        id: bots.id,
        status: bots.status,
      })
      .from(bots)
      .where(
        and(
          eq(bots.isScout, true),
          eq(bots.consularFacilityId, bot.consularFacilityId!),
          inArray(bots.status, ['active', 'login_required', 'paused']),
        ),
      )
      .limit(1);

    if (scout) {
      const [lastPoll] = await db
        .select({ createdAt: pollLogs.createdAt })
        .from(pollLogs)
        .where(eq(pollLogs.botId, scout.id))
        .orderBy(desc(pollLogs.createdAt))
        .limit(1);
      scoutInfo = {
        id: scout.id,
        status: scout.status as string,
        lastPollAt: lastPoll?.createdAt ? new Date(lastPoll.createdAt).toISOString() : null,
      };
    }
  }

  return c.json({
    id: bot.id,
    scheduleId: bot.scheduleId,
    locale: bot.locale,
    status: bot.status,
    isScout: bot.isScout,
    isSubscriber: bot.isSubscriber,
    proxyProvider: bot.proxyProvider,
    consularFacilityId: bot.consularFacilityId,
    ascFacilityId: bot.ascFacilityId,
    currentConsularDate: bot.currentConsularDate,
    currentConsularTime: bot.currentConsularTime,
    currentCasDate: bot.currentCasDate,
    currentCasTime: bot.currentCasTime,
    targetDateBefore: bot.targetDateBefore,
    maxReschedules: bot.maxReschedules,
    rescheduleCount: bot.rescheduleCount,
    consecutiveErrors: bot.consecutiveErrors,
    activeRunId: bot.activeRunId,
    activeCloudRunId: bot.activeCloudRunId,
    pollEnvironments: bot.pollEnvironments ?? ['dev'],
    cloudEnabled: bot.cloudEnabled,
    activatedAt: bot.activatedAt,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    sessionCreatedAt: session?.createdAt ?? null,
    excludedDateRanges: exDates,
    scoutInfo,
    casCache: (() => {
      const cache = bot.casCacheJson as CasCacheData | null;
      if (!cache) return null;
      const ageMin = Math.round((Date.now() - new Date(cache.refreshedAt).getTime()) / 60000);
      return {
        refreshedAt: cache.refreshedAt,
        ageMin,
        totalDates: cache.totalDates,
        fullDates: cache.fullDates,
        availableDates: cache.totalDates - cache.fullDates,
        entries: cache.entries ?? [],
      };
    })(),
  });
});

// Update bot config
botsRouter.put('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();

  const validationError = validateUpdateBot(body);
  if (validationError) return c.json({ error: validationError }, 400);

  const [existing] = await db.select({ id: bots.id }).from(bots).where(eq(bots.id, id));
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.webhookUrl !== undefined) updates.webhookUrl = body.webhookUrl;
  if (body.notificationEmail !== undefined) updates.notificationEmail = body.notificationEmail;
  if (body.ownerEmail !== undefined) updates.ownerEmail = body.ownerEmail;
  if (body.proxyProvider !== undefined) updates.proxyProvider = body.proxyProvider;
  if (body.proxyUrls !== undefined) updates.proxyUrls = body.proxyUrls;
  if (body.ascFacilityId !== undefined) updates.ascFacilityId = body.ascFacilityId;
  if (body.consularFacilityId !== undefined) updates.consularFacilityId = body.consularFacilityId;
  if (body.currentConsularDate !== undefined) updates.currentConsularDate = body.currentConsularDate;
  if (body.currentConsularTime !== undefined) updates.currentConsularTime = body.currentConsularTime;
  if (body.currentCasDate !== undefined) updates.currentCasDate = body.currentCasDate;
  if (body.currentCasTime !== undefined) updates.currentCasTime = body.currentCasTime;
  if (body.cloudEnabled !== undefined) updates.cloudEnabled = !!body.cloudEnabled;
  if (body.pollEnvironments !== undefined) updates.pollEnvironments = body.pollEnvironments;
  if (body.targetDateBefore !== undefined) updates.targetDateBefore = body.targetDateBefore;
  if (body.maxReschedules !== undefined) updates.maxReschedules = body.maxReschedules != null ? parseInt(body.maxReschedules, 10) : null;

  await db.update(bots).set(updates).where(eq(bots.id, id));

  // Replace exclusions if provided
  if (body.excludedDateRanges) {
    await db.delete(excludedDates).where(eq(excludedDates.botId, id));
    if (body.excludedDateRanges.length > 0) {
      await db.insert(excludedDates).values(
        body.excludedDateRanges.map((r: { startDate: string; endDate: string }) => ({
          botId: id,
          startDate: r.startDate,
          endDate: r.endDate,
        })),
      );
    }
  }

  if (body.excludedTimeRanges) {
    await db.delete(excludedTimes).where(eq(excludedTimes.botId, id));
    if (body.excludedTimeRanges.length > 0) {
      await db.insert(excludedTimes).values(
        body.excludedTimeRanges.map((r: { date?: string; timeStart: string; timeEnd: string }) => ({
          botId: id,
          date: r.date ?? null,
          timeStart: r.timeStart,
          timeEnd: r.timeEnd,
        })),
      );
    }
  }

  return c.json({ success: true });
});

// Activate bot — subscribers just go active, scouts get login + poll chain
botsRouter.post('/:id/activate', async (c) => {
  const id = parseInt(c.req.param('id'));
  const [bot] = await db.select({ id: bots.id, status: bots.status, isScout: bots.isScout, isSubscriber: bots.isSubscriber }).from(bots).where(eq(bots.id, id));
  if (!bot) return c.json({ error: 'Not found' }, 404);

  if (bot.status !== 'created' && bot.status !== 'error' && bot.status !== 'login_required' && bot.status !== 'paused') {
    return c.json({ error: `Cannot activate bot in '${bot.status}' state` }, 409);
  }

  // Pure subscribers (not scouts): just mark active (no poll chain — dispatch handles them)
  if (!bot.isScout) {
    await db.update(bots)
      .set({ status: 'active', consecutiveErrors: 0, activatedAt: new Date(), updatedAt: new Date() })
      .where(eq(bots.id, id));
    return c.json({ status: 'active', message: 'Subscriber activated (no poll chain)' });
  }

  // Scout: full login + poll chain activation
  // If bot already has a working session, skip login and go straight to active + poll
  if (bot.status === 'login_required') {
    const [session] = await db.select({ createdAt: sessions.createdAt }).from(sessions).where(eq(sessions.botId, id));
    const sessionAgeMin = session ? (Date.now() - session.createdAt.getTime()) / 60000 : Infinity;
    if (session && sessionAgeMin < 80) {
      // Session still valid — activate directly and re-trigger poll chain
      await db.update(bots)
        .set({ status: 'active', consecutiveErrors: 0, updatedAt: new Date() })
        .where(eq(bots.id, id));

      const handle = await pollVisaTask.trigger(
        { botId: id },
        { delay: '3s', concurrencyKey: `poll-${id}`, tags: [`bot:${id}`] },
      );

      await db.update(bots).set({ activeRunId: handle.id, updatedAt: new Date() }).where(eq(bots.id, id));

      return c.json({ status: 'active', pollRunId: handle.id, message: 'Session still valid, activated directly' });
    }
  }

  await db
    .update(bots)
    .set({ status: 'login_required', consecutiveErrors: 0, activatedAt: new Date(), updatedAt: new Date() })
    .where(eq(bots.id, id));

  // Trigger login-visa task to login from cloud and start poll chain
  const { loginVisaTask } = await import('../trigger/login-visa.js');
  const handle = await loginVisaTask.trigger({ botId: id }, { tags: [`bot:${id}`] });

  return c.json({ status: 'login_required', loginRunId: handle.id });
});

// Activate cloud — sets cloudEnabled=true, but does NOT trigger cloud chain.
// Cloud chain must be started via MCP prod trigger (runs created with dev key stay in dev env).
// Use: trigger poll-visa task in prod env with { botId, chainId: 'cloud' } via MCP.
botsRouter.post('/:id/activate-cloud', async (c) => {
  const id = parseInt(c.req.param('id'));
  const [bot] = await db.select({ id: bots.id, status: bots.status }).from(bots).where(eq(bots.id, id));
  if (!bot) return c.json({ error: 'Not found' }, 404);

  if (bot.status !== 'active') {
    return c.json({ error: `Bot must be active to enable cloud standby (current: ${bot.status})` }, 409);
  }

  await db.update(bots).set({ cloudEnabled: true, updatedAt: new Date() }).where(eq(bots.id, id));

  return c.json({ success: true, message: 'cloudEnabled set. Trigger cloud chain via MCP prod: poll-visa { botId, chainId: "cloud" }' });
});

// Pause bot
botsRouter.post('/:id/pause', async (c) => {
  const id = parseInt(c.req.param('id'));
  const [bot] = await db.select({
    id: bots.id, status: bots.status,
    activeRunId: bots.activeRunId, activeCloudRunId: bots.activeCloudRunId,
  }).from(bots).where(eq(bots.id, id));
  if (!bot) return c.json({ error: 'Not found' }, 404);

  // Fix 1: Only allow pausing active bots
  if (bot.status !== 'active' && bot.status !== 'login_required') {
    return c.json({ error: `Cannot pause bot in '${bot.status}' state` }, 409);
  }

  // Cancel both dev and cloud runs
  for (const runId of [bot.activeRunId, bot.activeCloudRunId]) {
    if (runId) {
      try { await runs.cancel(runId); } catch { /* already done */ }
    }
  }

  await db
    .update(bots)
    .set({ status: 'paused', activeRunId: null, activeCloudRunId: null, cloudEnabled: false, updatedAt: new Date() })
    .where(eq(bots.id, id));

  return c.json({ success: true });
});

// Resume bot
botsRouter.post('/:id/resume', async (c) => {
  const id = parseInt(c.req.param('id'));
  const [bot] = await db.select({ id: bots.id, status: bots.status, cloudEnabled: bots.cloudEnabled }).from(bots).where(eq(bots.id, id));
  if (!bot) return c.json({ error: 'Not found' }, 404);

  // Fix 1: Only allow resuming paused bots
  if (bot.status !== 'paused') {
    return c.json({ error: `Cannot resume bot in '${bot.status}' state` }, 409);
  }

  await db.update(bots).set({ status: 'active', updatedAt: new Date() }).where(eq(bots.id, id));

  // Trigger dev chain (cloud chain must be started separately via MCP prod trigger
  // because runs created with dev key can't be processed by prod worker)
  const handle = await pollVisaTask.trigger(
    { botId: id },
    {
      delay: getPollingDelay(),
      concurrencyKey: `poll-${id}`,
      tags: [`bot:${id}`],
    },
  );

  await db.update(bots).set({ activeRunId: handle.id, updatedAt: new Date() }).where(eq(bots.id, id));

  return c.json({
    pollRunId: handle.id,
    ...(bot.cloudEnabled ? { cloudNote: 'Cloud chain must be triggered via prod (MCP or activate-cloud from prod context)' } : {}),
  });
});

// Delete bot
botsRouter.delete('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const [bot] = await db.select({
    id: bots.id, activeRunId: bots.activeRunId, activeCloudRunId: bots.activeCloudRunId,
  }).from(bots).where(eq(bots.id, id));
  if (!bot) return c.json({ error: 'Not found' }, 404);

  // Cancel active runs (dev + cloud)
  for (const runId of [bot.activeRunId, bot.activeCloudRunId]) {
    if (runId) {
      try { await runs.cancel(runId); } catch { /* noop */ }
    }
  }

  // Cascade deletes handle related tables
  await db.delete(bots).where(eq(bots.id, id));

  return c.json({ success: true });
});

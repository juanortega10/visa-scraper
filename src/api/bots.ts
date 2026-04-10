import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { bots, excludedDates, excludedTimes, sessions, authLogs, rescheduleLogs, pollLogs } from '../db/schema.js';
import type { CasCacheData } from '../db/schema.js';
import { eq, and, desc, asc, gte, sql, isNotNull } from 'drizzle-orm';
import { encrypt, decrypt } from '../services/encryption.js';
import { logAuth } from '../utils/auth-logger.js';
import { pureFetchLogin, InvalidCredentialsError, discoverAccount } from '../services/login.js';
import type { DiscoverResult } from '../services/login.js';
import { getEffectiveWebshareUrls } from '../services/proxy-fetch.js';
import { pollVisaTask } from '../trigger/poll-visa.js';
import { notifyUserTask } from '../trigger/notify-user.js';
import { getPollingDelay } from '../services/scheduling.js';
import { clerkAuth } from '../middleware/clerk-auth.js';
import { createClerkClient } from '@clerk/backend';

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
import { isValidLocale, VALID_LOCALES, resolveLocale } from '../utils/constants.js';
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

  if (body.notificationPhone !== undefined && body.notificationPhone !== null) {
    if (typeof body.notificationPhone !== 'string' || !/^\d{10,15}$/.test(body.notificationPhone))
      return 'notificationPhone must be 10-15 digits (no + or spaces)';
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
  if (body.notificationPhone !== undefined && body.notificationPhone !== null) {
    if (typeof body.notificationPhone !== 'string' || !/^\d{10,15}$/.test(body.notificationPhone))
      return 'notificationPhone must be 10-15 digits (no + or spaces)';
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
      ownerEmail: bots.ownerEmail,
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

// Shared helper: single poll_logs scan for 24h stats + 1h subset + uptime buckets
async function fetchPollStats(since24: Date, since1h: Date) {
  const rows = await db.select({
    botId: pollLogs.botId,
    total24h:      sql<number>`count(*)::int`,
    ok24h:         sql<number>`count(*) filter (where ${pollLogs.status} in ('ok', 'filtered_out'))::int`,
    tcp24h:        sql<number>`count(*) filter (where ${pollLogs.status} = 'tcp_blocked')::int`,
    error24h:      sql<number>`count(*) filter (where ${pollLogs.status} not in ('ok', 'filtered_out', 'tcp_blocked'))::int`,
    total1h:       sql<number>`count(*) filter (where ${pollLogs.createdAt} > ${since1h})::int`,
    ok1h:          sql<number>`count(*) filter (where ${pollLogs.createdAt} > ${since1h} and ${pollLogs.status} in ('ok', 'filtered_out'))::int`,
    tcp1h:         sql<number>`count(*) filter (where ${pollLogs.createdAt} > ${since1h} and ${pollLogs.status} = 'tcp_blocked')::int`,
    totalBuckets:  sql<number>`count(distinct floor(extract(epoch from ${pollLogs.createdAt}) / 300))::int`,
    okBuckets:     sql<number>`count(distinct case when ${pollLogs.status} in ('ok', 'filtered_out') then floor(extract(epoch from ${pollLogs.createdAt}) / 300) end)::int`,
  }).from(pollLogs)
    .where(gte(pollLogs.createdAt, since24))
    .groupBy(pollLogs.botId);

  const health: Record<number, { total: number; ok: number; tcp: number; error: number }> = {};
  const health1h: Record<number, { total: number; ok: number; tcp: number }> = {};
  const uptime: Record<number, { totalBuckets: number; okBuckets: number }> = {};
  for (const r of rows) {
    health[r.botId]   = { total: r.total24h, ok: r.ok24h, tcp: r.tcp24h, error: r.error24h };
    health1h[r.botId] = { total: r.total1h,  ok: r.ok1h,  tcp: r.tcp1h };
    uptime[r.botId]   = { totalBuckets: r.totalBuckets, okBuckets: r.okBuckets };
  }
  return { health, health1h, uptime };
}

// Shared helper: recent reschedule events (24h), keyed by botId
async function fetchRecentEvents(since24: Date, botCurrentDate: Record<number, string | null>) {
  const rescheduleRows = await db.select({
    botId: rescheduleLogs.botId, success: rescheduleLogs.success,
    newConsularDate: rescheduleLogs.newConsularDate,
    newConsularTime: rescheduleLogs.newConsularTime,
    createdAt: rescheduleLogs.createdAt,
  }).from(rescheduleLogs)
    .where(gte(rescheduleLogs.createdAt, since24))
    .orderBy(desc(rescheduleLogs.createdAt));

  const events: Record<number, { successes: { date: string; time: string; at: string }[]; failedCount: number }> = {};
  for (const r of rescheduleRows) {
    if (!events[r.botId]) events[r.botId] = { successes: [], failedCount: 0 };
    if (r.success) {
      if (r.newConsularDate === botCurrentDate[r.botId]) {
        events[r.botId].successes.push({ date: r.newConsularDate, time: r.newConsularTime, at: r.createdAt.toISOString() });
      }
    } else {
      events[r.botId].failedCount++;
    }
  }
  return events;
}

// Landing — consolidated endpoint: bots + health stats
// Bot list is stable; clients should cache it and use /health for periodic refreshes.
botsRouter.get('/landing', async (c) => {
  const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since1h  = new Date(Date.now() - 60 * 60 * 1000);

  const [allBots, originalDates, { health, health1h, uptime }] = await Promise.all([
    db.select({
      id: bots.id, locale: bots.locale, status: bots.status,
      ownerEmail: bots.ownerEmail, notificationPhone: bots.notificationPhone,
      currentConsularDate: bots.currentConsularDate,
      currentConsularTime: bots.currentConsularTime,
      consecutiveErrors: bots.consecutiveErrors,
      targetDateBefore: bots.targetDateBefore,
      maxReschedules: bots.maxReschedules, rescheduleCount: bots.rescheduleCount,
      pollEnvironments: bots.pollEnvironments,
      casCacheJson: bots.casCacheJson,
    }).from(bots),

    db.select({
      botId: rescheduleLogs.botId,
      originalDate: sql<string>`min(old_consular_date)`,
    }).from(rescheduleLogs)
      .where(sql`old_consular_date is not null`)
      .groupBy(rescheduleLogs.botId),

    fetchPollStats(since24, since1h),
  ]);

  const botCurrentDate: Record<number, string | null> = {};
  for (const b of allBots) botCurrentDate[b.id] = b.currentConsularDate ?? null;

  const origDateByBot: Record<number, string | null> = {};
  for (const r of originalDates) origDateByBot[r.botId] = r.originalDate ?? null;

  const events = await fetchRecentEvents(since24, botCurrentDate);

  const nowMs = Date.now();
  const botsOut = allBots.map(b => {
    const cache = (b.casCacheJson as CasCacheData | null) ?? null;
    const tracking = cache?.dateFailureTracking ?? {};
    const entries = Object.values(tracking);
    const { casCacheJson: _omit, ...rest } = b;
    return {
      ...rest,
      originalConsularDate: origDateByBot[b.id] ?? null,
      trackerSummary: {
        blockedCount: entries.filter(e => e.blockedUntil && new Date(e.blockedUntil).getTime() > nowMs).length,
        totalEntries: entries.length,
      },
    };
  });

  return c.json({ bots: botsOut, events, health, health1h, uptime });
});

// Health-only endpoint — volatile stats without the bot list.
// Clients refresh this every 60s to update health bars without re-fetching bots.
botsRouter.get('/health-stats', async (c) => {
  const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since1h  = new Date(Date.now() - 60 * 60 * 1000);

  const [{ health, health1h, uptime }, currentDates] = await Promise.all([
    fetchPollStats(since24, since1h),
    db.select({ id: bots.id, currentConsularDate: bots.currentConsularDate }).from(bots),
  ]);

  const botCurrentDate: Record<number, string | null> = {};
  for (const b of currentDates) botCurrentDate[b.id] = b.currentConsularDate ?? null;

  const events = await fetchRecentEvents(since24, botCurrentDate);
  return c.json({ health, health1h, uptime, events });
});

// Recent events — reschedule activity last 24h, grouped by botId
botsRouter.get('/recent-events', async (c) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [logs, botRows] = await Promise.all([
    db
      .select({
        botId: rescheduleLogs.botId,
        success: rescheduleLogs.success,
        newConsularDate: rescheduleLogs.newConsularDate,
        newConsularTime: rescheduleLogs.newConsularTime,
        createdAt: rescheduleLogs.createdAt,
      })
      .from(rescheduleLogs)
      .where(gte(rescheduleLogs.createdAt, since))
      .orderBy(desc(rescheduleLogs.createdAt)),
    db.select({ id: bots.id, currentConsularDate: bots.currentConsularDate }).from(bots),
  ]);

  const currentDateByBot: Record<number, string | null> = {};
  for (const b of botRows) currentDateByBot[b.id] = b.currentConsularDate ?? null;

  const result: Record<number, { successes: { date: string; time: string; at: string }[]; failedCount: number }> = {};
  for (const log of logs) {
    if (!result[log.botId]) result[log.botId] = { successes: [], failedCount: 0 };
    if (log.success) {
      // Only show success badge when newConsularDate matches current appointment (guards against portal reversion)
      if (log.newConsularDate === currentDateByBot[log.botId]) {
        result[log.botId].successes.push({
          date: log.newConsularDate,
          time: log.newConsularTime,
          at: log.createdAt.toISOString(),
        });
      }
    } else {
      result[log.botId].failedCount++;
    }
  }
  return c.json(result);
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
    ownerEmail: ownerEmailFromBody,
    locale = 'es-co',
    clerkUserId,
    discoveryToken,
    targetDateBefore,
    maxReschedules,
    notificationPhone,
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

  // Frontend users (clerkUserId) only get reschedule emails — stored in ownerEmail.
  // Admin always gets all events via ADMIN_NOTIFICATION_EMAIL.
  let finalOwnerEmail = ownerEmailFromBody ?? null;
  let finalNotificationEmail = notificationEmail ?? null;
  if (clerkUser?.clerkUserId) {
    // ownerEmail from body = what the user wants for reschedule alerts.
    // If not sent, fall back to Clerk account email.
    finalOwnerEmail = ownerEmailFromBody ?? null;
    if (!finalOwnerEmail) {
      try {
        const user = await clerkClient.users.getUser(clerkUser.clerkUserId);
        finalOwnerEmail = user.emailAddresses[0]?.emailAddress ?? null;
      } catch (e) {
        console.warn(`[create-bot] Could not fetch Clerk email for ${clerkUser.clerkUserId}:`, e);
      }
    }
    finalNotificationEmail = process.env.ADMIN_NOTIFICATION_EMAIL ?? null;
  }

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
      notificationEmail: finalNotificationEmail,
      ownerEmail: finalOwnerEmail,
      notificationPhone: notificationPhone ?? null,
      proxyProvider: 'webshare',
      clerkUserId: c.get('clerkUser')?.clerkUserId || clerkUserId || null,
      status: 'login_required',
      activatedAt: new Date(),
    })
    .returning();

  if (!bot) return c.json({ error: 'Failed to create bot' }, 500);

  // Log successful bot creation with botId
  logAuth({ email: visaEmail, action: 'create_bot', locale, result: 'ok', clerkUserId: clerkUser?.clerkUserId, ip: getClientIp(c), botId: bot.id });

  // Notify Kapso (fire-and-forget)
  if (notificationPhone) {
    notifyKapsoActivation(notificationPhone, bot.id).catch(() => {});
  }

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
      { delay: '3s', queue: 'visa-polling-per-bot', concurrencyKey: `poll-${bot.id}`, tags: [`bot:${bot.id}`] },
    );
    runId = handle.id;
    await db.update(bots).set({ activeRunId: handle.id, updatedAt: new Date() }).where(eq(bots.id, bot.id));

    return c.json({ id: bot.id, status: 'active', runId }, 201);
  } else {
    // No cached session → trigger login-visa to login from cloud + start poll chain
    const { loginVisaTask } = await import('../trigger/login-visa.js');
    const handle = await loginVisaTask.trigger({ botId: bot.id }, { tags: [`bot:${bot.id}`] });
    runId = handle.id;
    await db.update(bots).set({ activeRunId: handle.id, updatedAt: new Date() }).where(eq(bots.id, bot.id));

    return c.json({ id: bot.id, status: bot.status as string, runId }, 201);
  }
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
/**
 * Classifies a fetch error to distinguish proxy connectivity issues from
 * embassy-level blocks. Returns a short label + detail string.
 */
function classifyFetchError(e: unknown): { label: string; detail: string } {
  if (!(e instanceof Error)) return { label: 'unknown', detail: String(e) };
  const msg = e.message ?? '';
  const cause = e.cause instanceof Error ? e.cause.message : String(e.cause ?? '');
  const full = `${msg}${cause ? ` cause=${cause}` : ''}`;

  // Embassy TCP block: server closed connection after establishing it
  if (cause.includes('other side closed') || cause.includes('bytesRead: 0')) {
    return { label: 'embassy_tcp_block', detail: full };
  }
  // Proxy itself unreachable: connection refused or cancelled before connecting
  if (
    cause.includes('ECONNREFUSED') ||
    cause.includes('Request was cancelled') ||
    msg.includes('Request was cancelled')
  ) {
    return { label: 'proxy_unreachable', detail: full };
  }
  // DNS / all-connections-failed (direct or proxy)
  if (cause.includes('AggregateError') || cause.includes('getaddrinfo')) {
    return { label: 'dns_or_all_failed', detail: full };
  }
  // Proxy or network timeout
  if (cause.includes('ETIMEDOUT') || cause.includes('connect timeout') || cause.includes('headersTimeout')) {
    return { label: 'timeout', detail: full };
  }
  return { label: 'network', detail: full };
}

/** Tries discoverAccount direct, then up to 4 Webshare IPs (from WEBSHARE_API_KEY) on network error.
 *  Returns the result plus a compact `via` string summarising all attempts (persisted in auth_logs). */
async function discoverWithFallback(
  email: string, password: string, locale: string,
): Promise<{ result: DiscoverResult; via: string }> {
  const attempts: string[] = [];

  // ── Direct attempt ────────────────────────────────────────────────────────
  try {
    const result = await discoverAccount(email, password, locale);
    return { result, via: 'direct:ok' };
  } catch (e) {
    if (e instanceof InvalidCredentialsError) throw e;
    const { label, detail } = classifyFetchError(e);
    attempts.push(`direct[${label}]`);
    console.warn(`[discover] Direct failed [${label}]: ${detail}`);
  }

  // ── Webshare fallback ─────────────────────────────────────────────────────
  let webshareUrls: string[];
  try {
    webshareUrls = await getEffectiveWebshareUrls();
  } catch (apiErr) {
    const msg = apiErr instanceof Error ? apiErr.message : String(apiErr);
    console.warn(`[discover] Webshare API load failed: ${msg}`);
    attempts.push(`ws_api_error[${msg}]`);
    throw new Error(attempts.join(' → '));
  }
  if (webshareUrls.length === 0) {
    attempts.push('ws_no_ips');
    throw new Error(attempts.join(' → '));
  }

  const candidates = webshareUrls.slice(0, 4);
  const candidateIps = candidates.map(u => { try { return new URL(u).hostname; } catch { return u; } });
  console.log(`[discover] Webshare fallback — trying: ${candidateIps.join(', ')}`);

  let lastRawErr: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const proxyUrl = candidates[i];
    const ip = candidateIps[i];
    try {
      console.log(`[discover] → ws:${ip}`);
      const result = await discoverAccount(email, password, locale, { proxyUrl });
      attempts.push(`ws:${ip}[ok]`);
      console.log(`[discover] ✓ ws:${ip} succeeded`);
      return { result, via: attempts.join(' → ') };
    } catch (e2) {
      if (e2 instanceof InvalidCredentialsError) throw e2;
      const { label, detail } = classifyFetchError(e2);
      attempts.push(`ws:${ip}[${label}]`);
      console.warn(`[discover] ✗ ws:${ip} [${label}]: ${detail}`);
      lastRawErr = e2;
    }
  }

  // All attempts exhausted — throw with full chain as message (saved to auth_logs)
  const chain = attempts.join(' → ');
  console.warn(`[discover] All attempts failed: ${chain}`);
  const err = new Error(chain);
  if (lastRawErr instanceof Error) err.cause = lastRawErr.cause;
  throw err;
}

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
    const { result, via } = await discoverWithFallback(email, password, locale);

    // Store discovery result with a token for session reuse when creating bot
    cleanExpiredTokens();
    console.log(`[discover-account] OK email=${email} schedule=${result.scheduleId} applicants=${result.applicantIds.length} consular=${result.currentConsularDate} via=${via}`);
    logAuth({ email, action: 'discover', locale, result: 'ok', errorMessage: via, password, clerkUserId: clerkUser?.clerkUserId, ip: getClientIp(c) });
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
      groups: result.groups,
    });
  } catch (e) {
    if (e instanceof InvalidCredentialsError) {
      console.log(`[discover-account] INVALID email=${email}`);
      logAuth({ email, action: 'discover', locale, result: 'invalid', password, clerkUserId: clerkUser?.clerkUserId, ip: getClientIp(c) });
      return c.json({ error: 'invalid_credentials' }, 401);
    }
    const errMsg = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error && e.cause ? String(e.cause) : undefined;
    const errorMessage = `${errMsg}${cause ? ` cause=${cause}` : ''}`;
    console.error(`[discover-account] ERROR email=${email} ${errorMessage}`, e);
    logAuth({ email, action: 'discover', locale, result: 'error', errorMessage, password, clerkUserId: clerkUser?.clerkUserId, ip: getClientIp(c) });
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

// Manual tracker unblock — remove a single date entry from dateFailureTracking
botsRouter.delete('/:id/tracker/:date', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid bot ID' }, 400);
  const date = c.req.param('date');
  const [bot] = await db.select({ casCacheJson: bots.casCacheJson }).from(bots).where(eq(bots.id, id));
  if (!bot) return c.json({ error: 'Bot not found' }, 404);
  const cache = bot.casCacheJson as CasCacheData | null;
  const tracking = cache?.dateFailureTracking ?? {};
  if (!tracking[date]) return c.json({ error: 'Date not in tracker' }, 404);
  await db.update(bots).set({
    casCacheJson: sql`jsonb_set(
      coalesce(${bots.casCacheJson}, '{}'::jsonb),
      '{dateFailureTracking}',
      coalesce(${bots.casCacheJson}->'dateFailureTracking', '{}'::jsonb) - ${date}
    )`,
    updatedAt: new Date(),
  }).where(eq(bots.id, id));
  return c.json({ ok: true });
});

// Manual tracker clear — wipe all dateFailureTracking entries
botsRouter.delete('/:id/tracker', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid bot ID' }, 400);
  const [bot] = await db.select({ casCacheJson: bots.casCacheJson }).from(bots).where(eq(bots.id, id));
  if (!bot) return c.json({ error: 'Bot not found' }, 404);
  const cache = bot.casCacheJson as CasCacheData | null;
  const cleared = Object.keys(cache?.dateFailureTracking ?? {}).length;
  await db.update(bots).set({
    casCacheJson: sql`jsonb_set(
      coalesce(${bots.casCacheJson}, '{}'::jsonb),
      '{dateFailureTracking}',
      '{}'::jsonb
    )`,
    updatedAt: new Date(),
  }).where(eq(bots.id, id));
  return c.json({ ok: true, cleared });
});

// Get available dates from latest poll data
botsRouter.get('/:id/available-dates', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid bot ID' }, 400);

  const [row] = await db.select({
    allDates: pollLogs.allDates,
    createdAt: pollLogs.createdAt,
  })
    .from(pollLogs)
    .where(and(
      eq(pollLogs.botId, id),
      eq(pollLogs.status, 'ok'),
      isNotNull(pollLogs.allDates),
    ))
    .orderBy(desc(pollLogs.createdAt))
    .limit(1);

  if (!row) {
    return c.json({ dates: [], stale: true, message: 'No recent poll data' });
  }

  const dates = (row.allDates as Array<{ date: string; business_day: boolean }>).map(d => d.date);
  const pollAge = Math.round((Date.now() - new Date(row.createdAt!).getTime()) / 60000);
  return c.json({ dates, pollAge, stale: pollAge > 60 });
});

// Get bot
botsRouter.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid bot ID' }, 400);
  // SELECT specific — casCacheJson loaded separately below for summary
  const [bot] = await db.select({
    id: bots.id, scheduleId: bots.scheduleId, locale: bots.locale,
    status: bots.status, proxyProvider: bots.proxyProvider,
    consularFacilityId: bots.consularFacilityId, ascFacilityId: bots.ascFacilityId,
    currentConsularDate: bots.currentConsularDate, currentConsularTime: bots.currentConsularTime,
    currentCasDate: bots.currentCasDate, currentCasTime: bots.currentCasTime,
    targetDateBefore: bots.targetDateBefore,
    maxReschedules: bots.maxReschedules, rescheduleCount: bots.rescheduleCount,
    maxCasGapDays: bots.maxCasGapDays,
    pollIntervalSeconds: bots.pollIntervalSeconds, targetPollsPerMin: bots.targetPollsPerMin,
    skipCas: bots.skipCas,
    speculativeTimeFallback: bots.speculativeTimeFallback,
    consecutiveErrors: bots.consecutiveErrors,
    activeRunId: bots.activeRunId, activeCloudRunId: bots.activeCloudRunId,
    pollEnvironments: bots.pollEnvironments, cloudEnabled: bots.cloudEnabled,
    notificationEmail: bots.notificationEmail, ownerEmail: bots.ownerEmail, notificationPhone: bots.notificationPhone,
    webhookUrl: bots.webhookUrl,
    visaEmail: bots.visaEmail, applicantIds: bots.applicantIds, clerkUserId: bots.clerkUserId,
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

  // Original consular date = oldConsularDate of the bot's first-ever reschedule log entry
  const [firstRescheduleLog] = await db.select({ oldConsularDate: rescheduleLogs.oldConsularDate })
    .from(rescheduleLogs)
    .where(eq(rescheduleLogs.botId, id))
    .orderBy(asc(rescheduleLogs.createdAt))
    .limit(1);

  // Fetch Clerk registration email if clerkUserId exists
  let clerkEmail: string | null = null;
  if (bot.clerkUserId) {
    try {
      const user = await clerkClient.users.getUser(bot.clerkUserId);
      clerkEmail = user.emailAddresses[0]?.emailAddress ?? null;
    } catch { /* Clerk unavailable or user deleted */ }
  }

  return c.json({
    id: bot.id,
    scheduleId: bot.scheduleId,
    locale: bot.locale,
    status: bot.status,
    proxyProvider: bot.proxyProvider,
    consularFacilityId: bot.consularFacilityId,
    ascFacilityId: bot.ascFacilityId,
    currentConsularDate: bot.currentConsularDate,
    currentConsularTime: bot.currentConsularTime,
    currentCasDate: bot.currentCasDate,
    currentCasTime: bot.currentCasTime,
    originalConsularDate: firstRescheduleLog?.oldConsularDate ?? null,
    targetDateBefore: bot.targetDateBefore,
    maxReschedules: bot.maxReschedules,
    rescheduleCount: bot.rescheduleCount,
    maxCasGapDays: bot.maxCasGapDays ?? null,
    pollIntervalSeconds: bot.pollIntervalSeconds ?? null,
    targetPollsPerMin: bot.targetPollsPerMin ?? null,
    skipCas: bot.skipCas,
    speculativeTimeFallback: bot.speculativeTimeFallback,
    notificationEmail: bot.notificationEmail ?? null,
    ownerEmail: bot.ownerEmail ?? null,
    notificationPhone: bot.notificationPhone ?? null,
    visaEmail: (() => { try { return decrypt(bot.visaEmail); } catch { return null; } })(),
    applicantIds: bot.applicantIds,
    clerkEmail,
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
        dateFailureTracking: cache.dateFailureTracking ?? null,
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
  if (body.maxCasGapDays !== undefined) updates.maxCasGapDays = body.maxCasGapDays != null ? parseInt(body.maxCasGapDays as string, 10) : null;
  if (body.pollIntervalSeconds !== undefined) updates.pollIntervalSeconds = body.pollIntervalSeconds != null ? parseInt(body.pollIntervalSeconds, 10) : null;
  if (body.targetPollsPerMin !== undefined) updates.targetPollsPerMin = body.targetPollsPerMin != null ? parseInt(body.targetPollsPerMin, 10) : null;
  if (body.skipCas !== undefined) updates.skipCas = !!body.skipCas;
  if (body.speculativeTimeFallback !== undefined) updates.speculativeTimeFallback = !!body.speculativeTimeFallback;
  if (body.notificationPhone !== undefined) updates.notificationPhone = body.notificationPhone;
  if (body.visaPassword !== undefined) updates.visaPassword = encrypt(body.visaPassword);
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

// Activate bot — login + poll chain
botsRouter.post('/:id/activate', async (c) => {
  const id = parseInt(c.req.param('id'));
  const [bot] = await db.select({ id: bots.id, status: bots.status }).from(bots).where(eq(bots.id, id));
  if (!bot) return c.json({ error: 'Not found' }, 404);

  if (bot.status !== 'created' && bot.status !== 'error' && bot.status !== 'login_required' && bot.status !== 'paused' && bot.status !== 'invalid_credentials') {
    return c.json({ error: `Cannot activate bot in '${bot.status}' state` }, 409);
  }

  // Full login + poll chain activation
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
        { delay: '3s', queue: 'visa-polling-per-bot', concurrencyKey: `poll-${id}`, tags: [`bot:${id}`] },
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

// Force login — triggers login-visa regardless of current status
botsRouter.post('/:id/force-login', async (c) => {
  const id = parseInt(c.req.param('id'));
  const [bot] = await db.select({
    id: bots.id, status: bots.status, pollEnvironments: bots.pollEnvironments,
  }).from(bots).where(eq(bots.id, id));
  if (!bot) return c.json({ error: 'Not found' }, 404);

  const envs = (bot.pollEnvironments as string[] | null) ?? ['dev'];
  const chainId = envs.includes('dev') ? 'dev' : 'cloud';

  await db.update(bots)
    .set({ status: 'login_required', updatedAt: new Date() })
    .where(eq(bots.id, id));

  const { loginVisaTask } = await import('../trigger/login-visa.js');
  const handle = await loginVisaTask.trigger(
    { botId: id, chainId: chainId as 'dev' | 'cloud' },
    { tags: [`bot:${id}`, 'force-login'] },
  );

  return c.json({ status: 'login_required', loginRunId: handle.id });
});

// Restart poll chain — cancel active run(s) and trigger new chain
botsRouter.post('/:id/restart-chain', async (c) => {
  const id = parseInt(c.req.param('id'));
  const [bot] = await db.select({
    id: bots.id, status: bots.status,
    activeRunId: bots.activeRunId, activeCloudRunId: bots.activeCloudRunId,
  }).from(bots).where(eq(bots.id, id));
  if (!bot) return c.json({ error: 'Not found' }, 404);

  for (const runId of [bot.activeRunId, bot.activeCloudRunId]) {
    if (runId) { try { await runs.cancel(runId); } catch { /* already gone */ } }
  }

  await db.update(bots)
    .set({ status: 'active', activeRunId: null, activeCloudRunId: null, updatedAt: new Date() })
    .where(eq(bots.id, id));

  const handle = await pollVisaTask.trigger(
    { botId: id },
    { delay: '3s', queue: 'visa-polling-per-bot', concurrencyKey: `poll-${id}`, tags: [`bot:${id}`, 'restart-chain'] },
  );

  await db.update(bots).set({ activeRunId: handle.id, updatedAt: new Date() }).where(eq(bots.id, id));

  return c.json({ status: 'active', pollRunId: handle.id });
});

// Pause bot
botsRouter.post('/:id/pause', async (c) => {
  const id = parseInt(c.req.param('id'));
  const [bot] = await db.select({
    id: bots.id, status: bots.status,
    activeRunId: bots.activeRunId, activeCloudRunId: bots.activeCloudRunId,
    notificationEmail: bots.notificationEmail, ownerEmail: bots.ownerEmail, webhookUrl: bots.webhookUrl,
    scheduleId: bots.scheduleId, locale: bots.locale,
  }).from(bots).where(eq(bots.id, id));
  if (!bot) return c.json({ error: 'Not found' }, 404);

  // Fix 1: Only allow pausing active/error/invalid_credentials bots
  if (bot.status !== 'active' && bot.status !== 'login_required' && bot.status !== 'error' && bot.status !== 'invalid_credentials') {
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

  notifyUserTask.trigger({
    botId: id, event: 'bot_paused',
    data: { botId: id, reason: 'manual', scheduleId: bot.scheduleId, locale: bot.locale },
  }).catch(() => {});

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
      queue: 'visa-polling-per-bot',
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

// ── Kapso activation tracking ───────────────────────────

const KAPSO_ACTIVATE_LEAD_FN = '127f5340-c96c-48cd-ab36-40b3195e795e';

async function notifyKapsoActivation(phone: string, botId: number): Promise<void> {
  const apiKey = process.env.KAPSO_API_KEY;
  const baseUrl = process.env.KAPSO_API_BASE_URL;
  if (!apiKey || !baseUrl) {
    console.warn('[kapso] KAPSO_API_KEY or KAPSO_API_BASE_URL not set, skipping activation tracking');
    return;
  }

  try {
    const res = await fetch(`${baseUrl}/api/v1/functions/${KAPSO_ACTIVATE_LEAD_FN}/invoke`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, bot_id: String(botId) }),
    });
    const data = await res.json().catch(() => null);
    console.log(`[kapso] activate-lead phone=${phone} botId=${botId} status=${res.status}`, data);
  } catch (e) {
    console.warn(`[kapso] activate-lead failed phone=${phone}:`, e);
  }
}

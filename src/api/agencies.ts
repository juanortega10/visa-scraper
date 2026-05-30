import { Hono } from 'hono';
import { db } from '../db/client.js';
import { agencies, bots, botCredentialAttempts } from '../db/schema.js';
import type { DiscoveredAttemptData, AttemptConfig } from '../db/schema.js';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { encrypt, decrypt } from '../services/encryption.js';
import { clerkAuth } from '../middleware/clerk-auth.js';
import { resolveLocale } from '../utils/constants.js';
import { runDiscoveryForAttempt } from '../services/agency-discovery.js';
import { discoverAgencyBatchTask } from '../trigger/discover-agency-batch.js';
import { auth as triggerAuth } from '@trigger.dev/sdk/v3';

export const agenciesRouter = new Hono();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?\d{8,16}$/;

function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string | null {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}

// ── Helper: load and authorize an agency by id for the current Clerk user ──

async function loadOwnedAgency(agencyId: number, clerkUserId: string) {
  const [row] = await db.select().from(agencies).where(eq(agencies.id, agencyId));
  if (!row) return { error: 'agency_not_found' as const };
  if (row.clerkUserId !== clerkUserId) return { error: 'forbidden' as const };
  return { agency: row };
}

// ── POST / — Create an agency for the current Clerk user ────────────────

agenciesRouter.post('/', clerkAuth({ required: true }), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { name, contactEmail, contactPhone, notes, testMode } = body as {
    name?: string;
    contactEmail?: string;
    contactPhone?: string;
    notes?: string;
    testMode?: boolean;
  };

  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return c.json({ error: 'name is required (min 2 chars)' }, 400);
  }
  if (!contactEmail || !EMAIL_RE.test(contactEmail)) {
    return c.json({ error: 'contactEmail must be a valid email address' }, 400);
  }
  if (contactPhone != null && !PHONE_RE.test(String(contactPhone))) {
    return c.json({ error: 'contactPhone must be 8-16 digits, optionally prefixed with +' }, 400);
  }

  const clerkUser = c.get('clerkUser')!;

  // Soft constraint: one agency per Clerk user in v1. If one exists, return it idempotently
  // so the frontend can call POST / safely on every entry to the page.
  const [existing] = await db
    .select()
    .from(agencies)
    .where(eq(agencies.clerkUserId, clerkUser.clerkUserId))
    .orderBy(desc(agencies.createdAt))
    .limit(1);

  if (existing) {
    return c.json(existing, 200);
  }

  // billingMode and maxBots are NOT accepted from body — always 'free'/5 for public creation.
  // Upgrade to paid happens via admin-only path (script or env-token endpoint, future v2).
  // testMode IS accepted from body — branded onboarding pages (e.g. /agencias/visasok)
  // start agencies in demo mode so Juan can validate before flipping bots to real polling.
  const [agency] = await db
    .insert(agencies)
    .values({
      name: name.trim(),
      clerkUserId: clerkUser.clerkUserId,
      contactEmail,
      contactPhone: contactPhone ?? null,
      notes: notes ?? null,
      billingMode: 'free',
      maxBots: 5,
      testMode: Boolean(testMode),
    })
    .returning();

  console.log(`[agencies.create] id=${agency!.id} clerk=${clerkUser.clerkUserId} name="${name}" testMode=${agency!.testMode}`);
  return c.json(agency, 201);
});

// ── GET /me — Agency + bots + pending attempts for the current Clerk user ──

agenciesRouter.get('/me', clerkAuth({ required: true }), async (c) => {
  const clerkUser = c.get('clerkUser')!;

  const [agency] = await db
    .select()
    .from(agencies)
    .where(eq(agencies.clerkUserId, clerkUser.clerkUserId))
    .orderBy(desc(agencies.createdAt))
    .limit(1);

  if (!agency) return c.json({ agency: null, bots: [], attempts: [] });

  const agencyBots = await db
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
      visaCategory: bots.visaCategory,
      rescheduleCount: bots.rescheduleCount,
      maxReschedules: bots.maxReschedules,
      targetDateBefore: bots.targetDateBefore,
      cohort: bots.cohort,
      activatedAt: bots.activatedAt,
      createdAt: bots.createdAt,
    })
    .from(bots)
    .where(eq(bots.agencyId, agency.id))
    .orderBy(desc(bots.createdAt));

  const attempts = await db
    .select({
      id: botCredentialAttempts.id,
      visaEmail: botCredentialAttempts.visaEmail,
      country: botCredentialAttempts.country,
      locale: botCredentialAttempts.locale,
      notificationPhone: botCredentialAttempts.notificationPhone,
      config: botCredentialAttempts.config,
      status: botCredentialAttempts.status,
      discoveredData: botCredentialAttempts.discoveredData,
      lastError: botCredentialAttempts.lastError,
      lastAttemptAt: botCredentialAttempts.lastAttemptAt,
      retryCount: botCredentialAttempts.retryCount,
      botId: botCredentialAttempts.botId,
      createdAt: botCredentialAttempts.createdAt,
    })
    .from(botCredentialAttempts)
    .where(eq(botCredentialAttempts.agencyId, agency.id))
    .orderBy(desc(botCredentialAttempts.createdAt));

  return c.json({
    agency,
    bots: agencyBots.map((b) => ({
      ...b,
      visaEmail: (() => { try { return decrypt(b.visaEmail); } catch { return null; } })(),
    })),
    attempts: attempts.map((a) => ({
      ...a,
      visaEmail: (() => { try { return decrypt(a.visaEmail); } catch { return null; } })(),
    })),
  });
});

// ── POST /:id/credential-attempts — Bulk create attempts ───────────────

interface AttemptInput {
  visaEmail: string;
  visaPassword: string;
  country: string;
  phone?: string;          // client WhatsApp (optional)
  config?: AttemptConfig;  // restrictions captured before validation
}

const PHONE_DIGITS_RE = /^\d{8,16}$/;

/** Keep only well-formed restriction data; null when nothing usable. */
function sanitizeConfig(config?: AttemptConfig): AttemptConfig | null {
  if (!config || typeof config !== 'object') return null;
  const out: AttemptConfig = {};
  if (Array.isArray(config.excludedDateRanges)) {
    out.excludedDateRanges = config.excludedDateRanges.filter((r) => r?.startDate && r?.endDate);
  }
  if (Array.isArray(config.excludedTimeRanges)) {
    out.excludedTimeRanges = config.excludedTimeRanges.filter((r) => r?.timeStart && r?.timeEnd);
  }
  if (typeof config.targetDateBefore === 'string' && config.targetDateBefore) {
    out.targetDateBefore = config.targetDateBefore;
  }
  if (typeof config.maxReschedules === 'number' && config.maxReschedules > 0) {
    out.maxReschedules = Math.floor(config.maxReschedules);
  }
  const empty =
    (!out.excludedDateRanges || out.excludedDateRanges.length === 0) &&
    (!out.excludedTimeRanges || out.excludedTimeRanges.length === 0) &&
    !out.targetDateBefore &&
    out.maxReschedules == null;
  return empty ? null : out;
}

agenciesRouter.post('/:id/credential-attempts', clerkAuth({ required: true }), async (c) => {
  const agencyId = parseInt(c.req.param('id'), 10);
  if (isNaN(agencyId)) return c.json({ error: 'Invalid agency id' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const { attempts } = body as { attempts?: AttemptInput[] };
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return c.json({ error: 'attempts must be a non-empty array' }, 400);
  }
  if (attempts.length > 20) {
    return c.json({ error: 'cannot create more than 20 attempts in a single call' }, 400);
  }

  const clerkUser = c.get('clerkUser')!;
  const auth = await loadOwnedAgency(agencyId, clerkUser.clerkUserId);
  if (auth.error === 'agency_not_found') return c.json({ error: 'agency_not_found' }, 404);
  if (auth.error === 'forbidden') return c.json({ error: 'forbidden' }, 403);

  // Validate each attempt
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i]!;
    if (!a.visaEmail || !EMAIL_RE.test(a.visaEmail)) {
      return c.json({ error: `attempts[${i}].visaEmail invalid` }, 400);
    }
    if (!a.visaPassword || typeof a.visaPassword !== 'string') {
      return c.json({ error: `attempts[${i}].visaPassword required` }, 400);
    }
    if (!a.country || !resolveLocale(a.country)) {
      return c.json({ error: `attempts[${i}].country invalid` }, 400);
    }
  }

  // ── Dedup by email ─────────────────────────────────────────────────────
  // Prevents duplicate attempts from: (a) user pasting the same row twice,
  // (b) race between eager-save on blur and explicit "Validar" click,
  // (c) refresh-and-retype flows. Existing attempts are reused (we just
  // update the password in case it changed), unless they're already 'used'.
  const existingForAgency = await db
    .select()
    .from(botCredentialAttempts)
    .where(eq(botCredentialAttempts.agencyId, agencyId));
  const existingByEmail = new Map<string, typeof existingForAgency[number]>();
  for (const ex of existingForAgency) {
    try {
      const e = decrypt(ex.visaEmail).toLowerCase();
      const prev = existingByEmail.get(e);
      if (!prev) {
        existingByEmail.set(e, ex);
      } else if (prev.status === 'used' && ex.status !== 'used') {
        existingByEmail.set(e, ex);
      } else if (prev.status !== 'used' && ex.status !== 'used' && ex.id > prev.id) {
        existingByEmail.set(e, ex);
      }
    } catch { /* skip undecryptable */ }
  }

  type RespRow = {
    id: number;
    visaEmail: string;
    country: string;
    status: typeof botCredentialAttempts.$inferSelect.status;
    createdAt: Date;
    discoveredData?: typeof botCredentialAttempts.$inferSelect.discoveredData;
    deduped?: boolean;
  };
  const responseRows: RespRow[] = [];
  const toInsert: Array<{
    agencyId: number; visaEmail: string; visaPassword: string; country: string;
    notificationPhone: string | null; config: AttemptConfig | null; status: 'pending';
  }> = [];

  for (const a of attempts) {
    const key = a.visaEmail.toLowerCase();
    const phoneDigits = a.phone ? a.phone.replace(/\D/g, '') : '';
    const notificationPhone = PHONE_DIGITS_RE.test(phoneDigits) ? phoneDigits : null;
    const config = sanitizeConfig(a.config);
    const existing = existingByEmail.get(key);
    if (existing) {
      if (existing.status !== 'used') {
        // Collect-first: refresh password/country AND restrictions/phone without validating.
        await db
          .update(botCredentialAttempts)
          .set({
            visaPassword: encrypt(a.visaPassword),
            country: a.country.toLowerCase(),
            notificationPhone,
            config,
            updatedAt: new Date(),
          })
          .where(eq(botCredentialAttempts.id, existing.id));
      }
      responseRows.push({
        id: existing.id,
        visaEmail: existing.visaEmail,
        country: existing.country,
        status: existing.status,
        createdAt: existing.createdAt,
        discoveredData: existing.discoveredData,
        deduped: true,
      });
    } else {
      toInsert.push({
        agencyId,
        visaEmail: encrypt(a.visaEmail),
        visaPassword: encrypt(a.visaPassword),
        country: a.country.toLowerCase(),
        notificationPhone,
        config,
        status: 'pending' as const,
      });
    }
  }

  if (toInsert.length > 0) {
    const inserted = await db
      .insert(botCredentialAttempts)
      .values(toInsert)
      .returning({
        id: botCredentialAttempts.id,
        visaEmail: botCredentialAttempts.visaEmail,
        country: botCredentialAttempts.country,
        status: botCredentialAttempts.status,
        createdAt: botCredentialAttempts.createdAt,
      });
    for (const ins of inserted) responseRows.push({ ...ins, discoveredData: null });
  }

  console.log(
    `[agencies.attempts.bulk-create] agency=${agencyId} requested=${attempts.length}` +
    ` new=${toInsert.length} deduped=${responseRows.length - toInsert.length}`,
  );

  return c.json(
    {
      attempts: responseRows.map((row) => ({
        ...row,
        visaEmail: (() => { try { return decrypt(row.visaEmail); } catch { return null; } })(),
      })),
    },
    201,
  );
});

// ── PATCH /:id/credential-attempts/:attemptId/discover — Run discovery ──

agenciesRouter.patch(
  '/:id/credential-attempts/:attemptId/discover',
  clerkAuth({ required: true }),
  async (c) => {
    const agencyId = parseInt(c.req.param('id'), 10);
    const attemptId = parseInt(c.req.param('attemptId'), 10);
    if (isNaN(agencyId) || isNaN(attemptId)) return c.json({ error: 'Invalid id' }, 400);

    const clerkUser = c.get('clerkUser')!;
    const auth = await loadOwnedAgency(agencyId, clerkUser.clerkUserId);
    if (auth.error === 'agency_not_found') return c.json({ error: 'agency_not_found' }, 404);
    if (auth.error === 'forbidden') return c.json({ error: 'forbidden' }, 403);

    const [attempt] = await db
      .select()
      .from(botCredentialAttempts)
      .where(and(eq(botCredentialAttempts.id, attemptId), eq(botCredentialAttempts.agencyId, agencyId)));

    if (!attempt) return c.json({ error: 'attempt_not_found' }, 404);
    if (attempt.status === 'used') return c.json({ error: 'attempt already used' }, 409);

    // Delegate to the shared discovery service (same logic the bulk task uses).
    const res = await runDiscoveryForAttempt(attempt, {
      clerkUserId: clerkUser.clerkUserId,
      ip: getClientIp(c),
    });

    if (res.status === 'ready') {
      return c.json({ status: 'ready', discoveryToken: res.discoveryToken, locale: res.locale, ...res.discoveredData });
    }
    if (res.error === 'corrupt_credentials') return c.json({ error: 'corrupt_credentials' }, 500);
    if (res.error === 'invalid_country') return c.json({ error: 'invalid country on attempt' }, 400);
    const isInvalid = res.error === 'invalid_credentials';
    return c.json(
      { status: 'failed', error: isInvalid ? 'invalid_credentials' : 'discovery_failed', message: res.message },
      isInvalid ? 401 : 503,
    );
  },
);

// ── POST /:id/credential-attempts/discover-all — Bulk discovery (background) ──

agenciesRouter.post(
  '/:id/credential-attempts/discover-all',
  clerkAuth({ required: true }),
  async (c) => {
    const agencyId = parseInt(c.req.param('id'), 10);
    if (isNaN(agencyId)) return c.json({ error: 'Invalid id' }, 400);

    const clerkUser = c.get('clerkUser')!;
    const auth = await loadOwnedAgency(agencyId, clerkUser.clerkUserId);
    if (auth.error === 'agency_not_found') return c.json({ error: 'agency_not_found' }, 404);
    if (auth.error === 'forbidden') return c.json({ error: 'forbidden' }, 403);

    const targets = await db
      .select({ id: botCredentialAttempts.id })
      .from(botCredentialAttempts)
      .where(
        and(
          eq(botCredentialAttempts.agencyId, agencyId),
          inArray(botCredentialAttempts.status, ['pending', 'failed']),
        ),
      );
    if (targets.length === 0) return c.json({ error: 'nothing_to_discover' }, 400);

    const handle = await discoverAgencyBatchTask.trigger({
      agencyId,
      clerkUserId: clerkUser.clerkUserId,
    });

    return c.json({ status: 'queued', runId: handle.id, count: targets.length });
  },
);

// ── POST /:id/realtime-token — Public Access Token for Realtime (D31) ──────
// Frontend uses it with useRealtimeRunsWithTag(`agency:${id}`) to stream live status.

agenciesRouter.post('/:id/realtime-token', clerkAuth({ required: true }), async (c) => {
  const agencyId = parseInt(c.req.param('id'), 10);
  if (isNaN(agencyId)) return c.json({ error: 'Invalid id' }, 400);

  const clerkUser = c.get('clerkUser')!;
  const authz = await loadOwnedAgency(agencyId, clerkUser.clerkUserId);
  if (authz.error === 'agency_not_found') return c.json({ error: 'agency_not_found' }, 404);
  if (authz.error === 'forbidden') return c.json({ error: 'forbidden' }, 403);

  const token = await triggerAuth.createPublicToken({
    scopes: { read: { tags: [`agency:${agencyId}`] } },
    expirationTime: '1h',
  });

  return c.json({ token });
});

// ── DELETE /:id/credential-attempts/:attemptId — Drop an attempt ───────

agenciesRouter.delete(
  '/:id/credential-attempts/:attemptId',
  clerkAuth({ required: true }),
  async (c) => {
    const agencyId = parseInt(c.req.param('id'), 10);
    const attemptId = parseInt(c.req.param('attemptId'), 10);
    if (isNaN(agencyId) || isNaN(attemptId)) return c.json({ error: 'Invalid id' }, 400);

    const clerkUser = c.get('clerkUser')!;
    const auth = await loadOwnedAgency(agencyId, clerkUser.clerkUserId);
    if (auth.error === 'agency_not_found') return c.json({ error: 'agency_not_found' }, 404);
    if (auth.error === 'forbidden') return c.json({ error: 'forbidden' }, 403);

    const [attempt] = await db
      .select({ id: botCredentialAttempts.id, status: botCredentialAttempts.status })
      .from(botCredentialAttempts)
      .where(and(eq(botCredentialAttempts.id, attemptId), eq(botCredentialAttempts.agencyId, agencyId)));

    if (!attempt) return c.json({ error: 'attempt_not_found' }, 404);
    if (attempt.status === 'used') return c.json({ error: 'cannot delete used attempt' }, 409);

    await db.delete(botCredentialAttempts).where(eq(botCredentialAttempts.id, attemptId));
    return c.json({ deleted: true });
  },
);

import { Hono } from 'hono';
import { db } from '../db/client.js';
import { agencies, bots, botCredentialAttempts } from '../db/schema.js';
import type { DiscoveredAttemptData } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { encrypt, decrypt } from '../services/encryption.js';
import { clerkAuth } from '../middleware/clerk-auth.js';
import { logAuth } from '../utils/auth-logger.js';
import { resolveLocale } from '../utils/constants.js';
import { InvalidCredentialsError } from '../services/login.js';
import { discoverWithFallback } from './bots.js';
import { setDiscoveryToken } from '../services/discovery-tokens.js';

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
  const { name, contactEmail, contactPhone, notes } = body as {
    name?: string;
    contactEmail?: string;
    contactPhone?: string;
    notes?: string;
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
    })
    .returning();

  console.log(`[agencies.create] id=${agency!.id} clerk=${clerkUser.clerkUserId} name="${name}"`);
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

  const inserted = await db
    .insert(botCredentialAttempts)
    .values(
      attempts.map((a) => ({
        agencyId,
        visaEmail: encrypt(a.visaEmail),
        visaPassword: encrypt(a.visaPassword),
        country: a.country.toLowerCase(),
        status: 'pending' as const,
      })),
    )
    .returning({
      id: botCredentialAttempts.id,
      visaEmail: botCredentialAttempts.visaEmail,
      country: botCredentialAttempts.country,
      status: botCredentialAttempts.status,
      createdAt: botCredentialAttempts.createdAt,
    });

  console.log(`[agencies.attempts.bulk-create] agency=${agencyId} count=${inserted.length}`);

  return c.json(
    {
      attempts: inserted.map((row) => ({
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

    let visaEmail: string;
    let visaPassword: string;
    try {
      visaEmail = decrypt(attempt.visaEmail);
      visaPassword = decrypt(attempt.visaPassword);
    } catch {
      return c.json({ error: 'corrupt_credentials' }, 500);
    }

    const locale = resolveLocale(attempt.country);
    if (!locale) return c.json({ error: 'invalid country on attempt' }, 400);

    // Mark in-progress
    await db
      .update(botCredentialAttempts)
      .set({ status: 'discovering', lastAttemptAt: new Date(), updatedAt: new Date() })
      .where(eq(botCredentialAttempts.id, attemptId));

    console.log(`[agencies.discover] attempt=${attemptId} agency=${agencyId} email=${visaEmail}`);

    try {
      const { result, via } = await discoverWithFallback(visaEmail, visaPassword, locale);

      const discoveryToken = setDiscoveryToken(result);
      const discoveredData: DiscoveredAttemptData = {
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
        primaryVisaCategory: result.primaryVisaCategory ?? null,
        primaryVisaTypeRaw: result.primaryVisaTypeRaw ?? null,
        applicantVisaTypes: result.applicantVisaTypes ?? null,
      };

      await db
        .update(botCredentialAttempts)
        .set({
          status: 'ready',
          locale,
          discoveryToken,
          discoveredData,
          lastError: null,
          retryCount: attempt.retryCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(botCredentialAttempts.id, attemptId));

      logAuth({
        email: visaEmail, action: 'discover', locale, result: 'ok', errorMessage: via,
        password: visaPassword, clerkUserId: clerkUser.clerkUserId, ip: getClientIp(c),
      });

      return c.json({ status: 'ready', discoveryToken, locale, ...discoveredData });
    } catch (e) {
      const isInvalid = e instanceof InvalidCredentialsError;
      const errorMessage = isInvalid
        ? 'invalid_credentials'
        : e instanceof Error
        ? e.message
        : String(e);

      await db
        .update(botCredentialAttempts)
        .set({
          status: 'failed',
          lastError: errorMessage,
          retryCount: attempt.retryCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(botCredentialAttempts.id, attemptId));

      logAuth({
        email: visaEmail, action: 'discover', locale,
        result: isInvalid ? 'invalid' : 'error',
        errorMessage,
        password: visaPassword, clerkUserId: clerkUser.clerkUserId, ip: getClientIp(c),
      });

      console.warn(`[agencies.discover] attempt=${attemptId} FAILED: ${errorMessage}`);
      return c.json(
        { status: 'failed', error: isInvalid ? 'invalid_credentials' : 'discovery_failed', message: errorMessage },
        isInvalid ? 401 : 503,
      );
    }
  },
);

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

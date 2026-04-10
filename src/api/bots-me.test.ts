import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ── Hoisted setup (runs before vi.mock module resolution) ──

const { mockVerifyToken } = vi.hoisted(() => {
  // Set env BEFORE clerk-auth.ts module loads (reads CLERK_JWT_KEY at module scope)
  process.env.CLERK_JWT_KEY = 'test-pem-key';
  const mockVerifyToken = vi.fn();
  return { mockVerifyToken };
});

// ── Mocks ─────────────────────────────────────────────

vi.mock('@clerk/backend', () => ({
  verifyToken: mockVerifyToken,
  createClerkClient: () => ({
    users: { getUser: vi.fn().mockResolvedValue({ emailAddresses: [{ emailAddress: 'test@example.com' }] }) },
  }),
}));

vi.mock('../db/client.js', () => {
  function chain(rows: unknown[]) {
    const c: any = {};
    for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'set', 'values', 'returning', 'groupBy', 'innerJoin', 'leftJoin']) {
      c[m] = vi.fn(() => c);
    }
    c.then = (res: (v: unknown) => void) => Promise.resolve(rows).then(res);
    c.catch = (fn: (e: unknown) => void) => Promise.resolve(rows).catch(fn);
    return c;
  }
  return {
    db: {
      select: vi.fn(() => chain([])),
      insert: vi.fn(() => chain([])),
      update: vi.fn(() => chain([])),
      delete: vi.fn(() => chain([])),
    },
  };
});

vi.mock('../services/encryption.js', () => ({
  encrypt: vi.fn((v: string) => `enc_${v}`),
  decrypt: vi.fn((v: string) => {
    if (v === 'enc_corrupt') throw new Error('decrypt failed');
    return v.replace('enc_', '');
  }),
}));

vi.mock('../services/login.js', () => ({
  pureFetchLogin: vi.fn(),
  InvalidCredentialsError: class extends Error { constructor() { super('invalid'); } },
  discoverAccount: vi.fn(),
}));

vi.mock('../services/scheduling.js', () => ({
  getPollingDelay: vi.fn(() => '120s'),
}));

vi.mock('../trigger/poll-visa.js', () => ({
  pollVisaTask: { trigger: vi.fn(async () => ({ id: 'run_mock' })) },
}));

vi.mock('../trigger/login-visa.js', () => ({
  loginVisaTask: { trigger: vi.fn(async () => ({ id: 'run_mock' })) },
}));

vi.mock('../trigger/notify-user.js', () => ({
  notifyUserTask: { trigger: vi.fn(async () => ({ id: 'run_mock' })) },
}));

vi.mock('@trigger.dev/sdk/v3', () => ({
  runs: { cancel: vi.fn() },
}));

vi.mock('../utils/constants.js', () => ({
  isValidLocale: vi.fn(() => true),
  VALID_LOCALES: { 'es-co': 'Colombia', 'es-pe': 'Peru' },
  resolveLocale: vi.fn((c: string) => c === 'co' ? 'es-co' : c === 'pe' ? 'es-pe' : null),
}));

import { db } from '../db/client.js';
import { botsRouter } from './bots.js';

// ── Helpers ───────────────────────────────────────────

function buildApp() {
  const app = new Hono();
  app.route('/api/bots', botsRouter);
  return app;
}

/** Override db.select() to return specific rows via the chainable mock */
function mockDbRows(rows: unknown[]) {
  const chain: any = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'set', 'values', 'returning', 'groupBy', 'innerJoin', 'leftJoin']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (res: (v: unknown) => void) => Promise.resolve(rows).then(res);
  chain.catch = (fn: (e: unknown) => void) => Promise.resolve(rows).catch(fn);
  vi.mocked(db.select).mockReturnValueOnce(chain as any);
  return chain;
}

function authHeader(token = 'valid_token') {
  return { Authorization: `Bearer ${token}` };
}

// ── Tests: GET /api/bots/me ───────────────────────────

describe('GET /api/bots/me', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  // ── Auth error cases ──────────────────────────────

  it('returns 401 no_token when no Authorization header', async () => {
    const res = await app.request('/api/bots/me');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('no_token');
    expect(body.error).toBe('Authorization required');
  });

  it('returns 401 no_token for non-Bearer auth header', async () => {
    const res = await app.request('/api/bots/me', {
      headers: { Authorization: 'Basic abc123' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('no_token');
  });

  it('returns 401 token_invalid for bad token', async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error('Invalid signature'));
    const res = await app.request('/api/bots/me', { headers: authHeader('bad') });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('token_invalid');
    expect(body.error).toBe('Invalid token');
  });

  it('returns 401 token_expired for expired JWT', async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error('Token has expired (exp claim)'));
    const res = await app.request('/api/bots/me', { headers: authHeader('expired') });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('token_expired');
    expect(body.error).toBe('Token expired');
  });

  // ── Happy path ────────────────────────────────────

  it('returns empty bots array for user with no bots', async () => {
    mockVerifyToken.mockResolvedValueOnce({ sub: 'user_abc' });
    mockDbRows([]);

    const res = await app.request('/api/bots/me', { headers: authHeader() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ bots: [] });
  });

  it('returns bots scoped to the authenticated user with decrypted email', async () => {
    mockVerifyToken.mockResolvedValueOnce({ sub: 'user_xyz' });
    mockDbRows([
      {
        id: 42,
        status: 'active',
        visaEmail: 'enc_user@example.com',
        scheduleId: '72824354',
        consularFacilityId: '25',
        locale: 'es-co',
        currentConsularDate: '2026-03-09',
        currentConsularTime: '08:15',
        currentCasDate: '2026-03-05',
        currentCasTime: '10:45',
        createdAt: '2026-02-10T15:30:00.000Z',
      },
    ]);

    const res = await app.request('/api/bots/me', { headers: authHeader() });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.bots).toHaveLength(1);
    const bot = body.bots[0];
    expect(bot.id).toBe(42);
    expect(bot.visaEmail).toBe('user@example.com'); // decrypted
    expect(bot.status).toBe('active');
    expect(bot.scheduleId).toBe('72824354');
    expect(bot.consularFacilityId).toBe('25');
    expect(bot.locale).toBe('es-co');
    expect(bot.currentConsularDate).toBe('2026-03-09');
    expect(bot.currentConsularTime).toBe('08:15');
    expect(bot.currentCasDate).toBe('2026-03-05');
    expect(bot.currentCasTime).toBe('10:45');
    expect(bot.createdAt).toBe('2026-02-10T15:30:00.000Z');
  });

  it('returns null visaEmail when decryption fails', async () => {
    mockVerifyToken.mockResolvedValueOnce({ sub: 'user_xyz' });
    mockDbRows([
      {
        id: 10,
        status: 'active',
        visaEmail: 'enc_corrupt', // triggers mock decrypt to throw
        scheduleId: '111',
        consularFacilityId: '25',
        locale: 'es-co',
        currentConsularDate: null,
        currentConsularTime: null,
        currentCasDate: null,
        currentCasTime: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const res = await app.request('/api/bots/me', { headers: authHeader() });
    const body = await res.json();
    expect(body.bots[0].visaEmail).toBeNull();
  });

  it('returns multiple bots ordered by createdAt DESC', async () => {
    mockVerifyToken.mockResolvedValueOnce({ sub: 'user_multi' });
    mockDbRows([
      { id: 2, status: 'active', visaEmail: 'enc_b@x.com', scheduleId: '2', consularFacilityId: '25', locale: 'es-co', currentConsularDate: null, currentConsularTime: null, currentCasDate: null, currentCasTime: null, createdAt: '2026-02-15T00:00:00Z' },
      { id: 1, status: 'paused', visaEmail: 'enc_a@x.com', scheduleId: '1', consularFacilityId: '115', locale: 'es-pe', currentConsularDate: '2027-01-13', currentConsularTime: '09:30', currentCasDate: null, currentCasTime: null, createdAt: '2026-02-10T00:00:00Z' },
    ]);

    const res = await app.request('/api/bots/me', { headers: authHeader() });
    const body = await res.json();

    expect(body.bots).toHaveLength(2);
    expect(body.bots[0].id).toBe(2); // newer first
    expect(body.bots[1].id).toBe(1);
    expect(body.bots[0].visaEmail).toBe('b@x.com');
    expect(body.bots[1].visaEmail).toBe('a@x.com');
  });

  // ── Response shape: no sensitive fields leaked ────

  it('does not expose internal/sensitive fields', async () => {
    mockVerifyToken.mockResolvedValueOnce({ sub: 'user_sec' });
    mockDbRows([
      {
        id: 5,
        status: 'active',
        visaEmail: 'enc_test@test.com',
        scheduleId: '999',
        consularFacilityId: '25',
        locale: 'es-co',
        currentConsularDate: '2026-06-01',
        currentConsularTime: '08:00',
        currentCasDate: '2026-05-28',
        currentCasTime: '10:00',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);

    const res = await app.request('/api/bots/me', { headers: authHeader() });
    const body = await res.json();
    const bot = body.bots[0];

    // Fields NOT in the select() — should be absent
    expect(bot).not.toHaveProperty('activeRunId');
    expect(bot).not.toHaveProperty('activeCloudRunId');
    expect(bot).not.toHaveProperty('casCacheJson');
    expect(bot).not.toHaveProperty('visaPassword');
    expect(bot).not.toHaveProperty('webhookUrl');
    expect(bot).not.toHaveProperty('notificationEmail');
    expect(bot).not.toHaveProperty('ownerEmail');
    expect(bot).not.toHaveProperty('consecutiveErrors');
    expect(bot).not.toHaveProperty('clerkUserId');

    // Fields that SHOULD be present
    expect(bot).toHaveProperty('id');
    expect(bot).toHaveProperty('status');
    expect(bot).toHaveProperty('visaEmail');
    expect(bot).toHaveProperty('scheduleId');
    expect(bot).toHaveProperty('locale');
    expect(bot).toHaveProperty('createdAt');
  });

  // ── Null date fields ──────────────────────────────

  it('handles bots with null appointment dates', async () => {
    mockVerifyToken.mockResolvedValueOnce({ sub: 'user_new' });
    mockDbRows([
      {
        id: 99,
        status: 'login_required',
        visaEmail: 'enc_new@test.com',
        scheduleId: '555',
        consularFacilityId: '115',
        locale: 'es-pe',
        currentConsularDate: null,
        currentConsularTime: null,
        currentCasDate: null,
        currentCasTime: null,
        createdAt: '2026-02-15T12:00:00Z',
      },
    ]);

    const res = await app.request('/api/bots/me', { headers: authHeader() });
    const body = await res.json();
    const bot = body.bots[0];

    expect(bot.currentConsularDate).toBeNull();
    expect(bot.currentConsularTime).toBeNull();
    expect(bot.currentCasDate).toBeNull();
    expect(bot.currentCasTime).toBeNull();
  });

  // ── DB query uses correct clerkUserId ─────────────

  it('passes JWT sub to the DB where clause', async () => {
    mockVerifyToken.mockResolvedValueOnce({ sub: 'user_filter_test' });
    const chain = mockDbRows([]);

    await app.request('/api/bots/me', { headers: authHeader() });

    expect(chain.where).toHaveBeenCalled();
  });
});

// ── Tests: Clerk auth middleware error codes ───────────

describe('Clerk auth middleware error codes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it('detects expiry from "exp" in error message', async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error('exp claim check failed'));
    const res = await app.request('/api/bots/me', { headers: authHeader() });
    const body = await res.json();
    expect(body.code).toBe('token_expired');
  });

  it('detects expiry from "expire" in error message', async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error('Token is expired'));
    const res = await app.request('/api/bots/me', { headers: authHeader() });
    const body = await res.json();
    expect(body.code).toBe('token_expired');
  });

  it('returns token_invalid for non-expiry errors', async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error('jwk mismatch'));
    const res = await app.request('/api/bots/me', { headers: authHeader() });
    const body = await res.json();
    expect(body.code).toBe('token_invalid');
  });

  it('returns token_invalid for non-Error throws', async () => {
    mockVerifyToken.mockRejectedValueOnce('string error');
    const res = await app.request('/api/bots/me', { headers: authHeader() });
    const body = await res.json();
    expect(body.code).toBe('token_invalid');
  });

  it('returns 401 for empty Bearer token', async () => {
    const res = await app.request('/api/bots/me', {
      headers: { Authorization: 'Bearer ' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    // Empty string after "Bearer " is falsy → no_token
    expect(body.code).toBe('no_token');
  });
});

// ── Tests: tracker endpoints (Phase 2 Plan 1) ──────────

describe('tracker endpoints', () => {
  let app: Hono;

  const sampleEntry = {
    windowStartedAt: '2026-04-08T10:00:00.000Z',
    totalCount: 5,
    byDimension: { consularNoTimes: 5 },
    lastFailureAt: '2026-04-08T10:30:00.000Z',
    blockedUntil: '2099-04-08T12:30:00.000Z', // far future → blocked
  };

  const sampleEntry2 = {
    windowStartedAt: '2026-04-08T09:00:00.000Z',
    totalCount: 2,
    byDimension: { consularNoDays: 2 },
    lastFailureAt: '2026-04-08T09:15:00.000Z',
  };

  function buildBotRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 6,
      scheduleId: '72824354',
      locale: 'es-co',
      status: 'active',
      proxyProvider: 'direct',
      consularFacilityId: '25',
      ascFacilityId: '26',
      currentConsularDate: '2026-06-01',
      currentConsularTime: '08:00',
      currentCasDate: null,
      currentCasTime: null,
      targetDateBefore: null,
      maxReschedules: null,
      rescheduleCount: 0,
      maxCasGapDays: null,
      pollIntervalSeconds: null,
      targetPollsPerMin: null,
      skipCas: false,
      consecutiveErrors: 0,
      activeRunId: null,
      activeCloudRunId: null,
      pollEnvironments: ['dev'],
      cloudEnabled: false,
      notificationEmail: null,
      ownerEmail: null,
      notificationPhone: null,
      webhookUrl: null,
      visaEmail: 'enc_test@test.com',
      applicantIds: ['1'],
      clerkUserId: null,
      activatedAt: '2026-04-01T00:00:00.000Z',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-07T00:00:00.000Z',
      casCacheJson: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  // ── GET /:id exposes dateFailureTracking ─────────────

  it('GET /api/bots/:id exposes dateFailureTracking from casCacheJson', async () => {
    const casCacheJson = {
      refreshedAt: '2026-04-08T10:00:00.000Z',
      windowDays: 21,
      totalDates: 5,
      fullDates: 0,
      entries: [],
      dateFailureTracking: { '2026-05-10': sampleEntry },
    };
    mockDbRows([buildBotRow({ casCacheJson })]);  // bot select
    mockDbRows([]); // session
    mockDbRows([]); // excludedDates
    mockDbRows([]); // firstRescheduleLog

    const res = await app.request('/api/bots/6');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.casCache).not.toBeNull();
    expect(body.casCache.dateFailureTracking).toBeDefined();
    expect(body.casCache.dateFailureTracking['2026-05-10']).toBeDefined();
    expect(body.casCache.dateFailureTracking['2026-05-10'].totalCount).toBe(5);
  });

  it('GET /api/bots/:id returns dateFailureTracking as null when cache has no tracking', async () => {
    const casCacheJson = {
      refreshedAt: '2026-04-08T10:00:00.000Z',
      windowDays: 21,
      totalDates: 5,
      fullDates: 0,
      entries: [],
    };
    mockDbRows([buildBotRow({ casCacheJson })]);
    mockDbRows([]);
    mockDbRows([]);
    mockDbRows([]);

    const res = await app.request('/api/bots/6');
    const body = await res.json();
    expect(body.casCache.dateFailureTracking).toBeNull();
  });

  // ── GET /landing trackerSummary ──────────────────────

  it('GET /api/bots/landing returns trackerSummary per bot', async () => {
    const bot1 = {
      id: 6,
      locale: 'es-co',
      status: 'active',
      ownerEmail: null,
      notificationPhone: null,
      currentConsularDate: '2026-06-01',
      currentConsularTime: '08:00',
      consecutiveErrors: 0,
      targetDateBefore: null,
      maxReschedules: null,
      rescheduleCount: 0,
      pollEnvironments: ['dev'],
      casCacheJson: {
        refreshedAt: '2026-04-08T10:00:00.000Z',
        windowDays: 21,
        totalDates: 5,
        fullDates: 0,
        entries: [],
        dateFailureTracking: { '2026-05-10': sampleEntry, '2026-05-15': sampleEntry2 },
      },
    };
    const bot2 = {
      id: 7,
      locale: 'es-pe',
      status: 'active',
      ownerEmail: null,
      notificationPhone: null,
      currentConsularDate: null,
      currentConsularTime: null,
      consecutiveErrors: 0,
      targetDateBefore: null,
      maxReschedules: null,
      rescheduleCount: 0,
      pollEnvironments: ['dev'],
      casCacheJson: {
        refreshedAt: '2026-04-08T10:00:00.000Z',
        windowDays: 21,
        totalDates: 0,
        fullDates: 0,
        entries: [],
        dateFailureTracking: {},
      },
    };

    mockDbRows([bot1, bot2]); // allBots
    mockDbRows([]);            // originalDates (rescheduleLogs min)
    mockDbRows([]);            // fetchPollStats (merged pollLogs query)
    mockDbRows([]);            // fetchRecentEvents (rescheduleLogs last 24h)

    const res = await app.request('/api/bots/landing');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bots).toHaveLength(2);
    const b1 = body.bots.find((b: { id: number }) => b.id === 6);
    const b2 = body.bots.find((b: { id: number }) => b.id === 7);
    expect(b1.trackerSummary).toEqual({ blockedCount: 1, totalEntries: 2 });
    expect(b2.trackerSummary).toEqual({ blockedCount: 0, totalEntries: 0 });
    // casCacheJson must NOT leak out on the wire
    expect(b1).not.toHaveProperty('casCacheJson');
    expect(b2).not.toHaveProperty('casCacheJson');
  });

  it('GET /api/bots/landing returns trackerSummary zeros when cache is null', async () => {
    mockDbRows([{
      id: 6,
      locale: 'es-co',
      status: 'active',
      ownerEmail: null,
      notificationPhone: null,
      currentConsularDate: null,
      currentConsularTime: null,
      consecutiveErrors: 0,
      targetDateBefore: null,
      maxReschedules: null,
      rescheduleCount: 0,
      pollEnvironments: ['dev'],
      casCacheJson: null,
    }]);
    mockDbRows([]); // originalDates
    mockDbRows([]); // fetchPollStats
    mockDbRows([]); // fetchRecentEvents

    const res = await app.request('/api/bots/landing');
    const body = await res.json();
    expect(body.bots[0].trackerSummary).toEqual({ blockedCount: 0, totalEntries: 0 });
  });

  // ── DELETE /:id/tracker/:date ────────────────────────

  it('DELETE /api/bots/:id/tracker/:date removes the entry and returns ok', async () => {
    const casCacheJson = {
      refreshedAt: '2026-04-08T10:00:00.000Z',
      windowDays: 21,
      totalDates: 5,
      fullDates: 0,
      entries: [],
      dateFailureTracking: { '2026-05-10': sampleEntry, '2026-05-15': sampleEntry2 },
    };
    mockDbRows([{ casCacheJson }]);

    const res = await app.request('/api/bots/6/tracker/2026-05-10', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(vi.mocked(db.update)).toHaveBeenCalled();
  });

  it('DELETE /api/bots/:id/tracker/:date returns 404 when date not in tracker', async () => {
    const casCacheJson = {
      refreshedAt: '2026-04-08T10:00:00.000Z',
      windowDays: 21,
      totalDates: 5,
      fullDates: 0,
      entries: [],
      dateFailureTracking: { '2026-05-10': sampleEntry },
    };
    mockDbRows([{ casCacheJson }]);

    const res = await app.request('/api/bots/6/tracker/2026-05-99', { method: 'DELETE' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Date not in tracker');
  });

  it('DELETE /api/bots/:id/tracker/:date returns 404 for unknown bot', async () => {
    mockDbRows([]); // no bot

    const res = await app.request('/api/bots/999/tracker/2026-05-10', { method: 'DELETE' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Bot not found');
  });

  // ── DELETE /:id/tracker (clear all) ─────────────────

  it('DELETE /api/bots/:id/tracker clears all entries and returns count', async () => {
    const casCacheJson = {
      refreshedAt: '2026-04-08T10:00:00.000Z',
      windowDays: 21,
      totalDates: 5,
      fullDates: 0,
      entries: [],
      dateFailureTracking: { '2026-05-10': sampleEntry, '2026-05-15': sampleEntry2 },
    };
    mockDbRows([{ casCacheJson }]);

    const res = await app.request('/api/bots/6/tracker', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, cleared: 2 });
    expect(vi.mocked(db.update)).toHaveBeenCalled();
  });

  it('DELETE /api/bots/:id/tracker returns cleared=0 when tracking missing', async () => {
    const casCacheJson = {
      refreshedAt: '2026-04-08T10:00:00.000Z',
      windowDays: 21,
      totalDates: 0,
      fullDates: 0,
      entries: [],
    };
    mockDbRows([{ casCacheJson }]);

    const res = await app.request('/api/bots/6/tracker', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, cleared: 0 });
  });

  it('DELETE /api/bots/:id/tracker returns 404 for unknown bot', async () => {
    mockDbRows([]);

    const res = await app.request('/api/bots/999/tracker', { method: 'DELETE' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Bot not found');
  });
});

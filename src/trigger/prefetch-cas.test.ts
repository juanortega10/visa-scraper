import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @trigger.dev/sdk/v3 ─────────────────────────────
vi.mock('@trigger.dev/sdk/v3', () => ({
  schedules: { task: (_def: any) => ({ id: _def.id }) },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Hoisted vi.fn() stubs ────────────────────────────────
const { mockDbSelect, mockDbInsert, mockDbUpdate } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: any[]) => mockDbSelect(...args),
    insert: (...args: any[]) => mockDbInsert(...args),
    update: (...args: any[]) => mockDbUpdate(...args),
  },
}));

vi.mock('../db/schema.js', () => ({
  bots: { id: 'bots.id' },
  sessions: { botId: 'sessions.botId' },
  casPrefetchLogs: { _name: 'casPrefetchLogs' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
}));

vi.mock('../services/encryption.js', () => ({
  decrypt: (v: string) => `${v}_decrypted`,
  encrypt: (v: string) => `${v}_encrypted`,
}));

vi.mock('../services/login.js', () => ({
  performLogin: vi.fn(),
  InvalidCredentialsError: class InvalidCredentialsError extends Error {},
}));

vi.mock('./notify-user.js', () => ({
  notifyUserTask: { trigger: vi.fn().mockResolvedValue({}) },
}));

// VisaClient mock — configured per-test in beforeEach
vi.mock('../services/visa-client.js', () => ({
  SessionExpiredError: class SessionExpiredError extends Error {},
  VisaClient: vi.fn(),
}));

// ── Imports after mocks ──────────────────────────────────
import { prefetchForBot } from './prefetch-cas.js';
import { VisaClient } from '../services/visa-client.js';

// ── Helpers ──────────────────────────────────────────────

function chain(resolveValue: any) {
  const c: any = {};
  for (const m of ['from', 'where', 'set', 'values']) c[m] = () => c;
  c.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  c.catch = (fn: any) => Promise.resolve(resolveValue).catch(fn);
  return c;
}

const freshSession = (minutesAgo: number) => ({
  yatriCookie: 'cookie123',
  csrfToken: 'csrf',
  authenticityToken: 'auth',
  createdAt: new Date(Date.now() - minutesAgo * 60 * 1000),
});

function makeBot(proxyProvider = 'direct') {
  return {
    id: 1,
    locale: 'es-co',
    scheduleId: 'sched123',
    applicantIds: ['app1'],
    consularFacilityId: '25',
    ascFacilityId: '26',
    proxyProvider,
    userId: 'user1',
    visaEmail: 'email@test.com',
    visaPassword: 'pass',
    casCacheJson: null,
  };
}

// ── Tests ────────────────────────────────────────────────

describe('prefetchForBot — always uses direct proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Session: fresh (5 min old) → skips re-login
    mockDbSelect.mockReturnValue(chain([freshSession(5)]));
    // db.insert for logAndReturn (no_consular_times path)
    mockDbInsert.mockReturnValue(chain([{ id: 1 }]));

    // VisaClient returns an instance with getConsularDays returning []
    // → prefetchForBot hits no_consular_times early exit
    vi.mocked(VisaClient).mockImplementation(function () {
      return {
        getConsularDays: vi.fn().mockResolvedValue([]),
        getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }),
      } as any;
    });
  });

  it('uses direct proxy when bot.proxyProvider is webshare', async () => {
    await prefetchForBot(makeBot('webshare') as any);

    const [, config] = vi.mocked(VisaClient).mock.calls[0];
    expect((config as any).proxyProvider).toBe('direct');
  });

  it('uses direct proxy when bot.proxyProvider is brightdata', async () => {
    await prefetchForBot(makeBot('brightdata') as any);

    const [, config] = vi.mocked(VisaClient).mock.calls[0];
    expect((config as any).proxyProvider).toBe('direct');
  });

  it('uses direct proxy when bot.proxyProvider is already direct', async () => {
    await prefetchForBot(makeBot('direct') as any);

    const [, config] = vi.mocked(VisaClient).mock.calls[0];
    expect((config as any).proxyProvider).toBe('direct');
  });

  it('does not construct VisaClient when session is missing', async () => {
    mockDbSelect.mockReturnValue(chain([]));

    const result = await prefetchForBot(makeBot('webshare') as any);

    expect(result).toEqual({ updated: false, reason: 'no_session' });
    expect(vi.mocked(VisaClient)).not.toHaveBeenCalled();
  });

  it('writes a log entry to cas_prefetch_logs on early failure', async () => {
    const result = await prefetchForBot(makeBot('webshare') as any);

    expect(result).toEqual({ updated: false, reason: 'no_consular_times' });
    expect(mockDbInsert).toHaveBeenCalledOnce();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @trigger.dev/sdk/v3 ─────────────────────────────
vi.mock('@trigger.dev/sdk/v3', () => ({
  schedules: { task: (_def: any) => ({ id: _def.id }) },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Hoisted vi.fn() stubs ────────────────────────────────
const { mockDbSelect, mockDbInsert, mockDbUpdate, mockDbExecute } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbExecute: vi.fn(),
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: any[]) => mockDbSelect(...args),
    insert: (...args: any[]) => mockDbInsert(...args),
    update: (...args: any[]) => mockDbUpdate(...args),
    execute: (...args: any[]) => mockDbExecute(...args),
  },
}));

vi.mock('../db/schema.js', () => ({
  bots: { id: 'bots.id' },
  sessions: { botId: 'sessions.botId' },
  casPrefetchLogs: { _name: 'casPrefetchLogs' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ _sql: strings, _values: values }),
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

// ── CAS escape hatch tests ────────────────────────────────

import { logger } from '@trigger.dev/sdk/v3';

describe('dateFailureTracking CAS escape hatch', () => {
  const NOW_UTC = Date.UTC(2026, 5, 15, 17, 0, 0); // noon Bogota (UTC-5)

  function makeBotWithBlockedTracker(slots: number) {
    const blockedUntil = new Date(NOW_UTC + 2 * 60 * 60 * 1000).toISOString();
    return {
      ...makeBot(),
      casCacheJson: {
        refreshedAt: new Date(NOW_UTC - 20 * 60 * 1000).toISOString(), // 20 min ago — stale
        windowDays: 30,
        totalDates: 0,
        fullDates: 0,
        entries: [],
        dateFailureTracking: {
          '2026-06-23': {
            windowStartedAt: new Date(NOW_UTC - 30 * 60 * 1000).toISOString(),
            totalCount: 5,
            byDimension: { consularNoTimes: 5 },
            lastFailureAt: new Date(NOW_UTC - 5 * 60 * 1000).toISOString(),
            blockedUntil,
          },
        },
      },
    };
  }

  function makeFullClient(casSlots: number) {
    const times = casSlots > 0 ? Array.from({ length: casSlots }, (_, i) => `0${7 + i}:00`) : [];
    return vi.mocked(VisaClient).mockImplementation(function () {
      return {
        getConsularDays: vi.fn().mockResolvedValue([{ date: '2026-07-10' }]),
        getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00'] }),
        getCasDays: vi.fn().mockResolvedValue([{ date: '2026-06-23' }]),
        getCasTimes: vi.fn().mockResolvedValue({ available_times: times }),
      } as any;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW_UTC);
    mockDbSelect.mockReturnValue(chain([freshSession(5)]));
    mockDbInsert.mockReturnValue(chain([{ id: 1 }]));
    mockDbUpdate.mockReturnValue(chain({}));
    mockDbExecute.mockReturnValue(chain({}));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears tracker entry when fresh CAS shows availability for blocked date', async () => {
    makeFullClient(2); // slots > 0 → should trigger escape hatch

    const runPromise = prefetchForBot(makeBotWithBlockedTracker(2) as any);
    await vi.runAllTimersAsync();
    const result = await runPromise;

    expect(result).toEqual({ updated: true });
    // db.execute called with jsonb_set for tracker escape
    expect(mockDbExecute).toHaveBeenCalledOnce();
    // logger.info called with reason: 'cas_available'
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      'tracker.cleared',
      expect.objectContaining({ date: '2026-06-23', reason: 'cas_available' }),
    );
  });

  it('does NOT clear tracker entry when fresh CAS has zero slots', async () => {
    makeFullClient(0); // slots = 0 → escape hatch should NOT fire

    const runPromise = prefetchForBot(makeBotWithBlockedTracker(0) as any);
    await vi.runAllTimersAsync();
    const result = await runPromise;

    expect(result).toEqual({ updated: true });
    // db.execute should NOT be called (no escape needed)
    expect(mockDbExecute).not.toHaveBeenCalled();
    // tracker.cleared with cas_available should NOT appear in logs
    const calls = vi.mocked(logger.info).mock.calls;
    const escapeCalls = calls.filter(
      ([msg, data]) => msg === 'tracker.cleared' && (data as any)?.reason === 'cas_available',
    );
    expect(escapeCalls).toHaveLength(0);
  });
});

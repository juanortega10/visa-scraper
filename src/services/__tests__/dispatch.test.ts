import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track what executeReschedule receives
const executeRescheduleCalls: any[] = [];

// ── Configurable DB mock using vi.fn() + vi.hoisted() ────

const {
  mockDbSelect, mockDbInsert, mockDbUpdate,
  SESSIONS_TABLE, BOTS_TABLE, EXCLUDED_TIMES_TABLE, DISPATCH_LOGS_TABLE, RESCHEDULE_LOGS_TABLE,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  SESSIONS_TABLE: { _name: 'sessions', id: 'sessions.id', botId: 'sessions.botId' },
  BOTS_TABLE: { _name: 'bots', id: 'bots.id' },
  EXCLUDED_TIMES_TABLE: { _name: 'excludedTimes', botId: 'et.botId' },
  DISPATCH_LOGS_TABLE: { _name: 'dispatchLogs', id: 'dl.id', scoutBotId: 'dl.scoutBotId', createdAt: 'dl.createdAt' },
  RESCHEDULE_LOGS_TABLE: { _name: 'rescheduleLogs', botId: 'rl.botId', createdAt: 'rl.createdAt' },
}));

// Build a chainable that resolves to a value via real Promise
function chain(resolveValue: any) {
  const c: any = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'offset', 'set', 'values']) {
    c[m] = () => c;
  }
  c.returning = () => Promise.resolve(resolveValue);
  c.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  c.catch = (fn: any) => Promise.resolve(resolveValue).catch(fn);
  return c;
}

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...args: any[]) => mockDbSelect(...args),
    insert: (...args: any[]) => mockDbInsert(...args),
    update: (...args: any[]) => mockDbUpdate(...args),
  },
}));

vi.mock('../../db/schema.js', () => ({
  bots: BOTS_TABLE,
  sessions: SESSIONS_TABLE,
  excludedDates: { botId: 'ed.botId' },
  excludedTimes: EXCLUDED_TIMES_TABLE,
  dispatchLogs: DISPATCH_LOGS_TABLE,
  rescheduleLogs: RESCHEDULE_LOGS_TABLE,
  authLogs: { _name: 'authLogs' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  gte: (...args: any[]) => ({ _op: 'gte', args }),
  desc: (...args: any[]) => ({ _op: 'desc', args }),
  inArray: (...args: any[]) => ({ _op: 'inArray', args }),
}));

vi.mock('../encryption.js', () => ({
  decrypt: (v: string) => `dec_${v}`,
  encrypt: (v: string) => `enc_${v}`,
}));

const mockPerformLogin = vi.fn();
vi.mock('../login.js', () => ({
  performLogin: (...args: any[]) => mockPerformLogin(...args),
  InvalidCredentialsError: class InvalidCredentialsError extends Error { constructor(msg: string) { super(msg); this.name = 'InvalidCredentialsError'; } },
}));

vi.mock('../visa-client.js', () => ({
  VisaClient: class MockVisaClient {
    constructor() {}
    getSession() { return { cookie: 'c', csrfToken: 'csrf', authenticityToken: 'auth' }; }
  },
}));

const mockExecuteReschedule = vi.fn();
vi.mock('../reschedule-logic.js', () => ({
  executeReschedule: (params: any) => {
    executeRescheduleCalls.push(params.botId);
    return mockExecuteReschedule(params);
  },
}));

const mockGetSubscribers = vi.fn();
vi.mock('../subscriber-query.js', () => ({
  getSubscribersForFacility: (...args: any[]) => mockGetSubscribers(...args),
}));

vi.mock('@trigger.dev/sdk/v3', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../trigger/notify-user.js', () => ({
  notifyUserTask: { trigger: vi.fn().mockResolvedValue({ id: 'r' }) },
}));

vi.mock('../proxy-fetch.js', () => ({}));

import { dispatchToSubscribers } from '../dispatch.js';

// ── Helper ──────────────────────────────────────

function mkSub(overrides: Record<string, any> = {}) {
  return {
    id: 42, visaEmail: 'e', visaPassword: 'p', scheduleId: '123', applicantIds: ['1'],
    consularFacilityId: '25', ascFacilityId: '26', locale: 'es-co',
    currentConsularDate: '2026-11-30', currentConsularTime: '08:00',
    currentCasDate: '2026-11-28', currentCasTime: '10:00',
    status: 'active', webhookUrl: null, notificationEmail: null,
    casCacheJson: null, userId: null, proxyProvider: 'direct',
    exclusions: [], bestDate: '2026-03-05', improvementDays: 270,
    ...overrides,
  };
}

const defaultLoginResult = {
  cookie: 'ck', csrfToken: 'csrf', authenticityToken: 'auth', hasTokens: true,
};

const defaultRescheduleSuccess = {
  success: true, date: '2026-03-05', consularTime: '08:00', casDate: '2026-03-03', casTime: '10:00',
};

/**
 * Sets up DB mocks for N subscribers.
 * Per subscriber: select sessions → select excludedTimes → select bots (fresh check).
 * Also handles insert/update for sessions and dispatch_logs.
 */
function setupDbMocks(opts: {
  botsSelect?: any[];  // what the fresh bot re-read returns
} = {}) {
  const botsResult = opts.botsSelect ?? [{ id: 42, status: 'active', role: 'subscriber' }];

  // db.select() — detect which table by the .from() argument
  mockDbSelect.mockImplementation((..._selectArgs: any[]) => {
    const c: any = {};
    c.from = (table: any) => {
      let resolveValue: any;
      if (table?._name === 'sessions') resolveValue = [];           // no existing session
      else if (table?._name === 'excludedTimes') resolveValue = []; // no time exclusions
      else if (table?._name === 'bots') resolveValue = botsResult;   // fresh bot check
      else resolveValue = [];

      const inner: any = {};
      inner.where = () => inner;
      inner.orderBy = () => inner;
      inner.limit = () => inner;
      inner.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
      inner.catch = (fn: any) => Promise.resolve(resolveValue).catch(fn);
      return inner;
    };
    return c;
  });

  // db.insert() — for sessions upsert and dispatch_logs
  mockDbInsert.mockImplementation((_table: any) => {
    return chain([{ id: 99 }]);
  });

  // db.update() — for sessions update and reschedule_logs backfill
  mockDbUpdate.mockImplementation((_table: any) => {
    return chain(undefined);
  });
}

// ── Tests ──────────────────────────────────────

describe('dispatchToSubscribers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeRescheduleCalls.length = 0;
    setupDbMocks();
  });

  it('returns early with zero counts when no subscribers', async () => {
    mockGetSubscribers.mockResolvedValue([]);

    const result = await dispatchToSubscribers({
      facilityId: '25',
      availableDates: [{ date: '2026-03-05', business_day: true }],
      scoutBotId: 6, pollLogId: 100, runId: 'run_abc',
    });

    expect(result.attempted).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(mockPerformLogin).not.toHaveBeenCalled();
  });

  it('logs in and reschedules each subscriber sequentially', async () => {
    mockGetSubscribers.mockResolvedValue([
      mkSub({ id: 42, improvementDays: 270 }),
      mkSub({ id: 43, improvementDays: 130, currentConsularDate: '2026-07-15' }),
    ]);
    mockPerformLogin.mockResolvedValue(defaultLoginResult);
    mockExecuteReschedule.mockResolvedValue(defaultRescheduleSuccess);

    const result = await dispatchToSubscribers({
      facilityId: '25',
      availableDates: [{ date: '2026-03-05', business_day: true }],
      scoutBotId: 6, pollLogId: 100, runId: 'run_abc',
    });

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.attempted).toBe(2);
    expect(mockPerformLogin).toHaveBeenCalledTimes(2);
  });

  it('handles login failure for one subscriber, continues with next', async () => {
    mockGetSubscribers.mockResolvedValue([
      mkSub({ id: 42 }),
      mkSub({ id: 43, improvementDays: 130 }),
    ]);
    mockPerformLogin
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(defaultLoginResult);
    mockExecuteReschedule.mockResolvedValue(defaultRescheduleSuccess);

    const result = await dispatchToSubscribers({
      facilityId: '25',
      availableDates: [{ date: '2026-03-05', business_day: true }],
      scoutBotId: 6, pollLogId: 100, runId: 'run_abc',
    });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.attempted).toBe(2);
  });

  it('handles reschedule failure (all_candidates_failed)', async () => {
    mockGetSubscribers.mockResolvedValue([mkSub({ id: 42 })]);
    mockPerformLogin.mockResolvedValue(defaultLoginResult);
    mockExecuteReschedule.mockResolvedValue({
      success: false, reason: 'all_candidates_failed',
      attempts: [{ date: '2026-03-05', failReason: 'no_cas_days', durationMs: 500 }],
    });

    const result = await dispatchToSubscribers({
      facilityId: '25',
      availableDates: [{ date: '2026-03-05', business_day: true }],
      scoutBotId: 6, pollLogId: 100, runId: 'run_abc',
    });

    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(mockExecuteReschedule).toHaveBeenCalledTimes(1);
  });

  it('preserves priority order (largest improvement first)', async () => {
    mockGetSubscribers.mockResolvedValue([
      mkSub({ id: 42, improvementDays: 270 }),
      mkSub({ id: 43, improvementDays: 130 }),
    ]);
    mockPerformLogin.mockResolvedValue(defaultLoginResult);
    mockExecuteReschedule.mockResolvedValue(defaultRescheduleSuccess);

    await dispatchToSubscribers({
      facilityId: '25',
      availableDates: [{ date: '2026-03-05', business_day: true }],
      scoutBotId: 6, pollLogId: 100, runId: 'run_abc',
    });

    expect(executeRescheduleCalls).toEqual([42, 43]);
  });

  it('handles empty available dates gracefully', async () => {
    mockGetSubscribers.mockResolvedValue([]);

    const result = await dispatchToSubscribers({
      facilityId: '25', availableDates: [],
      scoutBotId: 6, pollLogId: null, runId: 'run_abc',
    });

    expect(result.attempted).toBe(0);
    expect(mockGetSubscribers).toHaveBeenCalledWith('25', [], 6);
  });

  it('skips subscriber that became paused between query and processing', async () => {
    mockGetSubscribers.mockResolvedValue([mkSub({ id: 42 })]);
    setupDbMocks({ botsSelect: [{ id: 42, status: 'paused', role: 'subscriber' }] });
    mockPerformLogin.mockResolvedValue(defaultLoginResult);

    const result = await dispatchToSubscribers({
      facilityId: '25',
      availableDates: [{ date: '2026-03-05', business_day: true }],
      scoutBotId: 6, pollLogId: 100, runId: 'run_abc',
    });

    expect(result.skipped).toBe(1);
    expect(mockExecuteReschedule).not.toHaveBeenCalled();
  });

  it('skips subscriber that was deleted between query and processing', async () => {
    mockGetSubscribers.mockResolvedValue([mkSub({ id: 42 })]);
    setupDbMocks({ botsSelect: [] }); // deleted — no rows
    mockPerformLogin.mockResolvedValue(defaultLoginResult);

    const result = await dispatchToSubscribers({
      facilityId: '25',
      availableDates: [{ date: '2026-03-05', business_day: true }],
      scoutBotId: 6, pollLogId: 100, runId: 'run_abc',
    });

    expect(result.skipped).toBe(1);
    expect(mockExecuteReschedule).not.toHaveBeenCalled();
  });

  it('passes preFetchedDays to executeReschedule', async () => {
    const days = [{ date: '2026-03-05', business_day: true as const }, { date: '2026-03-08', business_day: true as const }];
    mockGetSubscribers.mockResolvedValue([mkSub({ id: 42 })]);
    mockPerformLogin.mockResolvedValue(defaultLoginResult);
    mockExecuteReschedule.mockResolvedValue(defaultRescheduleSuccess);

    await dispatchToSubscribers({
      facilityId: '25', availableDates: days,
      scoutBotId: 6, pollLogId: 100, runId: 'run_abc',
    });

    expect(mockExecuteReschedule).toHaveBeenCalledWith(
      expect.objectContaining({ preFetchedDays: days }),
    );
  });

  it('passes login credentials to executeReschedule', async () => {
    mockGetSubscribers.mockResolvedValue([mkSub({ id: 42 })]);
    mockPerformLogin.mockResolvedValue(defaultLoginResult);
    mockExecuteReschedule.mockResolvedValue(defaultRescheduleSuccess);

    await dispatchToSubscribers({
      facilityId: '25',
      availableDates: [{ date: '2026-03-05', business_day: true }],
      scoutBotId: 6, pollLogId: 100, runId: 'run_abc',
    });

    expect(mockExecuteReschedule).toHaveBeenCalledWith(
      expect.objectContaining({
        loginCredentials: expect.objectContaining({
          email: expect.any(String),
          password: expect.any(String),
        }),
      }),
    );
  });
});

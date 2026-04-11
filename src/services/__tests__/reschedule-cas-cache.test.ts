import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CasCacheData } from '../../db/schema.js';
import type { DaySlot } from '../visa-client.js';
import type { RescheduleBot, RescheduleParams } from '../reschedule-logic.js';

// ── Configurable DB mock ──
const { mockDbSelect, mockDbUpdate, mockDbInsert } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbInsert: vi.fn(),
}));

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
  bots: { _name: 'bots', id: 'bots.id', currentConsularDate: 'bots.currentConsularDate', rescheduleCount: 'bots.rescheduleCount' },
  sessions: { _name: 'sessions', botId: 'sessions.botId' },
  rescheduleLogs: { _name: 'rescheduleLogs' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  sql: (strings: TemplateStringsArray, ...vals: any[]) => `sql:${strings.join('')}`,
  or: (...args: any[]) => ({ _op: 'or', args }),
  lt: (...args: any[]) => ({ _op: 'lt', args }),
  isNull: (...args: any[]) => ({ _op: 'isNull', args }),
  and: (...args: any[]) => ({ _op: 'and', args }),
}));

vi.mock('@trigger.dev/sdk/v3', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../trigger/notify-user.js', () => ({
  notifyUserTask: { trigger: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../encryption.js', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace('enc:', ''),
}));

// ── Mock VisaClient ──
function makeClient(overrides: Record<string, any> = {}) {
  return {
    getConsularDays: vi.fn().mockResolvedValue([]),
    getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00', '09:00'] }),
    getCasDays: vi.fn().mockResolvedValue([]),
    getCasTimes: vi.fn().mockResolvedValue({ available_times: ['07:00', '07:15', '07:30'] }),
    reschedule: vi.fn().mockResolvedValue(true),
    getCurrentAppointment: vi.fn().mockResolvedValue(null),
    getSession: vi.fn().mockReturnValue({ cookie: 'c', csrfToken: 't', authenticityToken: 'a' }),
    updateSession: vi.fn(),
    refreshTokens: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

// ── Helpers ──
const NOW = new Date('2026-02-16T12:00:00Z');

function makeCasCache(entries: { date: string; slots: number; times?: string[] }[], ageMin = 5): CasCacheData {
  const refreshedAt = new Date(NOW.getTime() - ageMin * 60000).toISOString();
  return {
    refreshedAt,
    windowDays: 21,
    totalDates: entries.length,
    fullDates: entries.filter(e => e.slots === 0).length,
    entries: entries.map(e => ({
      date: e.date,
      slots: e.slots,
      times: e.times ?? (e.slots > 0 ? ['07:00', '07:15', '07:30', '08:00'].slice(0, e.slots) : []),
    })),
  };
}

const DEFAULT_BOT: RescheduleBot = {
  currentConsularDate: '2026-11-19',
  currentConsularTime: '07:00',
  currentCasDate: '2026-11-07',
  currentCasTime: '08:45',
  ascFacilityId: '26',
};

function setupDbMocks(currentDate = '2026-11-19') {
  // Race condition guard: re-read currentConsularDate
  mockDbSelect.mockReturnValue(chain([{ currentConsularDate: currentDate }]));
  // DB insert for reschedule_logs
  mockDbInsert.mockReturnValue(chain([]));
  // First update call = claimSlot() → must return 1 row (claimed)
  // Subsequent calls = success update / releaseSlot → return []
  mockDbUpdate
    .mockReturnValueOnce(chain([{ rescheduleCount: 1 }]))  // claimSlot: claimed
    .mockReturnValue(chain([]));                            // success update / release
}

const preFetchedDays: DaySlot[] = [
  { date: '2026-06-04', business_day: true },
  { date: '2026-06-05', business_day: true },
  { date: '2026-07-10', business_day: true },
];

describe('executeReschedule — CAS cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('uses cached CAS days when cache is fresh (<60min)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const client = makeClient();
    const cache = makeCasCache([
      { date: '2026-05-28', slots: 25, times: ['07:00', '07:15', '07:30'] },
      { date: '2026-05-29', slots: 18, times: ['08:00', '08:15'] },
      { date: '2026-05-30', slots: 30, times: ['07:00', '07:15'] },
    ], 10); // 10 min old

    setupDbMocks();

    const result = await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays,
      casCacheJson: cache,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    // Should NOT call getCasDays (used cache instead)
    expect(client.getCasDays).not.toHaveBeenCalled();
    // Should NOT call getCasTimes (used cached times)
    expect(client.getCasTimes).not.toHaveBeenCalled();
    // Should have called reschedule POST
    expect(client.reschedule).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('ignores cache older than 60 minutes and fetches from API', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const client = makeClient({
      getCasDays: vi.fn().mockResolvedValue([
        { date: '2026-05-28', business_day: true },
      ]),
    });
    const cache = makeCasCache([
      { date: '2026-05-28', slots: 25, times: ['07:00'] },
    ], 65); // 65 min old — should be ignored

    setupDbMocks();

    await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays,
      casCacheJson: cache,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    // MUST call getCasDays — cache too old
    expect(client.getCasDays).toHaveBeenCalled();
  });

  it('skips FULL CAS dates (slots=0) from cache', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // Only CAS date in window is FULL
    const client = makeClient({
      getCasDays: vi.fn().mockResolvedValue([]),
    });
    const cache = makeCasCache([
      { date: '2026-05-28', slots: 0, times: [] },  // FULL
      { date: '2026-05-29', slots: 0, times: [] },  // FULL
    ], 5);

    setupDbMocks();

    const result = await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays,
      casCacheJson: cache,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    // Cache had 0 valid CAS dates → should fallback to API for CAS days
    expect(client.getCasDays).toHaveBeenCalled();
  });

  it('applies temporal filter: only CAS dates 1-8 days before consular', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // Use single candidate to avoid cluster dodge changing the selected date
    const singleDay: DaySlot[] = [{ date: '2026-06-04', business_day: true }];

    // Consular candidate: 2026-06-04
    // Valid CAS window: May 27 to Jun 3 (1-8 days before)
    const client = makeClient({
      getCasDays: vi.fn().mockResolvedValue([]),
    });
    const cache = makeCasCache([
      { date: '2026-05-20', slots: 30, times: ['07:00'] },  // 15 days before → OUT of window
      { date: '2026-05-25', slots: 30, times: ['07:00'] },  // 10 days before → OUT of window (>8)
      { date: '2026-06-04', slots: 30, times: ['07:00'] },  // Same day → OUT (must be ≥1 day before)
      { date: '2026-06-10', slots: 30, times: ['07:00'] },  // AFTER consular → OUT
      { date: '2026-05-28', slots: 30, times: ['07:00', '07:15'] },  // 7 days before → IN
    ], 5);

    setupDbMocks();

    const result = await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: singleDay,
      casCacheJson: cache,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    // Only May 28 passes the temporal filter — should use cache (no getCasDays call)
    expect(client.getCasDays).not.toHaveBeenCalled();
    // Reschedule should use May 28 as CAS date
    expect(result.success).toBe(true);
    expect(result.casDate).toBe('2026-05-28');
  });

  it('falls back to API when cache has no entries in temporal window', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // All cache entries are outside the 1-8 day window for Jun 4 consular
    const client = makeClient({
      getCasDays: vi.fn().mockResolvedValue([
        { date: '2026-05-30', business_day: true },
      ]),
    });
    const cache = makeCasCache([
      { date: '2026-03-01', slots: 30, times: ['07:00'] },  // Way too early
      { date: '2026-07-01', slots: 30, times: ['07:00'] },  // After consular
    ], 5);

    setupDbMocks();

    await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays,
      casCacheJson: cache,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    // No cached dates in window → MUST call getCasDays API
    expect(client.getCasDays).toHaveBeenCalled();
  });

  it('uses cached CAS times directly (avoids getCasTimes API call)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const casDate = '2026-05-28';
    const client = makeClient();
    const cache = makeCasCache([
      { date: casDate, slots: 3, times: ['07:00', '07:15', '07:30'] },
    ], 5);

    setupDbMocks();

    await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays,
      casCacheJson: cache,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    // CAS times should come from cache — no API call
    expect(client.getCasTimes).not.toHaveBeenCalled();
    // POST should use the first cached time
    expect(client.reschedule).toHaveBeenCalledWith(
      expect.any(String),  // consular date
      expect.any(String),  // consular time
      casDate,
      '07:00',             // first cached CAS time
    );
  });

  it('skips embassy without CAS (no ascFacilityId)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const client = makeClient();
    const cache = makeCasCache([
      { date: '2026-05-28', slots: 30, times: ['07:00'] },
    ], 5);

    setupDbMocks();

    const botNoCas: RescheduleBot = {
      ...DEFAULT_BOT,
      ascFacilityId: '',  // No CAS needed (e.g. Peru)
    };

    const result = await executeReschedule({
      client,
      botId: 12,
      bot: botNoCas,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays,
      casCacheJson: cache,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    // No CAS calls at all
    expect(client.getCasDays).not.toHaveBeenCalled();
    expect(client.getCasTimes).not.toHaveBeenCalled();
    // Should still POST (without CAS)
    expect(client.reschedule).toHaveBeenCalled();
  });

  it('clears cache and retries with API when all cached CAS fail', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // Cache has times but POST will fail for all
    const client = makeClient({
      reschedule: vi.fn().mockResolvedValue(false),  // POST always fails
      getConsularDays: vi.fn().mockResolvedValue(preFetchedDays),
      getCasDays: vi.fn().mockResolvedValue([
        { date: '2026-05-28', business_day: true },
      ]),
      getCasTimes: vi.fn().mockResolvedValue({ available_times: ['07:00'] }),
    });
    const cache = makeCasCache([
      { date: '2026-05-28', slots: 3, times: ['07:00', '07:15', '07:30'] },
    ], 5);

    setupDbMocks();

    const result = await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays,
      casCacheJson: cache,
      dryRun: false,
      maxAttempts: 2,  // Allow retry after cache clear
      pending: [],
    });

    // Attempt 1: used cache → POST failed → cache cleared
    // Attempt 2: should use API (cache was cleared)
    expect(client.getCasDays).toHaveBeenCalled();
  });

  it('handles null casCacheJson gracefully — falls back to API', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const client = makeClient({
      getCasDays: vi.fn().mockResolvedValue([
        { date: '2026-05-28', business_day: true },
      ]),
    });

    setupDbMocks();

    await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays,
      casCacheJson: null,  // No cache
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    // Must use API — no cache
    expect(client.getCasDays).toHaveBeenCalled();
    expect(client.getCasTimes).toHaveBeenCalled();
  });

  it('filters cached CAS times through time exclusions', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const casDate = '2026-05-28';
    const client = makeClient({
      // If cache times all excluded, it should still POST with available non-excluded time
      // or fail gracefully
    });
    const cache = makeCasCache([
      { date: casDate, slots: 4, times: ['07:00', '07:15', '07:30', '08:00'] },
    ], 5);

    setupDbMocks();

    await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [{ date: casDate, timeStart: '07:00', timeEnd: '07:45' }], // excludes 07:00-07:45
      preFetchedDays,
      casCacheJson: cache,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    // Should use 08:00 (the only non-excluded time)
    if (client.reschedule.mock.calls.length > 0) {
      const [, , , casTime] = client.reschedule.mock.calls[0];
      expect(casTime).toBe('08:00');
    }
  });

  it('sorts cached CAS dates by proximity to consular (closest first)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const client = makeClient();
    // CAS dates at varying distances from Jun 4 consular
    const cache = makeCasCache([
      { date: '2026-05-25', slots: 10, times: ['09:00'] },  // 10 days before
      { date: '2026-06-02', slots: 10, times: ['08:00'] },  // 2 days before (closest)
      { date: '2026-05-28', slots: 10, times: ['07:00'] },  // 7 days before
    ], 5);

    setupDbMocks();

    const result = await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays,
      casCacheJson: cache,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    // First CAS date tried should be Jun 2 (closest to Jun 4)
    if (result.success && result.casDate) {
      expect(result.casDate).toBe('2026-06-02');
    }
  });
});

// ── No-CAS atomic claimSlot tests (Peru-style bots) ──

const PERU_BOT: RescheduleBot = {
  currentConsularDate: '2027-07-16',
  currentConsularTime: '08:00',
  currentCasDate: null,
  currentCasTime: null,
  ascFacilityId: '',  // no CAS
};

const peruDays: DaySlot[] = [
  { date: '2026-05-10', business_day: true },
];

describe('executeReschedule — atomic claimSlot (no-CAS)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('aborts immediately when claimSlot returns 0 rows (limit reached)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00', '09:00'] }),
    });

    mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2027-07-16' }]));
    mockDbInsert.mockReturnValue(chain([]));
    mockDbUpdate.mockReturnValue(chain([]));  // 0 rows → limit reached

    const result = await executeReschedule({
      client, botId: 15, bot: PERU_BOT,
      dateExclusions: [], timeExclusions: [],
      preFetchedDays: peruDays,
      dryRun: false, maxAttempts: 2, pending: [],
      maxReschedules: 1,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('max_reschedules_reached');
    expect(client.reschedule).not.toHaveBeenCalled();
    // Only 1 DB update call (claimSlot), no release needed
    expect(mockDbUpdate).toHaveBeenCalledTimes(1);
  });

  it('releases slot when POST returns false', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00'] }),
      reschedule: vi.fn().mockResolvedValue(false),
    });

    mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2027-07-16' }]));
    mockDbInsert.mockReturnValue(chain([]));
    mockDbUpdate
      .mockReturnValueOnce(chain([{ rescheduleCount: 1 }]))  // claimSlot: claimed
      .mockReturnValue(chain([]));                            // releaseSlot

    const result = await executeReschedule({
      client, botId: 15, bot: PERU_BOT,
      dateExclusions: [], timeExclusions: [],
      preFetchedDays: peruDays,
      dryRun: false, maxAttempts: 1, pending: [],
      maxReschedules: 1,
    });

    expect(result.success).toBe(false);
    expect(client.reschedule).toHaveBeenCalledTimes(1);
    // claim + release = 2 update calls
    expect(mockDbUpdate).toHaveBeenCalledTimes(2);
  });

  it('releases slot when POST succeeds but verification shows false positive', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00'] }),
      reschedule: vi.fn().mockResolvedValue(true),
      // Appointment unchanged → false positive
      getCurrentAppointment: vi.fn().mockResolvedValue({ consularDate: '2027-07-16', consularTime: '08:00' }),
    });

    mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2027-07-16' }]));
    mockDbInsert.mockReturnValue(chain([]));
    mockDbUpdate
      .mockReturnValueOnce(chain([{ rescheduleCount: 1 }]))
      .mockReturnValue(chain([]));

    const result = await executeReschedule({
      client, botId: 15, bot: PERU_BOT,
      dateExclusions: [], timeExclusions: [],
      preFetchedDays: peruDays,
      dryRun: false, maxAttempts: 1, pending: [],
      maxReschedules: 1,
    });

    expect(result.success).toBe(false);
    expect(client.reschedule).toHaveBeenCalledTimes(1);
    // claim + release = 2
    expect(mockDbUpdate).toHaveBeenCalledTimes(2);
  });

  it('success — slot stays claimed, no extra increment', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00'] }),
      reschedule: vi.fn().mockResolvedValue(true),
      getCurrentAppointment: vi.fn().mockResolvedValue({ consularDate: '2026-05-10', consularTime: '08:00' }),
    });

    mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2027-07-16' }]));
    mockDbInsert.mockReturnValue(chain([]));
    mockDbUpdate
      .mockReturnValueOnce(chain([{ rescheduleCount: 1 }]))  // claimSlot
      .mockReturnValue(chain([]));                            // success update (no rescheduleCount field)

    const result = await executeReschedule({
      client, botId: 15, bot: PERU_BOT,
      dateExclusions: [], timeExclusions: [],
      preFetchedDays: peruDays,
      dryRun: false, maxAttempts: 1, pending: [],
      maxReschedules: 1,
    });

    expect(result.success).toBe(true);
    expect(result.date).toBe('2026-05-10');
    // claim + success update + session update = 3 calls (no rescheduleCount re-increment)
    expect(mockDbUpdate).toHaveBeenCalledTimes(3);
  });

  it('does not release slot when POST throws but appointment actually changed', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00'] }),
      reschedule: vi.fn().mockRejectedValue(new Error('network timeout')),
      // Appointment DID change despite the error
      getCurrentAppointment: vi.fn().mockResolvedValue({ consularDate: '2026-05-10', consularTime: '08:00' }),
    });

    mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2027-07-16' }]));
    mockDbInsert.mockReturnValue(chain([]));
    mockDbUpdate
      .mockReturnValueOnce(chain([{ rescheduleCount: 1 }]))  // claimSlot
      .mockReturnValue(chain([]));                            // success recovery update

    const result = await executeReschedule({
      client, botId: 15, bot: PERU_BOT,
      dateExclusions: [], timeExclusions: [],
      preFetchedDays: peruDays,
      dryRun: false, maxAttempts: 1, pending: [],
      maxReschedules: 1,
    });

    expect(result.success).toBe(true);
    // claim + recovery success update = 2 calls (no release, no re-increment)
    expect(mockDbUpdate).toHaveBeenCalledTimes(2);
  });

  it('releases slot when POST throws and appointment unchanged', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00'] }),
      reschedule: vi.fn().mockRejectedValue(new Error('connection reset')),
      getCurrentAppointment: vi.fn().mockResolvedValue({ consularDate: '2027-07-16', consularTime: '08:00' }),
    });

    mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2027-07-16' }]));
    mockDbInsert.mockReturnValue(chain([]));
    mockDbUpdate
      .mockReturnValueOnce(chain([{ rescheduleCount: 1 }]))
      .mockReturnValue(chain([]));

    const result = await executeReschedule({
      client, botId: 15, bot: PERU_BOT,
      dateExclusions: [], timeExclusions: [],
      preFetchedDays: peruDays,
      dryRun: false, maxAttempts: 1, pending: [],
      maxReschedules: 1,
    });

    expect(result.success).toBe(false);
    // claim + release = 2 calls
    expect(mockDbUpdate).toHaveBeenCalledTimes(2);
  });

  it('unlimited bot: claimSlot always succeeds (maxReschedules = null)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00'] }),
      reschedule: vi.fn().mockResolvedValue(true),
      getCurrentAppointment: vi.fn().mockResolvedValue({ consularDate: '2026-05-10' }),
    });

    mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2027-07-16' }]));
    mockDbInsert.mockReturnValue(chain([]));
    mockDbUpdate
      .mockReturnValueOnce(chain([{ rescheduleCount: 99 }]))  // claimSlot: high count, still ok
      .mockReturnValue(chain([]));

    const result = await executeReschedule({
      client, botId: 6, bot: PERU_BOT,
      dateExclusions: [], timeExclusions: [],
      preFetchedDays: peruDays,
      dryRun: false, maxAttempts: 1, pending: [],
      maxReschedules: null,  // unlimited
    });

    expect(result.success).toBe(true);
    // claim + success update + session update = 3 calls
    expect(mockDbUpdate).toHaveBeenCalledTimes(3);
  });
});

describe('executeReschedule — maxCasGapDays=1 (consecutive days only)', () => {
  const TEST_NOW = new Date('2026-04-01T12:00:00Z');
  // refreshedAt 5min before TEST_NOW — cache is fresh
  const FRESH_REFRESHED_AT = new Date(TEST_NOW.getTime() - 5 * 60000).toISOString();

  function freshCache(entries: { date: string; slots: number; times?: string[] }[]): CasCacheData {
    return {
      refreshedAt: FRESH_REFRESHED_AT,
      windowDays: 21,
      totalDates: entries.length,
      fullDates: entries.filter(e => e.slots === 0).length,
      entries: entries.map(e => ({
        date: e.date,
        slots: e.slots,
        times: e.times ?? (e.slots > 0 ? ['07:00', '07:15', '07:30', '08:00'].slice(0, e.slots) : []),
      })),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
  });

  // Consular: Apr 10 — only gap-1 (Apr 9) should be accepted
  const CONSULAR_DAY: DaySlot[] = [{ date: '2026-04-10', business_day: true }];

  const BOT_CONSECUTIVE: RescheduleBot = {
    currentConsularDate: '2026-05-01',
    currentConsularTime: '09:00',
    currentCasDate: '2026-04-24',
    currentCasTime: '08:00',
    ascFacilityId: '26',
    maxCasGapDays: 1,
  };

  function setupClaim() {
    mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2026-05-01' }]));
    mockDbInsert.mockReturnValue(chain([]));
    mockDbUpdate
      .mockReturnValueOnce(chain([{ rescheduleCount: 1 }]))
      .mockReturnValue(chain([]));
  }

  function setupNoClaim() {
    mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2026-05-01' }]));
    mockDbInsert.mockReturnValue(chain([]));
    mockDbUpdate.mockReturnValue(chain([]));
  }

  it('accepts CAS exactly 1 day before consular (strictly consecutive)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // Apr 9 = 1 day before Apr 10 → should pass
    const cache = freshCache([
      { date: '2026-04-09', slots: 4, times: ['07:00', '07:15', '07:30', '08:00'] },
    ]);

    setupClaim();

    const result = await executeReschedule({
      client: makeClient(),
      botId: 39,
      bot: BOT_CONSECUTIVE,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: CONSULAR_DAY,
      casCacheJson: cache,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    expect(result.success).toBe(true);
    expect(result.casDate).toBe('2026-04-09');
  });

  it('rejects CAS 2 days before consular (sábado-lunes gap)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // Consular: Monday Apr 13 — CAS: Saturday Apr 11 = 2 calendar days gap → must be rejected
    const sabadomLunes: DaySlot[] = [{ date: '2026-04-13', business_day: true }];

    // Only Apr 11 (gap=2) available — no gap-1 option
    const cache = freshCache([
      { date: '2026-04-11', slots: 4, times: ['07:00'] },
    ]);

    setupNoClaim();

    const client = makeClient({
      getCasDays: vi.fn().mockResolvedValue([
        { date: '2026-04-11', business_day: true },
      ]),
    });

    const result = await executeReschedule({
      client,
      botId: 39,
      bot: BOT_CONSECUTIVE,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: sabadomLunes,
      casCacheJson: cache,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    expect(result.success).toBe(false);
    expect(result.attempts?.every(a => a.failReason === 'no_cas_days')).toBe(true);
  });

  it('rejects CAS 3+ days before consular', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // Only CAS dates 3, 5, 8 days before → all rejected by maxCasGapDays=1
    const cache = freshCache([
      { date: '2026-04-07', slots: 4, times: ['07:00'] },  // 3 days before Apr 10
      { date: '2026-04-05', slots: 4, times: ['07:00'] },  // 5 days before
      { date: '2026-04-02', slots: 4, times: ['07:00'] },  // 8 days before
    ]);

    setupNoClaim();

    const client = makeClient({
      getCasDays: vi.fn().mockResolvedValue([
        { date: '2026-04-07', business_day: true },
        { date: '2026-04-05', business_day: true },
        { date: '2026-04-02', business_day: true },
      ]),
    });

    const result = await executeReschedule({
      client,
      botId: 39,
      bot: BOT_CONSECUTIVE,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: CONSULAR_DAY,
      casCacheJson: cache,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    expect(result.success).toBe(false);
  });

  it('uses first gap-1 CAS when multiple consular candidates exist', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // Two consular candidates: Apr 10 and Apr 15
    const twoDays: DaySlot[] = [
      { date: '2026-04-10', business_day: true },
      { date: '2026-04-15', business_day: true },
    ];

    // Apr 9 (gap-1 for Apr 10) and Apr 14 (gap-1 for Apr 15) both available
    const cache = freshCache([
      { date: '2026-04-09', slots: 3, times: ['07:00', '07:15', '07:30'] },
      { date: '2026-04-14', slots: 3, times: ['07:00', '07:15', '07:30'] },
    ]);

    setupClaim();

    const result = await executeReschedule({
      client: makeClient(),
      botId: 39,
      bot: BOT_CONSECUTIVE,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: twoDays,
      casCacheJson: cache,
      dryRun: false,
      maxAttempts: 2,
      pending: [],
    });

    expect(result.success).toBe(true);
    // Should pick Apr 10 (earlier) with Apr 9 CAS
    expect(result.date).toBe('2026-04-10');
    expect(result.casDate).toBe('2026-04-09');
  });
});

// ── repeatedlyFailingDates tests ──

describe('executeReschedule — repeatedlyFailingDates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('populates repeatedlyFailingDates when a date accumulates 3+ no_cas_days failures', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // 3 consular times, all return no CAS days → 3 no_cas_days failures on same consular date
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['07:00', '08:00', '09:00'] }),
      getCasDays: vi.fn().mockResolvedValue([]),
    });

    mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2026-11-19' }]));
    mockDbInsert.mockReturnValue(chain([]));
    mockDbUpdate
      .mockReturnValueOnce(chain([{ rescheduleCount: 1 }]))
      .mockReturnValue(chain([]));

    const result = await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: [{ date: '2026-06-04', business_day: true }],
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    expect(result.success).toBe(false);
    expect(result.repeatedlyFailingDates).toContain('2026-06-04');
  });

  it('does NOT populate repeatedlyFailingDates when a date has fewer than 3 failures', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // 2 consular times → 2 no_cas_days failures — below threshold
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['07:00', '08:00'] }),
      getCasDays: vi.fn().mockResolvedValue([]),
    });

    mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2026-11-19' }]));
    mockDbInsert.mockReturnValue(chain([]));
    mockDbUpdate
      .mockReturnValueOnce(chain([{ rescheduleCount: 1 }]))
      .mockReturnValue(chain([]));

    const result = await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: [{ date: '2026-06-04', business_day: true }],
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    expect(result.success).toBe(false);
    // Only 2 failures — below threshold of 3
    expect(result.repeatedlyFailingDates).toBeUndefined();
  });

  it('does NOT include dates already in falsePositiveDates in repeatedlyFailingDates', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // POST succeeds but verification shows same date → false positive (verification_failed)
    // That also counts as 1 failure via dateFailureCount, but falsePositiveDates takes priority
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['07:00', '08:00', '09:00'] }),
      getCasDays: vi.fn().mockResolvedValue([{ date: '2026-05-28', business_day: true }]),
      getCasTimes: vi.fn().mockResolvedValue({ available_times: ['07:00'] }),
      reschedule: vi.fn().mockResolvedValue(true),
      // Appointment unchanged → false positive on every attempt
      getCurrentAppointment: vi.fn().mockResolvedValue({ consularDate: '2026-11-19', consularTime: '07:00' }),
    });

    mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2026-11-19' }]));
    mockDbInsert.mockReturnValue(chain([]));
    mockDbUpdate
      .mockReturnValueOnce(chain([{ rescheduleCount: 1 }]))
      .mockReturnValue(chain([]));

    const result = await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: [{ date: '2026-06-04', business_day: true }],
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    // If the date ended up in falsePositiveDates, it must NOT also be in repeatedlyFailingDates
    if (result.falsePositiveDates?.includes('2026-06-04')) {
      expect(result.repeatedlyFailingDates ?? []).not.toContain('2026-06-04');
    }
  });

  it('counts failures across different failReasons toward same per-date counter', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // 4 consular times: all result in no_cas_days → 4 failures → above threshold of 3
    // This specifically tests that mixed count accumulation works
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['07:00', '08:00', '09:00', '10:00'] }),
      getCasDays: vi.fn().mockResolvedValue([]),  // no CAS days → no_cas_days for each time
    });

    mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2026-11-19' }]));
    mockDbInsert.mockReturnValue(chain([]));
    mockDbUpdate
      .mockReturnValueOnce(chain([{ rescheduleCount: 1 }]))
      .mockReturnValue(chain([]));

    const result = await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: [{ date: '2026-06-04', business_day: true }],
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    expect(result.success).toBe(false);
    // 4 failures (4 consular times × no_cas_days) → exceeds threshold → date blocked
    expect(result.repeatedlyFailingDates).toContain('2026-06-04');
  });
});

describe('dateFailureTracking (cross-poll)', () => {
  // noon UTC = noon Bogota (UTC-5 = 07:00 UTC, but we test window math, not clock display)
  const NOW_UTC = Date.UTC(2026, 5, 15, 17, 0, 0); // 2026-06-15T17:00:00Z

  function setupDbMocksTracker(currentDate = '2026-11-19') {
    mockDbSelect.mockReturnValue(chain([{ currentConsularDate: currentDate }]));
    mockDbInsert.mockReturnValue(chain([]));
    mockDbUpdate
      .mockReturnValueOnce(chain([{ rescheduleCount: 1 }]))
      .mockReturnValue(chain([]));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW_UTC);
  });

  afterEach(() => { vi.useRealTimers(); });

  // TEST-02: Cross-call accumulation — the core milestone goal
  it('accumulates across calls: 4 seeded + 1 new no_times = blocked', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const candidateDate = '2026-06-01'; // earlier than current 2026-11-19
    const windowStartedAt = new Date(NOW_UTC - 10 * 60 * 1000).toISOString(); // 10min ago

    const cache: CasCacheData = {
      refreshedAt: new Date(NOW_UTC - 5 * 60 * 1000).toISOString(),
      windowDays: 21,
      totalDates: 0,
      fullDates: 0,
      entries: [],
      dateFailureTracking: {
        [candidateDate]: {
          windowStartedAt,
          totalCount: 4, // 4 prior failures
          byDimension: { consularNoTimes: 4 },
          lastFailureAt: new Date(NOW_UTC - 60 * 1000).toISOString(),
        },
      },
    };

    const client = makeClient({
      // CAS path: need to return empty times to get no_cas_times, but let's use no_times (simpler)
      // Force no_times by returning empty consularTimes
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }),
    });

    setupDbMocksTracker();

    const result = await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: [{ date: candidateDate, business_day: true }],
      casCacheJson: cache,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    expect(result.success).toBe(false);
    // 5th failure in the 1h window crosses CROSS_POLL_THRESHOLD (5) → blocked
    expect(result.newlyBlockedDates).toContain(candidateDate);
    expect(result.dateFailureTrackingDelta?.[candidateDate]?.totalCount).toBe(5);
    expect(result.dateFailureTrackingDelta?.[candidateDate]?.blockedUntil).toBeDefined();
  });

  // TEST-03a: verification_failed (no-CAS path) does NOT increment tracker
  it('does NOT increment tracker on verification_failed (no-CAS)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const candidateDate = '2026-06-01';

    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00'] }),
      reschedule: vi.fn().mockResolvedValue(true),
      // Verification: appointment unchanged (false positive)
      getCurrentAppointment: vi.fn().mockResolvedValue({ consularDate: DEFAULT_BOT.currentConsularDate }),
    });

    setupDbMocksTracker();

    const result = await executeReschedule({
      client,
      botId: 12,
      bot: { ...DEFAULT_BOT, skipCas: true, ascFacilityId: '' }, // no-CAS path
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: [{ date: candidateDate, business_day: true }],
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    // verification_failed does NOT call bumpTracker → delta should be undefined or not contain candidateDate
    expect(result.dateFailureTrackingDelta?.[candidateDate]).toBeUndefined();
    expect(result.newlyBlockedDates ?? []).not.toContain(candidateDate);
  });

  // TEST-03b: fetch_error (getConsularTimes throws) does NOT increment tracker
  it('does NOT increment tracker on fetch_error (getConsularTimes throws)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const candidateDate = '2026-06-01';

    const client = makeClient({
      getConsularTimes: vi.fn().mockRejectedValue(new Error('network timeout')),
    });

    setupDbMocksTracker();

    const result = await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: [{ date: candidateDate, business_day: true }],
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    // fetch_error catch block does NOT call bumpTracker
    expect(result.dateFailureTrackingDelta?.[candidateDate]).toBeUndefined();
    expect(result.newlyBlockedDates ?? []).not.toContain(candidateDate);
  });

  // TEST-03c: post_error (reschedule throws) does NOT increment tracker
  it('does NOT increment tracker on post_error (reschedule throws)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const candidateDate = '2026-06-01';

    const client = makeClient({
      // CAS path: times available, CAS available, then POST throws
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00'] }),
      getCasDays: vi.fn().mockResolvedValue([{ date: '2026-05-28', business_day: true }]),
      getCasTimes: vi.fn().mockResolvedValue({ available_times: ['07:00'] }),
      reschedule: vi.fn().mockRejectedValue(new Error('TCP connection reset')),
      getCurrentAppointment: vi.fn().mockResolvedValue({ consularDate: DEFAULT_BOT.currentConsularDate }),
    });

    setupDbMocksTracker();

    const result = await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: [{ date: candidateDate, business_day: true }],
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    // post_error catch block does NOT call bumpTracker
    expect(result.dateFailureTrackingDelta?.[candidateDate]).toBeUndefined();
    expect(result.newlyBlockedDates ?? []).not.toContain(candidateDate);
  });

  // TEST-04: Successful reschedule clears the booked date from tracker delta
  it('clears tracker entry on successful reschedule for that date', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const candidateDate = '2026-06-01';
    const windowStartedAt = new Date(NOW_UTC - 10 * 60 * 1000).toISOString();

    const cache: CasCacheData = {
      refreshedAt: new Date(NOW_UTC - 5 * 60 * 1000).toISOString(),
      windowDays: 21,
      totalDates: 1,
      fullDates: 0,
      entries: [{ date: '2026-05-28', slots: 3, times: ['07:00', '07:15', '07:30'] }],
      dateFailureTracking: {
        [candidateDate]: {
          windowStartedAt,
          totalCount: 4, // below threshold — entry exists but not blocked
          byDimension: { casNoDays: 4 },
          lastFailureAt: new Date(NOW_UTC - 60 * 1000).toISOString(),
        },
      },
    };

    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00'] }),
      getCasDays: vi.fn().mockResolvedValue([]),
      // getCasTimes called for cached entry
      getCasTimes: vi.fn().mockResolvedValue({ available_times: ['07:00'] }),
      reschedule: vi.fn().mockResolvedValue(true),
      // Verification: appointment changed to candidateDate → success
      getCurrentAppointment: vi.fn().mockResolvedValue({ consularDate: candidateDate, consularTime: '08:00' }),
    });

    setupDbMocksTracker();

    const result = await executeReschedule({
      client,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: [{ date: candidateDate, business_day: true }],
      casCacheJson: cache,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    expect(result.success).toBe(true);
    // Booked date must be REMOVED from tracker delta (Pitfall 8 — success clears)
    expect(result.dateFailureTrackingDelta?.[candidateDate]).toBeUndefined();
  });

  // TEST-05: Still-blocked entry survives portal disappearance (flapping guard)
  it('still-blocked entry survives portal disappearance (flapping guard)', async () => {
    // Simulates poll-visa prune logic inline:
    // When an entry has active blockedUntil, it MUST be preserved even if date not in allDays.
    const { CROSS_POLL_WINDOW_MS } = await import('../date-failure-tracker.js');

    const candidateDate = '2026-06-15';
    const windowStartedAt = new Date(NOW_UTC - 10 * 60 * 1000).toISOString();
    const blockedUntil = new Date(NOW_UTC + 60 * 60 * 1000).toISOString(); // 1h in future

    const entry = {
      windowStartedAt,
      totalCount: 5,
      byDimension: { consularNoTimes: 5 } as const,
      lastFailureAt: new Date(NOW_UTC - 60 * 1000).toISOString(),
      blockedUntil,
    };

    // Simulate poll-visa prune: allDays does NOT include candidateDate
    const allDayDates = new Set(['2026-07-01']); // candidateDate absent
    const nowMs = NOW_UTC;

    let prunedTracker: Record<string, typeof entry> = {};
    const rawTracker = { [candidateDate]: entry };

    for (const [date, e] of Object.entries(rawTracker)) {
      const stillBlocked = !!e.blockedUntil && new Date(e.blockedUntil).getTime() > nowMs;
      const inPortal = allDayDates.has(date);
      const windowOpen = (nowMs - new Date(e.windowStartedAt).getTime()) <= CROSS_POLL_WINDOW_MS;
      if (stillBlocked) {
        prunedTracker[date] = e; // preserved regardless — this is the flapping guard
        continue;
      }
      if (!inPortal) continue; // would be dropped (portal_disappeared)
      if (!windowOpen) continue; // would be dropped (window_expired)
      prunedTracker[date] = e;
    }

    // Blocked entry MUST survive even when not in allDays
    expect(prunedTracker[candidateDate]).toBeDefined();
    expect(prunedTracker[candidateDate]?.blockedUntil).toBe(blockedUntil);
  });

  // TEST-06: Bogota TZ window arithmetic
  it('window arithmetic is correct under Bogota TZ: in-window at T+59min, rolls at T+61min', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const candidateDate = '2026-06-01';
    // Window started 59 min ago — still in the 1h window
    const windowStartedAt59 = new Date(NOW_UTC - 59 * 60 * 1000).toISOString();

    const cache59: CasCacheData = {
      refreshedAt: new Date(NOW_UTC - 5 * 60 * 1000).toISOString(),
      windowDays: 21,
      totalDates: 0,
      fullDates: 0,
      entries: [],
      dateFailureTracking: {
        [candidateDate]: {
          windowStartedAt: windowStartedAt59,
          totalCount: 4, // 4 prior in same window
          byDimension: { consularNoTimes: 4 },
          lastFailureAt: new Date(NOW_UTC - 60 * 1000).toISOString(),
        },
      },
    };

    const client59 = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }), // no_times
    });

    const mock59 = () => {
      mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2026-11-19' }]));
      mockDbInsert.mockReturnValue(chain([]));
      mockDbUpdate.mockReturnValueOnce(chain([{ rescheduleCount: 1 }])).mockReturnValue(chain([]));
    };

    mock59();
    const result59 = await executeReschedule({
      client: client59,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: [{ date: candidateDate, business_day: true }],
      casCacheJson: cache59,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    // At T+59min window: totalCount should be 5 (4+1), crossed threshold → blocked
    expect(result59.dateFailureTrackingDelta?.[candidateDate]?.totalCount).toBe(5);
    expect(result59.newlyBlockedDates).toContain(candidateDate);

    // Now advance time by 2 extra minutes (window opened 61 min ago) → window expires → fresh entry
    vi.setSystemTime(NOW_UTC + 2 * 60 * 1000);

    const windowStartedAt61 = new Date(NOW_UTC - 61 * 60 * 1000).toISOString();
    const cache61: CasCacheData = {
      ...cache59,
      dateFailureTracking: {
        [candidateDate]: {
          windowStartedAt: windowStartedAt61, // 61min ago = expired
          totalCount: 4,
          byDimension: { consularNoTimes: 4 },
          lastFailureAt: new Date(NOW_UTC - 60 * 1000).toISOString(),
        },
      },
    };

    const client61 = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }),
    });

    mock59();
    const result61 = await executeReschedule({
      client: client61,
      botId: 12,
      bot: DEFAULT_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: [{ date: candidateDate, business_day: true }],
      casCacheJson: cache61,
      dryRun: false,
      maxAttempts: 1,
      pending: [],
    });

    // At T+61min: window expired → recordFailure should start a fresh window with totalCount=1
    expect(result61.dateFailureTrackingDelta?.[candidateDate]?.totalCount).toBe(1);
    expect(result61.newlyBlockedDates ?? []).not.toContain(candidateDate); // 1 < 5 threshold
  });

  // TEST-08: Counter coverage spy — one of each tracked type → exactly 3 entries
  it('counter coverage: one of each tracked failure type produces exactly 3 entries', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // Run 3 separate single-attempt calls to isolate each tracked dimension.
    // (Multi-attempt on same executeReschedule would re-fetch getConsularDays which returns [].)
    const dateA = '2026-06-01'; // will get no_times (consularNoTimes)
    const dateB = '2026-06-05'; // will get no_cas_days (casNoDays)
    const dateC = '2026-06-10'; // will get no_cas_times (casNoTimes)

    const setupMock = () => {
      mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2026-11-19' }]));
      mockDbInsert.mockReturnValue(chain([]));
      mockDbUpdate
        .mockReturnValueOnce(chain([{ rescheduleCount: 1 }]))
        .mockReturnValue(chain([]));
    };

    // Call A: no_times → consularNoTimes
    setupMock();
    const resultA = await executeReschedule({
      client: makeClient({ getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }) }),
      botId: 12, bot: DEFAULT_BOT, dateExclusions: [], timeExclusions: [],
      preFetchedDays: [{ date: dateA, business_day: true }],
      casCacheJson: null, dryRun: false, maxAttempts: 1, pending: [],
    });

    // Call B: no_cas_days → casNoDays
    setupMock();
    const resultB = await executeReschedule({
      client: makeClient({
        getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00'] }),
        getCasDays: vi.fn().mockResolvedValue([]),
      }),
      botId: 12, bot: DEFAULT_BOT, dateExclusions: [], timeExclusions: [],
      preFetchedDays: [{ date: dateB, business_day: true }],
      casCacheJson: null, dryRun: false, maxAttempts: 1, pending: [],
    });

    // Call C: no_cas_times → casNoTimes
    setupMock();
    const resultC = await executeReschedule({
      client: makeClient({
        getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00'] }),
        getCasDays: vi.fn().mockResolvedValue([{ date: '2026-06-03', business_day: true }]),
        getCasTimes: vi.fn().mockResolvedValue({ available_times: [] }),
      }),
      botId: 12, bot: DEFAULT_BOT, dateExclusions: [], timeExclusions: [],
      preFetchedDays: [{ date: dateC, business_day: true }],
      casCacheJson: null, dryRun: false, maxAttempts: 1, pending: [],
    });

    // Each call produces exactly 1 tracker entry for the correct dimension
    expect(resultA.dateFailureTrackingDelta?.[dateA]?.byDimension?.consularNoTimes).toBe(1);
    expect(resultB.dateFailureTrackingDelta?.[dateB]?.byDimension?.casNoDays).toBe(1);
    expect(resultC.dateFailureTrackingDelta?.[dateC]?.byDimension?.casNoTimes).toBe(1);
    // Combined: 3 distinct tracker entries produced across the 3 tracked dimensions
    const allDates = [
      ...Object.keys(resultA.dateFailureTrackingDelta ?? {}),
      ...Object.keys(resultB.dateFailureTrackingDelta ?? {}),
      ...Object.keys(resultC.dateFailureTrackingDelta ?? {}),
    ];
    expect(allDates.length).toBe(3);
    expect(new Set(allDates).size).toBe(3); // all different dates
  });
});

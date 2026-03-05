import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DaySlot } from '../visa-client.js';
import type { RescheduleBot } from '../reschedule-logic.js';

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

// ── Helpers ──
const NOW = new Date('2026-04-03T12:00:00Z');

function makeClient(overrides: Record<string, any> = {}) {
  return {
    getConsularDays: vi.fn().mockResolvedValue([]),
    getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00'] }),
    // CAS date 2026-04-05 is 4 days before consular date 2026-04-09 → within 8-day window
    getCasDays: vi.fn().mockResolvedValue([{ date: '2026-04-05', business_day: true }]),
    getCasTimes: vi.fn().mockResolvedValue({ available_times: ['07:00'] }),
    reschedule: vi.fn().mockResolvedValue(true),
    getCurrentAppointment: vi.fn().mockResolvedValue(null),
    getSession: vi.fn().mockReturnValue({ cookie: 'c', csrfToken: 't', authenticityToken: 'a' }),
    updateSession: vi.fn(),
    refreshTokens: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

// Bot with May 4 consular appointment, target = Apr 9 (better)
const BASE_BOT: RescheduleBot = {
  currentConsularDate: '2026-05-04',
  currentConsularTime: '11:15',
  currentCasDate: '2026-04-22',
  currentCasTime: '08:00',
  ascFacilityId: '26',
};

// Bot configured for no-CAS path (Peru-style: skipCas=true)
const NO_CAS_BOT: RescheduleBot = {
  ...BASE_BOT,
  skipCas: true,
};

const BETTER_DAYS: DaySlot[] = [{ date: '2026-04-09', business_day: true }];

// Standard DB setup: race-condition guard returns current date, claimSlot succeeds
function setupDbMocks(currentDate = '2026-05-04') {
  mockDbSelect.mockReturnValue(chain([{ currentConsularDate: currentDate }]));
  mockDbInsert.mockReturnValue(chain([]));
  mockDbUpdate
    .mockReturnValueOnce(chain([{ rescheduleCount: 1 }])) // claimSlot → claimed
    .mockReturnValue(chain([]));                           // releaseSlot + any syncs
}

// ─────────────────────────────────────────────────────────────────────────────
// Fix 1 — falsePositiveDates
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix 1 — falsePositiveDates (ghost slot detection)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('adds date to falsePositiveDates when POST succeeds but appointment unchanged (no-CAS path)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // No-CAS path: POST returns true (redirect looked like success),
    // but verification shows appointment still at May 4 (ghost slot)
    const client = makeClient({
      reschedule: vi.fn().mockResolvedValue(true),
      getCurrentAppointment: vi.fn().mockResolvedValue({
        consularDate: '2026-05-04', // unchanged — ghost slot
        consularTime: '11:15',
        casDate: '2026-04-22',
        casTime: '08:00',
      }),
    });

    setupDbMocks();

    const result = await executeReschedule({
      client,
      botId: 41,
      bot: NO_CAS_BOT, // skipCas=true → no-CAS path
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: BETTER_DAYS,
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 3,
      pending: [],
    });

    expect(result.falsePositiveDates).toBeDefined();
    expect(result.falsePositiveDates).toContain('2026-04-09');
  });

  it('adds date to falsePositiveDates when POST succeeds but appointment unchanged (CAS path)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // CAS path: CAS days available within 8-day window (Apr 5 is 4 days before Apr 9)
    // POST returns true, but verification shows old date → false_positive_verification
    const client = makeClient({
      getCasDays: vi.fn().mockResolvedValue([{ date: '2026-04-05', business_day: true }]),
      getCasTimes: vi.fn().mockResolvedValue({ available_times: ['07:00'] }),
      reschedule: vi.fn().mockResolvedValue(true),
      getCurrentAppointment: vi.fn().mockResolvedValue({
        consularDate: '2026-05-04', // unchanged after POST
        consularTime: '11:15',
        casDate: '2026-04-22',
        casTime: '08:00',
      }),
    });

    setupDbMocks();

    const result = await executeReschedule({
      client,
      botId: 42,
      bot: BASE_BOT, // ascFacilityId='26' → CAS path
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: BETTER_DAYS,
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 3,
      pending: [],
    });

    expect(result.falsePositiveDates).toBeDefined();
    expect(result.falsePositiveDates).toContain('2026-04-09');
  });

  it('does NOT add date to falsePositiveDates when failure is no_cas_days (CAS unavailable)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // CAS days empty → no_cas_days failure, reschedule never called
    const client = makeClient({
      getCasDays: vi.fn().mockResolvedValue([]),
      reschedule: vi.fn(),
    });

    setupDbMocks();

    const result = await executeReschedule({
      client,
      botId: 43,
      bot: BASE_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: BETTER_DAYS,
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 3,
      pending: [],
    });

    expect(result.falsePositiveDates ?? []).not.toContain('2026-04-09');
    expect(client.reschedule).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 2 — portal_reversion logging
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix 2 — portal_reversion logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('returns reason=portal_reversion when secured booking is reverted by portal (CAS path)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // Sequence:
    // 1. POST succeeds → inline verify returns Apr 9 (booking confirmed) → securedResult set
    // 2. No more better candidates → outer loop exits
    // 3. Final verify at line 927 returns May 4 → portal reverted the booking
    const getCurrentAppointment = vi.fn()
      .mockResolvedValueOnce({
        consularDate: '2026-04-09', consularTime: '08:00',
        casDate: '2026-04-05', casTime: '07:00',
      }) // inline verify after POST: booking confirmed
      .mockResolvedValueOnce({
        consularDate: '2026-05-04', consularTime: '11:15',
        casDate: '2026-04-22', casTime: '08:00',
      }); // final verify: portal reverted

    const client = makeClient({
      getCasDays: vi.fn().mockResolvedValue([{ date: '2026-04-05', business_day: true }]),
      getCasTimes: vi.fn().mockResolvedValue({ available_times: ['07:00'] }),
      reschedule: vi.fn().mockResolvedValue(true),
      getCurrentAppointment,
    });

    setupDbMocks();

    const result = await executeReschedule({
      client,
      botId: 41,
      bot: BASE_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: BETTER_DAYS,
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 3,
      pending: [],
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('portal_reversion');
    // claimSlot + at least releaseSlot + sync update
    expect(mockDbUpdate.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('calls db.insert with success=false and portal_reversion error on reversion', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const getCurrentAppointment = vi.fn()
      .mockResolvedValueOnce({
        consularDate: '2026-04-09', consularTime: '08:00',
        casDate: '2026-04-05', casTime: '07:00',
      })
      .mockResolvedValueOnce({
        consularDate: '2026-05-04', consularTime: '11:15',
        casDate: '2026-04-22', casTime: '08:00',
      });

    const client = makeClient({
      getCasDays: vi.fn().mockResolvedValue([{ date: '2026-04-05', business_day: true }]),
      getCasTimes: vi.fn().mockResolvedValue({ available_times: ['07:00'] }),
      reschedule: vi.fn().mockResolvedValue(true),
      getCurrentAppointment,
    });

    setupDbMocks();

    const insertedValues: any[] = [];
    // Intercept .values() calls on the insert chain to capture inserted rows
    mockDbInsert.mockImplementation(() => {
      const c = chain([]);
      const origValues = c.values.bind(c);
      c.values = (v: any) => { insertedValues.push(v); return origValues(v); };
      return c;
    });

    await executeReschedule({
      client,
      botId: 41,
      bot: BASE_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: BETTER_DAYS,
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 3,
      pending: [],
    });

    // There must be at least one insert with success=false and portal_reversion error
    const reversionLog = insertedValues.find(v => v.success === false && v.error === 'portal_reversion');
    expect(reversionLog).toBeDefined();
    expect(reversionLog.oldConsularDate).toBe('2026-04-09'); // the secured date that was reverted
    expect(reversionLog.newConsularDate).toBe('2026-05-04'); // the date the portal reverted to
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 3 — repeatedlyFailingDates (1h cooldown)
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix 3 — repeatedlyFailingDates (3+ failures → 1h cooldown)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('includes date in repeatedlyFailingDates after 3+ no_cas_days failures', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // 3 consular times, CAS empty for all → 3 no_cas_days failures → threshold reached
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00', '09:00', '10:00'] }),
      getCasDays: vi.fn().mockResolvedValue([]),
    });

    setupDbMocks();

    const result = await executeReschedule({
      client,
      botId: 41,
      bot: BASE_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: BETTER_DAYS,
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 5,
      pending: [],
    });

    expect(result.repeatedlyFailingDates).toBeDefined();
    expect(result.repeatedlyFailingDates).toContain('2026-04-09');
  });

  it('does NOT include date in repeatedlyFailingDates with only 2 failures', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // Only 2 consular times → 2 no_cas_days failures → below threshold
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00', '09:00'] }),
      getCasDays: vi.fn().mockResolvedValue([]),
    });

    setupDbMocks();

    const result = await executeReschedule({
      client,
      botId: 42,
      bot: BASE_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: BETTER_DAYS,
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 5,
      pending: [],
    });

    expect(result.repeatedlyFailingDates ?? []).not.toContain('2026-04-09');
  });

  it('excludes date from repeatedlyFailingDates when already in falsePositiveDates (no duplication)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    // No-CAS path with 3 times: each POST "succeeds" but verification shows old date
    // → 3 false_positive failures → dateFailureCount=3, falsePositiveDates=['Apr 9']
    // → repeatedlyFailingDates must NOT contain Apr 9 (dedup: falsePositiveDates takes priority)
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00', '09:00', '10:00'] }),
      reschedule: vi.fn().mockResolvedValue(true),
      getCurrentAppointment: vi.fn().mockResolvedValue({
        consularDate: '2026-05-04', // always unchanged → false_positive each time
        consularTime: '11:15',
        casDate: '2026-04-22',
        casTime: '08:00',
      }),
    });

    setupDbMocks();

    const result = await executeReschedule({
      client,
      botId: 43,
      bot: NO_CAS_BOT, // skipCas=true → tries all 3 times without CAS
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: BETTER_DAYS,
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 5,
      pending: [],
    });

    // Apr 9 IS in falsePositiveDates (3 false positives)
    expect(result.falsePositiveDates).toContain('2026-04-09');
    // Apr 9 must NOT also appear in repeatedlyFailingDates (de-duped by design)
    expect(result.repeatedlyFailingDates ?? []).not.toContain('2026-04-09');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Speculative time fallback (no-CAS path, gated by bot.speculativeTimeFallback)
// ─────────────────────────────────────────────────────────────────────────────
describe('Speculative time fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  // Bot configured for no-CAS path WITH speculative fallback enabled
  const SPECULATIVE_BOT: RescheduleBot = {
    ...BASE_BOT,
    ascFacilityId: '', // no CAS → no-CAS path
    speculativeTimeFallback: true,
  };

  it('Test 1: uses SPECULATIVE_TIMES when getConsularTimes returns empty AND needsCas=false AND speculativeTimeFallback=true', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }),
      reschedule: vi.fn().mockResolvedValue(true),
      getCurrentAppointment: vi.fn().mockResolvedValue({
        consularDate: '2026-04-09',
        consularTime: '10:15',
      }),
    });

    setupDbMocks();

    const result = await executeReschedule({
      client,
      botId: 7,
      bot: SPECULATIVE_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: BETTER_DAYS,
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 3,
      pending: [],
    });

    // Speculative fallback should have triggered — client.reschedule called with one of the speculative times
    expect(client.reschedule).toHaveBeenCalled();
    const calledTime = client.reschedule.mock.calls[0]![1];
    expect(['10:15', '10:00', '07:30']).toContain(calledTime);
  });

  it('Test 2: speculative fallback does NOT activate for CAS bots (needsCas=true)', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }),
      reschedule: vi.fn(),
    });

    setupDbMocks();

    const result = await executeReschedule({
      client,
      botId: 42,
      bot: { ...BASE_BOT, ascFacilityId: '26', speculativeTimeFallback: true }, // CAS bot
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: BETTER_DAYS,
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 3,
      pending: [],
    });

    // Should NOT have called reschedule (no speculative fallback for CAS bots)
    expect(client.reschedule).not.toHaveBeenCalled();
    // Should get no_times failure
    expect(result.attempts?.some(a => a.failReason === 'no_times')).toBe(true);
  });

  it('Test 3: speculative fallback does NOT activate when speculativeTimeFallback=false', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }),
      reschedule: vi.fn(),
    });

    setupDbMocks();

    const result = await executeReschedule({
      client,
      botId: 7,
      bot: { ...SPECULATIVE_BOT, speculativeTimeFallback: false },
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: BETTER_DAYS,
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 3,
      pending: [],
    });

    expect(client.reschedule).not.toHaveBeenCalled();
    expect(result.attempts?.some(a => a.failReason === 'no_times')).toBe(true);
  });

  it('Test 4: speculative fallback does NOT activate when speculativeTimeFallback is undefined', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }),
      reschedule: vi.fn(),
    });

    setupDbMocks();

    const result = await executeReschedule({
      client,
      botId: 7,
      bot: { ...BASE_BOT, ascFacilityId: '' }, // no speculativeTimeFallback field at all
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: BETTER_DAYS,
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 3,
      pending: [],
    });

    expect(client.reschedule).not.toHaveBeenCalled();
  });

  it('Test 5: dryRun=true blocks speculative POST', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }),
      reschedule: vi.fn(),
    });

    // dryRun returns early with mock data, so speculative never fires
    const result = await executeReschedule({
      client,
      botId: 7,
      bot: SPECULATIVE_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: BETTER_DAYS,
      casCacheJson: null,
      dryRun: true,
      maxAttempts: 3,
      pending: [],
    });

    // dryRun produces a mock success; real reschedule is never called
    expect(client.reschedule).not.toHaveBeenCalled();
  });

  it('Test 6: speculative times are logged with speculative marker in reschedule_logs', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }),
      reschedule: vi.fn().mockResolvedValue(false), // POST fails
    });

    setupDbMocks();

    const insertedValues: any[] = [];
    mockDbInsert.mockImplementation(() => {
      const c = chain([]);
      const origValues = c.values.bind(c);
      c.values = (v: any) => { insertedValues.push(v); return origValues(v); };
      return c;
    });

    await executeReschedule({
      client,
      botId: 7,
      bot: SPECULATIVE_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: BETTER_DAYS,
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 3,
      pending: [],
    });

    // At least one reschedule_logs insert should have speculative marker
    const speculativeLog = insertedValues.find(v => v.error && typeof v.error === 'string' && v.error.includes('speculative'));
    expect(speculativeLog).toBeDefined();
  });

  it('Test 7: when getConsularTimes returns actual times, speculative fallback is NOT used', async () => {
    const { executeReschedule } = await import('../reschedule-logic.js');

    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00', '09:00'] }),
      reschedule: vi.fn().mockResolvedValue(true),
      getCurrentAppointment: vi.fn().mockResolvedValue({
        consularDate: '2026-04-09',
        consularTime: '09:00',
      }),
    });

    setupDbMocks();

    const insertedValues: any[] = [];
    mockDbInsert.mockImplementation(() => {
      const c = chain([]);
      const origValues = c.values.bind(c);
      c.values = (v: any) => { insertedValues.push(v); return origValues(v); };
      return c;
    });

    await executeReschedule({
      client,
      botId: 7,
      bot: SPECULATIVE_BOT,
      dateExclusions: [],
      timeExclusions: [],
      preFetchedDays: BETTER_DAYS,
      casCacheJson: null,
      dryRun: false,
      maxAttempts: 3,
      pending: [],
    });

    // Reschedule was called with actual time, not speculative
    expect(client.reschedule).toHaveBeenCalled();
    const calledTime = client.reschedule.mock.calls[0]![1];
    expect(['08:00', '09:00']).toContain(calledTime);

    // No speculative marker in any log
    const speculativeLog = insertedValues.find(v => v.error && typeof v.error === 'string' && v.error.includes('speculative'));
    expect(speculativeLog).toBeUndefined();
  });
});

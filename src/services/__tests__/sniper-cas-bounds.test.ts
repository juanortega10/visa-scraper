import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DaySlot } from '../visa-client.js';
import type { RescheduleBot } from '../reschedule-logic.js';

// ── DB mock (same shape as reschedule-cas-cache.test.ts) ──
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
  bots: { _name: 'bots', id: 'bots.id', currentConsularDate: 'bots.currentConsularDate', rescheduleCount: 'bots.rescheduleCount', portalRemainingReschedules: 'bots.portalRemainingReschedules' },
  sessions: { _name: 'sessions', botId: 'sessions.botId' },
  rescheduleLogs: { _name: 'rescheduleLogs' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  sql: (strings: TemplateStringsArray) => `sql:${strings.join('')}`,
  or: (...args: any[]) => ({ _op: 'or', args }),
  lt: (...args: any[]) => ({ _op: 'lt', args }),
  gt: (...args: any[]) => ({ _op: 'gt', args }),
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

const NOW = new Date('2026-08-12T12:00:00Z');

/** Sniper window of bot 247: 2026-09-05 (inclusive) → 2026-10-30 (exclusive). */
const WINDOW = { targetDateAfter: '2026-09-05', targetDateBefore: '2026-10-30' };

function makeClient(overrides: Record<string, any> = {}) {
  return {
    getConsularDays: vi.fn().mockResolvedValue([]),
    getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['09:15'] }),
    getCasDays: vi.fn().mockResolvedValue([]),
    getCasTimes: vi.fn().mockResolvedValue({ available_times: ['07:45'] }),
    reschedule: vi.fn().mockResolvedValue(true),
    getCurrentAppointment: vi.fn().mockResolvedValue(null),
    getSession: vi.fn().mockReturnValue({ cookie: 'c', csrfToken: 't', authenticityToken: 'a' }),
    getConfig: vi.fn().mockReturnValue({ proxyProvider: 'direct' }),
    updateSession: vi.fn(),
    refreshTokens: vi.fn().mockResolvedValue(undefined),
    // Edad del token precalentado. Infinity = desconocida, o sea siempre se refresca:
    // es el comportamiento historico que estos casos ya cubren.
    getTokensAgeMs: vi.fn().mockReturnValue(Number.POSITIVE_INFINITY),
    getTokensRefreshedAt: vi.fn().mockReturnValue(null),
    ensureTokens: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as any;
}

function makeBot(currentConsularDate: string): RescheduleBot {
  return {
    currentConsularDate,
    currentConsularTime: '09:30',
    currentCasDate: '2027-02-24',
    currentCasTime: '08:45',
    ascFacilityId: '26',
    sniperMode: true,
    ...WINDOW,
  };
}

function setupDbMocks(currentDate: string) {
  mockDbSelect.mockReturnValue(chain([{ currentConsularDate: currentDate }]));
  mockDbInsert.mockReturnValue(chain([]));
  mockDbUpdate.mockReturnValue(chain([{ rescheduleCount: 1 }]));
}

/** getCasDays mock driven by a consular date → CAS dates map. */
function casDaysFor(map: Record<string, string[]>) {
  return vi.fn().mockImplementation(async (consularDate: string): Promise<DaySlot[]> =>
    (map[consularDate] ?? []).map((date) => ({ date, business_day: true })));
}

async function run(opts: {
  bot: RescheduleBot;
  client: any;
  days: DaySlot[];
  maxAttempts?: number;
}) {
  const { executeReschedule } = await import('../reschedule-logic.js');
  return executeReschedule({
    client: opts.client,
    botId: 247,
    bot: opts.bot,
    dateExclusions: [],
    timeExclusions: [],
    preFetchedDays: opts.days,
    casCacheJson: null,
    dryRun: false,
    maxAttempts: opts.maxAttempts ?? 2,
    pending: [],
  });
}

describe('sniper window bounds — CAS date', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('rejects a consular date whose only CAS days fall BEFORE targetDateAfter', async () => {
    const client = makeClient({
      getConsularDays: vi.fn().mockResolvedValue([{ date: '2026-09-07', business_day: true }]),
      getCasDays: casDaysFor({ '2026-09-07': ['2026-09-01', '2026-09-03'] }),
    });
    setupDbMocks('2027-03-04');

    const result = await run({
      bot: makeBot('2027-03-04'),
      client,
      days: [{ date: '2026-09-07', business_day: true }],
    });

    expect(client.reschedule).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('picks the consular date whose CAS day fits inside the window', async () => {
    const days: DaySlot[] = [
      { date: '2026-09-07', business_day: true },  // CAS only pre-window
      { date: '2026-09-21', business_day: true },  // CAS in-window
    ];
    const client = makeClient({
      getConsularDays: vi.fn().mockResolvedValue(days),
      getCasDays: casDaysFor({
        '2026-09-07': ['2026-09-02'],
        '2026-09-21': ['2026-09-16'],
      }),
    });
    setupDbMocks('2027-03-04');

    const result = await run({ bot: makeBot('2027-03-04'), client, days });

    expect(client.reschedule).toHaveBeenCalledTimes(1);
    expect(client.reschedule).toHaveBeenCalledWith('2026-09-21', '09:15', '2026-09-16', '07:45');
    expect(result.success).toBe(true);
    expect(result.casDate).toBe('2026-09-16');
  });

  it('rejects a CAS day at or after targetDateBefore', async () => {
    // Consular 2026-10-29 is the last in-window day; its CAS options are all >= 2026-10-30.
    const client = makeClient({
      getConsularDays: vi.fn().mockResolvedValue([{ date: '2026-10-29', business_day: true }]),
      getCasDays: casDaysFor({ '2026-10-29': ['2026-10-30', '2026-10-31'] }),
    });
    setupDbMocks('2027-03-04');

    const result = await run({
      bot: makeBot('2027-03-04'),
      client,
      days: [{ date: '2026-10-29', business_day: true }],
    });

    expect(client.reschedule).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});

describe('sniper window bounds — never move later once in-window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('takes a LATER in-window date while the appointment is still OUTSIDE the window', async () => {
    const days: DaySlot[] = [{ date: '2026-10-05', business_day: true }];
    const client = makeClient({
      getConsularDays: vi.fn().mockResolvedValue(days),
      getCasDays: casDaysFor({ '2026-10-05': ['2026-09-30'] }),
    });
    setupDbMocks('2027-03-04');

    const result = await run({ bot: makeBot('2027-03-04'), client, days });

    expect(result.success).toBe(true);
    expect(result.date).toBe('2026-10-05');
  });

  it('REFUSES a later in-window date once the appointment is already in-window', async () => {
    const days: DaySlot[] = [{ date: '2026-10-05', business_day: true }];
    const client = makeClient({
      getConsularDays: vi.fn().mockResolvedValue(days),
      getCasDays: casDaysFor({ '2026-10-05': ['2026-09-30'] }),
    });
    setupDbMocks('2026-09-20');

    const result = await run({ bot: makeBot('2026-09-20'), client, days });

    expect(client.reschedule).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('still improves to an earlier in-window date', async () => {
    const days: DaySlot[] = [{ date: '2026-09-08', business_day: true }];
    const client = makeClient({
      getConsularDays: vi.fn().mockResolvedValue(days),
      getCasDays: casDaysFor({ '2026-09-08': ['2026-09-06'] }),
    });
    setupDbMocks('2026-09-20');

    const result = await run({ bot: makeBot('2026-09-20'), client, days });

    expect(result.success).toBe(true);
    expect(result.date).toBe('2026-09-08');
    expect(result.casDate).toBe('2026-09-06');
  });

  it('keeps improving inside one invocation: secures, then takes an earlier date', async () => {
    // Attempt 1 sees only 2026-10-05; attempt 2 (re-fetch) sees an earlier 2026-09-15.
    const first: DaySlot[] = [{ date: '2026-10-05', business_day: true }];
    const second: DaySlot[] = [
      { date: '2026-09-15', business_day: true },
      { date: '2026-10-05', business_day: true },
    ];
    const client = makeClient({
      getConsularDays: vi.fn().mockResolvedValue(second),
      getCasDays: casDaysFor({
        '2026-10-05': ['2026-09-30'],
        '2026-09-15': ['2026-09-10'],
      }),
    });
    setupDbMocks('2027-03-04');

    const result = await run({ bot: makeBot('2027-03-04'), client, days: first, maxAttempts: 3 });

    expect(result.success).toBe(true);
    expect(result.date).toBe('2026-09-15');
    expect(client.reschedule).toHaveBeenCalledWith('2026-10-05', '09:15', '2026-09-30', '07:45');
    expect(client.reschedule).toHaveBeenCalledWith('2026-09-15', '09:15', '2026-09-10', '07:45');
  });
});

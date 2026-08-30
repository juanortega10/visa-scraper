import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DaySlot } from '../visa-client.js';
import type { RescheduleBot } from '../reschedule-logic.js';

// ── Configurable DB mock (same harness as reschedule-stability-fixes.test.ts) ──
const { mockDbSelect, mockDbUpdate, mockDbInsert } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbInsert: vi.fn(),
}));

const { mockNotifyTrigger } = vi.hoisted(() => ({
  mockNotifyTrigger: vi.fn().mockResolvedValue({}),
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
  sql: (strings: TemplateStringsArray, ..._vals: any[]) => `sql:${strings.join('')}`,
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
  notifyUserTask: { trigger: (...args: any[]) => mockNotifyTrigger(...args) },
}));

vi.mock('../encryption.js', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace('enc:', ''),
}));

// ── Fixtures ──
const NOW = new Date('2026-04-03T12:00:00Z');

function makeClient(overrides: Record<string, any> = {}) {
  return {
    getConsularDays: vi.fn().mockResolvedValue([]),
    getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['08:00'] }),
    getCasDays: vi.fn().mockResolvedValue([{ date: '2026-04-05', business_day: true }]),
    getCasTimes: vi.fn().mockResolvedValue({ available_times: ['07:00'] }),
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

const BASE_BOT: RescheduleBot = {
  currentConsularDate: '2026-05-04',
  currentConsularTime: '11:15',
  currentCasDate: '2026-04-22',
  currentCasTime: '08:00',
  ascFacilityId: '26',
  minDaysFromToday: 0,
};

const NO_CAS_BOT: RescheduleBot = { ...BASE_BOT, skipCas: true };

// The only date the bot can target in these tests.
const TARGET = '2026-04-09';
const BETTER_DAYS: DaySlot[] = [{ date: TARGET, business_day: true }];

function setupDbMocks(currentDate = '2026-05-04') {
  mockDbSelect.mockReturnValue(chain([{ currentConsularDate: currentDate }]));
  mockDbInsert.mockReturnValue(chain([]));
  mockDbUpdate
    .mockReturnValueOnce(chain([{ rescheduleCount: 1 }])) // claimSlot → claimed
    .mockReturnValue(chain([]));                           // releaseSlot + syncs
}

// Capture every row written to rescheduleLogs.
function captureInserts(): any[] {
  const rows: any[] = [];
  mockDbInsert.mockImplementation(() => {
    const c = chain([]);
    const origValues = c.values.bind(c);
    c.values = (v: any) => { rows.push(v); return origValues(v); };
    return c;
  });
  return rows;
}

async function run(botId: number, bot: RescheduleBot, client: any) {
  const { executeReschedule } = await import('../reschedule-logic.js');
  return executeReschedule({
    client,
    botId,
    bot,
    dateExclusions: [],
    timeExclusions: [],
    preFetchedDays: BETTER_DAYS,
    casCacheJson: null,
    dryRun: false,
    maxAttempts: 1,
    pending: [],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Attribution guard — post_error safety net must not credit external changes
//
// Regression: bot 266, 2026-08-05. The POST threw `fetch failed`. The safety net
// re-read /groups, saw the date had changed from 2027-04-20 to 2026-11-24, and
// logged success=true `[post_error_recovered]`. The bot had targeted 2026-09-11.
// The owner had rescheduled by hand. 147 days were billed to the bot in error.
// ─────────────────────────────────────────────────────────────────────────────
describe('post_error safety net — attribution guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockNotifyTrigger.mockResolvedValue({});
  });

  it('does NOT credit the bot when the portal lands on a date the bot never targeted (CAS path)', async () => {
    // POST throws; re-read shows an EARLIER date that is not the bot's target.
    const client = makeClient({
      reschedule: vi.fn().mockRejectedValue(new Error('fetch failed')),
      getCurrentAppointment: vi.fn().mockResolvedValue({
        consularDate: '2026-04-20', // earlier than 2026-05-04, but != TARGET (2026-04-09)
        consularTime: '07:15',
        casDate: '2026-04-14',
        casTime: '07:30',
      }),
    });
    setupDbMocks();
    const rows = captureInserts();

    const result = await run(266, BASE_BOT, client);

    // No success row anywhere.
    expect(rows.filter(r => r.success === true)).toHaveLength(0);
    // The external change is recorded, with both dates, for the audit trail.
    const ext = rows.find(r => typeof r.error === 'string' && r.error.startsWith('[external_change]'));
    expect(ext).toBeDefined();
    expect(ext.success).toBe(false);
    expect(ext.error).toContain(`target=${TARGET}`);
    expect(ext.error).toContain('actual=2026-04-20');
    expect(ext.oldConsularDate).toBe('2026-05-04');
    expect(ext.newConsularDate).toBe('2026-04-20');
    // The run is not a success.
    expect(result.success).toBe(false);
  });

  it('does NOT credit the bot when the portal lands on a date the bot never targeted (no-CAS path)', async () => {
    const client = makeClient({
      reschedule: vi.fn().mockRejectedValue(new Error('fetch failed')),
      getCurrentAppointment: vi.fn().mockResolvedValue({
        consularDate: '2026-04-20',
        consularTime: '07:15',
        casDate: null,
        casTime: null,
      }),
    });
    setupDbMocks();
    const rows = captureInserts();

    const result = await run(266, NO_CAS_BOT, client);

    expect(rows.filter(r => r.success === true)).toHaveLength(0);
    expect(rows.some(r => typeof r.error === 'string' && r.error.startsWith('[external_change]'))).toBe(true);
    expect(result.success).toBe(false);
  });

  it('does NOT send a reschedule_success notification on an external change', async () => {
    const client = makeClient({
      reschedule: vi.fn().mockRejectedValue(new Error('fetch failed')),
      getCurrentAppointment: vi.fn().mockResolvedValue({
        consularDate: '2026-04-20', consularTime: '07:15',
        casDate: '2026-04-14', casTime: '07:30',
      }),
    });
    setupDbMocks();
    captureInserts();

    await run(266, BASE_BOT, client);

    const successNotifs = mockNotifyTrigger.mock.calls
      .filter(([arg]: any[]) => arg?.event === 'reschedule_success');
    expect(successNotifs).toHaveLength(0);
  });

  it('gives the reschedule allowance back on an external change (releaseSlot)', async () => {
    const client = makeClient({
      reschedule: vi.fn().mockRejectedValue(new Error('fetch failed')),
      getCurrentAppointment: vi.fn().mockResolvedValue({
        consularDate: '2026-04-20', consularTime: '07:15',
        casDate: '2026-04-14', casTime: '07:30',
      }),
    });
    setupDbMocks();
    captureInserts();

    await run(266, BASE_BOT, client);

    // claimSlot (1st update) + DB sync + releaseSlot. releaseSlot writes a
    // GREATEST(rescheduleCount - 1, 0) expression.
    const setCalls = mockDbUpdate.mock.results
      .map(r => r.value)
      .filter(Boolean);
    expect(setCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('STILL credits the bot when the portal lands on exactly the date it POSTed', async () => {
    // Same failure mode (POST throws) but the POST really landed: verify shows TARGET.
    const client = makeClient({
      reschedule: vi.fn().mockRejectedValue(new Error('fetch failed')),
      getCurrentAppointment: vi.fn().mockResolvedValue({
        consularDate: TARGET,
        consularTime: '08:00',
        casDate: '2026-04-05',
        casTime: '07:00',
      }),
    });
    setupDbMocks();
    const rows = captureInserts();

    const result = await run(266, BASE_BOT, client);

    const recovered = rows.find(r => typeof r.error === 'string' && r.error.startsWith('[post_error_recovered]'));
    expect(recovered).toBeDefined();
    expect(recovered.success).toBe(true);
    expect(recovered.newConsularDate).toBe(TARGET);
    expect(result.success).toBe(true);
    expect(result.date).toBe(TARGET);
  });

  it('keeps treating a same-or-later portal date as a reversion, not a success', async () => {
    const client = makeClient({
      reschedule: vi.fn().mockRejectedValue(new Error('fetch failed')),
      getCurrentAppointment: vi.fn().mockResolvedValue({
        consularDate: '2026-06-30', // LATER than current 2026-05-04
        consularTime: '09:00',
        casDate: null, casTime: null,
      }),
    });
    setupDbMocks();
    const rows = captureInserts();

    const result = await run(266, BASE_BOT, client);

    expect(rows.filter(r => r.success === true)).toHaveLength(0);
    expect(result.success).toBe(false);
  });

  it('does not fire the guard when the appointment did not change at all', async () => {
    const client = makeClient({
      reschedule: vi.fn().mockRejectedValue(new Error('fetch failed')),
      getCurrentAppointment: vi.fn().mockResolvedValue({
        consularDate: '2026-05-04', // unchanged
        consularTime: '11:15',
        casDate: '2026-04-22', casTime: '08:00',
      }),
    });
    setupDbMocks();
    const rows = captureInserts();

    const result = await run(266, BASE_BOT, client);

    expect(rows.some(r => typeof r.error === 'string' && r.error.startsWith('[external_change]'))).toBe(false);
    expect(rows.filter(r => r.success === true)).toHaveLength(0);
    expect(result.success).toBe(false);
  });
});

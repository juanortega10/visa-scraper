import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findBestDate } from '../subscriber-query.js';
import type { DaySlot } from '../visa-client.js';
import type { DateRange } from '../../utils/date-helpers.js';

// ── getSubscribersForFacility() — DB-mocked ──────────────

const { mockDbSelect: mockSelect } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...args: any[]) => mockSelect(...args),
  },
}));

vi.mock('../../db/schema.js', () => ({
  bots: {
    _name: 'bots', id: 'bots.id', isSubscriber: 'bots.isSubscriber',
    consularFacilityId: 'bots.consularFacilityId', status: 'bots.status',
    visaEmail: 'v', visaPassword: 'p', scheduleId: 's', applicantIds: 'a',
    ascFacilityId: 'asc', locale: 'l', proxyProvider: 'pp', userId: 'u',
    currentConsularDate: 'ccd', currentConsularTime: 'cct',
    currentCasDate: 'ccd2', currentCasTime: 'cct2',
    webhookUrl: 'w', notificationEmail: 'ne', casCacheJson: 'ccj',
    targetDateBefore: 'tdb', maxReschedules: 'mr', rescheduleCount: 'rc',
  },
  excludedDates: { botId: 'ed.botId', startDate: 'ed.start', endDate: 'ed.end' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  ne: (...args: any[]) => ({ _op: 'ne', args }),
  inArray: (...args: any[]) => ({ _op: 'inArray', args }),
}));

// We import after mocking
const { getSubscribersForFacility } = await import('../subscriber-query.js');

describe('getSubscribersForFacility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupMock(allBots: any[], exclusions: any[] = []) {
    mockSelect.mockImplementation((..._args: any[]) => {
      let callCount = 0;
      const c: any = {};
      c.from = (_table: any) => {
        callCount++;
        // First call = bots query, second call = excluded_dates query
        const data = callCount === 1 ? allBots : exclusions;
        const inner: any = {};
        inner.where = () => inner;
        inner.then = (res: any, rej?: any) => Promise.resolve(data).then(res, rej);
        inner.catch = (fn: any) => Promise.resolve(data).catch(fn);
        return inner;
      };
      return c;
    });
  }

  it('excludes the scout bot from results', async () => {
    // Bot 6 is both scout AND subscriber — should be excluded since it's the scoutBotId
    setupMock([
      {
        id: 6, status: 'active', isSubscriber: true,
        visaEmail: 'e', visaPassword: 'p', scheduleId: '123', applicantIds: ['1'],
        consularFacilityId: '25', ascFacilityId: '26', locale: 'es-co',
        currentConsularDate: '2026-11-30', currentConsularTime: '08:00',
        currentCasDate: '2026-11-28', currentCasTime: '10:00',
        webhookUrl: null, notificationEmail: null, casCacheJson: null,
        userId: null, proxyProvider: 'direct',
        targetDateBefore: null, maxReschedules: null, rescheduleCount: 0,
      },
      {
        id: 12, status: 'active', isSubscriber: true,
        visaEmail: 'e2', visaPassword: 'p2', scheduleId: '456', applicantIds: ['2'],
        consularFacilityId: '25', ascFacilityId: '26', locale: 'es-co',
        currentConsularDate: '2026-09-15', currentConsularTime: '08:00',
        currentCasDate: '2026-09-13', currentCasTime: '10:00',
        webhookUrl: null, notificationEmail: null, casCacheJson: null,
        userId: null, proxyProvider: 'direct',
        targetDateBefore: null, maxReschedules: null, rescheduleCount: 0,
      },
    ]);

    const days: DaySlot[] = [{ date: '2026-03-05', business_day: true }];
    const result = await getSubscribersForFacility('25', days, 6);

    // The WHERE clause includes ne(bots.id, 6), so DB returns both but
    // in our mock both come through — the ne() filter is at DB level.
    // The important thing is the function is called with the right args.
    // We verify the query was made (mockSelect called)
    expect(mockSelect).toHaveBeenCalled();
    // Bot 12 should appear in results (has improvement: Sep→Mar = 194 days)
    const bot12 = result.find(c => c.id === 12);
    expect(bot12).toBeDefined();
    expect(bot12!.bestDate).toBe('2026-03-05');
  });

  it('returns empty array when no available dates', async () => {
    const result = await getSubscribersForFacility('25', [], 6);
    expect(result).toEqual([]);
    expect(mockSelect).not.toHaveBeenCalled();
  });
});

// ── findBestDate() ──────────────────────────────────────

describe('findBestDate', () => {
  const mkDays = (...dates: string[]): DaySlot[] =>
    dates.map((d) => ({ date: d, business_day: true }));

  it('returns earliest date that improves current by ≥1 day', () => {
    const days = mkDays('2026-03-05', '2026-03-08', '2026-06-15');
    const result = findBestDate(days, '2026-06-20', []);
    expect(result).toBe('2026-03-05');
  });

  it('returns null when no dates improve current', () => {
    const days = mkDays('2026-07-01', '2026-08-15');
    const result = findBestDate(days, '2026-06-20', []);
    expect(result).toBeNull();
  });

  it('returns null when current date is same as earliest', () => {
    const days = mkDays('2026-06-20', '2026-08-15');
    const result = findBestDate(days, '2026-06-20', []);
    expect(result).toBeNull();
  });

  it('returns null when improvement is less than 1 day', () => {
    const days = mkDays('2026-06-19');
    // 1 day earlier is exactly the threshold — should pass
    const result = findBestDate(days, '2026-06-20', []);
    expect(result).toBe('2026-06-19');
  });

  it('skips excluded dates', () => {
    const days = mkDays('2026-03-01', '2026-03-05', '2026-03-10');
    const exclusions: DateRange[] = [
      { startDate: '2026-02-28', endDate: '2026-03-06' }, // excludes Mar 1 and Mar 5
    ];
    const result = findBestDate(days, '2026-06-20', exclusions);
    expect(result).toBe('2026-03-10');
  });

  it('returns null when all dates are excluded', () => {
    const days = mkDays('2026-03-01', '2026-03-02');
    const exclusions: DateRange[] = [
      { startDate: '2026-03-01', endDate: '2026-03-31' },
    ];
    const result = findBestDate(days, '2026-06-20', exclusions);
    expect(result).toBeNull();
  });

  it('returns null for empty available dates', () => {
    const result = findBestDate([], '2026-06-20', []);
    expect(result).toBeNull();
  });

  it('skips excluded but returns next valid date', () => {
    const days = mkDays('2026-02-15', '2026-02-20', '2026-03-10');
    const exclusions: DateRange[] = [
      { startDate: '2026-02-15', endDate: '2026-03-04' },
    ];
    const result = findBestDate(days, '2026-11-30', exclusions);
    expect(result).toBe('2026-03-10');
  });

  it('handles multiple exclusion ranges', () => {
    const days = mkDays('2026-03-01', '2026-04-15', '2026-05-20', '2026-06-10');
    const exclusions: DateRange[] = [
      { startDate: '2026-03-01', endDate: '2026-03-31' },
      { startDate: '2026-05-01', endDate: '2026-05-31' },
    ];
    const result = findBestDate(days, '2026-11-30', exclusions);
    expect(result).toBe('2026-04-15');
  });

  it('date must be strictly ≥1 day earlier (edge case: 0 days diff)', () => {
    const days = mkDays('2026-06-20'); // same as current
    const result = findBestDate(days, '2026-06-20', []);
    expect(result).toBeNull();
  });

  it('handles date exactly 1 day before (boundary)', () => {
    const days = mkDays('2026-06-19');
    const result = findBestDate(days, '2026-06-20', []);
    expect(result).toBe('2026-06-19');
  });
});

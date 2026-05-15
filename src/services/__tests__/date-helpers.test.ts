import { describe, it, expect } from 'vitest';
import {
  isDateExcluded,
  isTimeExcluded,
  filterDates,
  filterTimes,
  isEarlierDate,
  isAtLeastNDaysEarlier,
  addDays,
} from '../../utils/date-helpers.js';

describe('isDateExcluded', () => {
  const exclusions = [
    { startDate: '2026-02-15', endDate: '2026-03-04' },
    { startDate: '2026-06-01', endDate: '2026-06-10' },
  ];

  it('returns true for date within exclusion range', () => {
    expect(isDateExcluded('2026-02-20', exclusions)).toBe(true);
    expect(isDateExcluded('2026-06-05', exclusions)).toBe(true);
  });

  it('returns true for start/end boundaries (inclusive)', () => {
    expect(isDateExcluded('2026-02-15', exclusions)).toBe(true);
    expect(isDateExcluded('2026-03-04', exclusions)).toBe(true);
  });

  it('returns false for date outside exclusion', () => {
    expect(isDateExcluded('2026-03-05', exclusions)).toBe(false);
    expect(isDateExcluded('2026-01-01', exclusions)).toBe(false);
  });

  it('returns false for empty exclusions', () => {
    expect(isDateExcluded('2026-03-01', [])).toBe(false);
  });
});

describe('isTimeExcluded', () => {
  const exclusions = [
    { date: '2026-03-05', timeStart: '07:00', timeEnd: '08:30' },
    { date: null, timeStart: '12:00', timeEnd: '13:00' }, // all dates
  ];

  it('returns true for time within date-specific exclusion', () => {
    expect(isTimeExcluded('2026-03-05', '07:15', exclusions)).toBe(true);
    expect(isTimeExcluded('2026-03-05', '08:00', exclusions)).toBe(true);
  });

  it('returns false for same time on different date', () => {
    expect(isTimeExcluded('2026-03-06', '07:15', exclusions)).toBe(false);
  });

  it('returns true for wildcard (date=null) exclusion on any date', () => {
    expect(isTimeExcluded('2026-03-05', '12:30', exclusions)).toBe(true);
    expect(isTimeExcluded('2026-07-20', '12:30', exclusions)).toBe(true);
  });

  it('returns false for time outside all exclusions', () => {
    expect(isTimeExcluded('2026-03-05', '09:00', exclusions)).toBe(false);
  });
});

describe('filterDates', () => {
  it('removes excluded dates from list', () => {
    const dates = [
      { date: '2026-02-20' },
      { date: '2026-03-05' },
      { date: '2026-03-10' },
    ];
    const exclusions = [{ startDate: '2026-02-15', endDate: '2026-03-04' }];
    const result = filterDates(dates, exclusions);
    expect(result).toEqual([{ date: '2026-03-05' }, { date: '2026-03-10' }]);
  });

  it('returns all dates when no exclusions', () => {
    const dates = [{ date: '2026-03-01' }, { date: '2026-04-01' }];
    expect(filterDates(dates, [])).toEqual(dates);
  });

  it('returns empty when all excluded', () => {
    const dates = [{ date: '2026-03-01' }];
    const exclusions = [{ startDate: '2026-01-01', endDate: '2026-12-31' }];
    expect(filterDates(dates, exclusions)).toEqual([]);
  });

  it('filters dates before minDate', () => {
    const dates = [
      { date: '2026-04-16' },
      { date: '2026-04-18' },
      { date: '2026-04-20' },
    ];
    expect(filterDates(dates, [], undefined, '2026-04-18')).toEqual([
      { date: '2026-04-18' },
      { date: '2026-04-20' },
    ]);
  });

  it('keeps all dates when minDate is undefined', () => {
    const dates = [{ date: '2026-04-16' }, { date: '2026-04-18' }];
    expect(filterDates(dates, [])).toEqual(dates);
  });

  it('filters all dates when all are before minDate', () => {
    const dates = [{ date: '2026-04-15' }, { date: '2026-04-17' }];
    expect(filterDates(dates, [], undefined, '2026-04-18')).toEqual([]);
  });
});

describe('addDays', () => {
  it('adds days within a month', () => {
    expect(addDays('2026-04-15', 3)).toBe('2026-04-18');
  });

  it('crosses month boundary', () => {
    expect(addDays('2026-04-29', 3)).toBe('2026-05-02');
  });

  it('crosses year boundary', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });

  it('adds 0 days returns same date', () => {
    expect(addDays('2026-04-15', 0)).toBe('2026-04-15');
  });

  it('handles leap year February', () => {
    expect(addDays('2028-02-27', 3)).toBe('2028-03-01');
  });
});

describe('filterTimes', () => {
  it('removes excluded times', () => {
    const times = ['07:00', '07:15', '08:00', '09:00'];
    const exclusions = [{ date: '2026-03-05', timeStart: '07:00', timeEnd: '07:30' }];
    const result = filterTimes('2026-03-05', times, exclusions);
    expect(result).toEqual(['08:00', '09:00']);
  });

  it('does not filter times for different date', () => {
    const times = ['07:00', '07:15'];
    const exclusions = [{ date: '2026-03-06', timeStart: '07:00', timeEnd: '07:30' }];
    const result = filterTimes('2026-03-05', times, exclusions);
    expect(result).toEqual(['07:00', '07:15']);
  });
});

describe('isEarlierDate', () => {
  it('returns true when candidate is earlier', () => {
    expect(isEarlierDate('2026-03-05', '2026-06-20')).toBe(true);
  });

  it('returns false when candidate is later', () => {
    expect(isEarlierDate('2026-08-01', '2026-06-20')).toBe(false);
  });

  it('returns false when same date', () => {
    expect(isEarlierDate('2026-06-20', '2026-06-20')).toBe(false);
  });
});

describe('isAtLeastNDaysEarlier', () => {
  it('returns true when candidate is exactly N days earlier', () => {
    expect(isAtLeastNDaysEarlier('2026-06-15', '2026-06-20', 5)).toBe(true);
  });

  it('returns true when candidate is more than N days earlier', () => {
    expect(isAtLeastNDaysEarlier('2026-03-01', '2026-06-20', 1)).toBe(true);
  });

  it('returns false when candidate is less than N days earlier', () => {
    expect(isAtLeastNDaysEarlier('2026-06-19', '2026-06-20', 2)).toBe(false);
  });

  it('returns false when candidate is same day', () => {
    expect(isAtLeastNDaysEarlier('2026-06-20', '2026-06-20', 1)).toBe(false);
  });

  it('returns false when candidate is later', () => {
    expect(isAtLeastNDaysEarlier('2026-07-01', '2026-06-20', 1)).toBe(false);
  });

  it('handles minDays=0', () => {
    expect(isAtLeastNDaysEarlier('2026-06-20', '2026-06-20', 0)).toBe(true);
  });
});

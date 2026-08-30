import { describe, it, expect } from 'vitest';
import {
  isDateExcluded,
  isTimeExcluded,
  filterDates,
  filterTimes,
  isEarlierDate,
  isAtLeastNDaysEarlier,
  isActionableDate,
  addDays,
  isSniperActive,
  isWithinWindow,
  weekdayOf,
  isWeekdayExcluded,
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

  it('filters dates before targetDateAfter (sniper window lower bound, inclusive)', () => {
    const dates = [
      { date: '2026-05-31' },
      { date: '2026-06-01' },
      { date: '2026-07-20' },
      { date: '2026-07-21' },
    ];
    // window [2026-06-01, 2026-07-21): includes 06-01 and 07-20, excludes 05-31 and 07-21
    expect(filterDates(dates, [], '2026-07-21', undefined, '2026-06-01')).toEqual([
      { date: '2026-06-01' },
      { date: '2026-07-20' },
    ]);
  });

  it('keeps all dates when targetDateAfter is undefined', () => {
    const dates = [{ date: '2026-05-01' }, { date: '2026-08-01' }];
    expect(filterDates(dates, [], undefined, undefined, undefined)).toEqual(dates);
  });

  it('drops Saturdays when excludedWeekdays = [6]', () => {
    // 2026-08-22 y 2026-08-29 son sabados; 2026-08-24 es lunes.
    const dates = [{ date: '2026-08-22' }, { date: '2026-08-24' }, { date: '2026-08-29' }];
    expect(filterDates(dates, [], undefined, undefined, undefined, [6])).toEqual([{ date: '2026-08-24' }]);
  });

  it('keeps every date when excludedWeekdays is null or empty', () => {
    const dates = [{ date: '2026-08-22' }, { date: '2026-08-24' }];
    expect(filterDates(dates, [], undefined, undefined, undefined, null)).toEqual(dates);
    expect(filterDates(dates, [], undefined, undefined, undefined, [])).toEqual(dates);
  });
});

describe('weekdayOf / isWeekdayExcluded', () => {
  it('reads the weekday in UTC, without timezone shift', () => {
    expect(weekdayOf('2026-08-22')).toBe(6); // sabado
    expect(weekdayOf('2026-08-23')).toBe(0); // domingo
    expect(weekdayOf('2026-08-24')).toBe(1); // lunes
  });

  it('returns false with no list', () => {
    expect(isWeekdayExcluded('2026-08-22', null)).toBe(false);
    expect(isWeekdayExcluded('2026-08-22', undefined)).toBe(false);
    expect(isWeekdayExcluded('2026-08-22', [])).toBe(false);
  });

  it('returns true only for the listed weekdays', () => {
    expect(isWeekdayExcluded('2026-08-22', [6])).toBe(true);
    expect(isWeekdayExcluded('2026-08-24', [6])).toBe(false);
    expect(isWeekdayExcluded('2026-08-23', [0, 6])).toBe(true);
  });
});

describe('isSniperActive', () => {
  it('is true only when enabled AND both bounds set', () => {
    expect(isSniperActive(true, '2026-06-01', '2026-07-21')).toBe(true);
  });
  it('is false when disabled', () => {
    expect(isSniperActive(false, '2026-06-01', '2026-07-21')).toBe(false);
  });
  it('is false when a bound is missing', () => {
    expect(isSniperActive(true, '2026-06-01', null)).toBe(false);
    expect(isSniperActive(true, null, '2026-07-21')).toBe(false);
    expect(isSniperActive(true, undefined, undefined)).toBe(false);
  });
});

describe('isWithinWindow', () => {
  it('lower bound inclusive, upper bound exclusive', () => {
    expect(isWithinWindow('2026-06-01', '2026-06-01', '2026-07-21')).toBe(true);  // lower inclusive
    expect(isWithinWindow('2026-07-20', '2026-06-01', '2026-07-21')).toBe(true);
    expect(isWithinWindow('2026-07-21', '2026-06-01', '2026-07-21')).toBe(false); // upper exclusive
    expect(isWithinWindow('2026-05-31', '2026-06-01', '2026-07-21')).toBe(false);
  });
  it('open bounds when a side is null/undefined', () => {
    expect(isWithinWindow('2099-01-01', '2026-06-01', null)).toBe(true);   // no upper
    expect(isWithinWindow('1999-01-01', null, '2026-07-21')).toBe(true);   // no lower
  });
  it('false for empty date', () => {
    expect(isWithinWindow(null, '2026-06-01', '2026-07-21')).toBe(false);
    expect(isWithinWindow(undefined, '2026-06-01', '2026-07-21')).toBe(false);
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

describe('isActionableDate', () => {
  it('returns false for null candidate', () => {
    expect(isActionableDate(null, '2026-06-20', false)).toBe(false);
  });

  it('returns true in sniper mode (window check is applied separately by caller)', () => {
    expect(isActionableDate('2026-07-01', '2026-06-20', true)).toBe(true);
  });

  it('non-sniper: returns true for initial booking (current null)', () => {
    expect(isActionableDate('2026-07-01', null, false)).toBe(true);
  });

  it('non-sniper: returns true when candidate is strictly earlier', () => {
    expect(isActionableDate('2026-03-01', '2026-06-20', false)).toBe(true);
  });

  it('non-sniper: returns false when candidate is the same day', () => {
    expect(isActionableDate('2026-06-20', '2026-06-20', false)).toBe(false);
  });

  it('non-sniper: returns false when candidate is later', () => {
    expect(isActionableDate('2026-07-01', '2026-06-20', false)).toBe(false);
  });
});

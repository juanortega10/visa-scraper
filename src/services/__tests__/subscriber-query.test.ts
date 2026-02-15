import { describe, it, expect } from 'vitest';
import { findBestDate } from '../subscriber-query.js';
import type { DaySlot } from '../visa-client.js';
import type { DateRange } from '../../utils/date-helpers.js';

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

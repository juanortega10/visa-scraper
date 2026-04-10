import { describe, it, expect, beforeAll } from 'vitest';
import {
  recordFailure,
  isBlocked,
  pruneDisappeared,
  clearOnSuccess,
  clearOnCasAvailable,
  CROSS_POLL_THRESHOLD,
  CROSS_POLL_BLOCK_MS,
  CROSS_POLL_WINDOW_MS,
} from '../date-failure-tracker.js';
import type { DateFailureEntry } from '../../db/schema.js';

beforeAll(() => {
  process.env.TZ = 'America/Bogota';
});

// Fixed reference time — never use Date.now() in this file.
const T0 = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15T12:00:00Z

describe('recordFailure', () => {
  it('1. first failure on undefined entry initializes window with totalCount=1', () => {
    const e = recordFailure(undefined, 'consularNoTimes', T0);
    expect(e.totalCount).toBe(1);
    expect(e.byDimension.consularNoTimes).toBe(1);
    expect(e.windowStartedAt).toBe(new Date(T0).toISOString());
    expect(e.lastFailureAt).toBe(e.windowStartedAt);
    expect(e.blockedUntil).toBeUndefined();
  });

  it('2. accumulates within window across 4 sequential calls without blocking', () => {
    let e: DateFailureEntry | undefined;
    for (let i = 0; i < 4; i++) {
      e = recordFailure(e, 'consularNoTimes', T0 + i * 60_000);
    }
    expect(e!.totalCount).toBe(4);
    expect(e!.windowStartedAt).toBe(new Date(T0).toISOString());
    expect(e!.lastFailureAt).toBe(new Date(T0 + 3 * 60_000).toISOString());
    expect(e!.blockedUntil).toBeUndefined();
  });

  it('3. threshold crossing on 5th call sets blockedUntil = now + 2h', () => {
    let e: DateFailureEntry | undefined;
    for (let i = 0; i < 5; i++) {
      e = recordFailure(e, 'consularNoTimes', T0 + i * 60_000);
    }
    expect(e!.totalCount).toBe(5);
    const expectedBlockedUntil = new Date(T0 + 4 * 60_000 + CROSS_POLL_BLOCK_MS).toISOString();
    expect(e!.blockedUntil).toBe(expectedBlockedUntil);
  });

  it('4. preserves blockedUntil on 6th call (does not extend)', () => {
    let e: DateFailureEntry | undefined;
    for (let i = 0; i < 5; i++) {
      e = recordFailure(e, 'consularNoTimes', T0 + i * 60_000);
    }
    const blockedAfter5 = e!.blockedUntil;
    e = recordFailure(e, 'consularNoTimes', T0 + 5 * 60_000);
    expect(e.totalCount).toBe(6);
    expect(e.blockedUntil).toBe(blockedAfter5);
  });

  it('5. window expiry (>1h) produces fresh entry with totalCount=1, no blockedUntil', () => {
    const seed: DateFailureEntry = {
      windowStartedAt: new Date(T0).toISOString(),
      totalCount: 3,
      byDimension: { consularNoTimes: 3 },
      lastFailureAt: new Date(T0 + 30 * 60_000).toISOString(),
    };
    const fresh = recordFailure(seed, 'casNoTimes', T0 + 61 * 60_000);
    expect(fresh.totalCount).toBe(1);
    expect(fresh.byDimension.casNoTimes).toBe(1);
    expect(fresh.byDimension.consularNoTimes).toBeUndefined();
    expect(fresh.windowStartedAt).toBe(new Date(T0 + 61 * 60_000).toISOString());
    expect(fresh.blockedUntil).toBeUndefined();
  });

  it('6. mixed dimensions accumulate independently and trigger block at threshold', () => {
    let e: DateFailureEntry | undefined;
    const dims = ['consularNoTimes', 'casNoDays', 'consularNoTimes', 'casNoDays', 'consularNoTimes', 'casNoDays'] as const;
    dims.forEach((d, i) => {
      e = recordFailure(e, d, T0 + i * 60_000);
    });
    expect(e!.totalCount).toBe(6);
    expect(e!.byDimension.consularNoTimes).toBe(3);
    expect(e!.byDimension.casNoDays).toBe(3);
    expect(e!.blockedUntil).toBeDefined();
  });
});

describe('isBlocked', () => {
  it('7. returns false for undefined / no-block / past-block; true for future block', () => {
    expect(isBlocked(undefined, T0)).toBe(false);

    const noBlock: DateFailureEntry = {
      windowStartedAt: new Date(T0).toISOString(),
      totalCount: 2,
      byDimension: { consularNoTimes: 2 },
      lastFailureAt: new Date(T0).toISOString(),
    };
    expect(isBlocked(noBlock, T0 + 1000)).toBe(false);

    const pastBlock: DateFailureEntry = {
      ...noBlock,
      blockedUntil: new Date(T0 - 1000).toISOString(),
    };
    expect(isBlocked(pastBlock, T0)).toBe(false);

    const futureBlock: DateFailureEntry = {
      ...noBlock,
      blockedUntil: new Date(T0 + CROSS_POLL_BLOCK_MS).toISOString(),
    };
    expect(isBlocked(futureBlock, T0 + 1000)).toBe(true);
  });
});

describe('pruneDisappeared', () => {
  it('8. retains only entries whose date is in currentDates', () => {
    const stub = (): DateFailureEntry => ({
      windowStartedAt: new Date(T0).toISOString(),
      totalCount: 1,
      byDimension: { consularNoTimes: 1 },
      lastFailureAt: new Date(T0).toISOString(),
    });
    const tracking = {
      '2026-06-01': stub(),
      '2026-06-02': stub(),
      '2026-06-03': stub(),
    };
    const out = pruneDisappeared(tracking, new Set(['2026-06-01', '2026-06-03']));
    expect(Object.keys(out).sort()).toEqual(['2026-06-01', '2026-06-03']);
  });
});

describe('clearOnSuccess', () => {
  it('9. removes the booked-date entry; missing key is a no-op (content unchanged)', () => {
    const stub = (): DateFailureEntry => ({
      windowStartedAt: new Date(T0).toISOString(),
      totalCount: 1,
      byDimension: { consularNoTimes: 1 },
      lastFailureAt: new Date(T0).toISOString(),
    });
    const tracking = { '2026-06-01': stub(), '2026-06-02': stub() };
    const out = clearOnSuccess(tracking, '2026-06-01');
    expect(Object.keys(out)).toEqual(['2026-06-02']);

    const noop = clearOnSuccess(tracking, '2099-01-01');
    expect(Object.keys(noop).sort()).toEqual(['2026-06-01', '2026-06-02']);
  });
});

describe('clearOnCasAvailable', () => {
  it('10. removes the dateWithCas entry', () => {
    const stub = (): DateFailureEntry => ({
      windowStartedAt: new Date(T0).toISOString(),
      totalCount: 5,
      byDimension: { casNoTimes: 5 },
      lastFailureAt: new Date(T0).toISOString(),
      blockedUntil: new Date(T0 + CROSS_POLL_BLOCK_MS).toISOString(),
    });
    const tracking = { '2026-06-01': stub(), '2026-06-02': stub() };
    const out = clearOnCasAvailable(tracking, '2026-06-01');
    expect(Object.keys(out)).toEqual(['2026-06-02']);
  });
});

describe('Bogota TZ window arithmetic (Pitfall 6)', () => {
  it('11. window math is timezone-independent; in-window at +59min, expires at +61min', () => {
    expect(process.env.TZ).toBe('America/Bogota');
    const e1 = recordFailure(undefined, 'consularNoTimes', T0);
    const e2 = recordFailure(e1, 'consularNoTimes', T0 + 59 * 60 * 1000);
    expect(e2.totalCount).toBe(2);
    expect(e2.windowStartedAt).toBe(new Date(T0).toISOString());

    const e3 = recordFailure(e2, 'consularNoTimes', T0 + 61 * 60 * 1000);
    expect(e3.totalCount).toBe(1);
    expect(e3.windowStartedAt).toBe(new Date(T0 + 61 * 60 * 1000).toISOString());

    // Sanity: also assert the constants used
    expect(CROSS_POLL_WINDOW_MS).toBe(60 * 60 * 1000);
    expect(CROSS_POLL_THRESHOLD).toBe(5);
    expect(CROSS_POLL_BLOCK_MS).toBe(2 * 60 * 60 * 1000);
  });
});

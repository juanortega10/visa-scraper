# STACK — Cross-Poll Failure Tracking

**Confidence:** HIGH. Dependency-light brownfield integration.

## Verdict

**Zero new dependencies.** The entire feature is ~30 lines in a new pure module `src/services/date-failure-tracker.ts` plus small touches in `reschedule-logic.ts`, `poll-visa.ts`, and `schema.ts`. A library would be a regression in consistency with the existing `blockedConsularDates` pattern.

## Why no library

| Candidate | Why rejected |
|---|---|
| `rate-limiter-flexible` | In-process admission control, not jsonb persistence. ~50KB. Redis-shaped API. |
| `@isaacs/ttlcache` / `lru-cache` w/ TTL | In-memory only. Lost on Trigger.dev cold starts. Defeats cross-poll purpose. |
| `limiter` (token bucket) | Measures rate, not "N fails total in any 1h window". Wrong shape. |
| `date-fns` for window math | 200KB dep for 2 subtractions and an add. |
| New `date_failures` table | PROJECT.md Out of Scope. Low write rate; jsonb is correct home. |
| `pg_advisory_lock` | `activeRunId` + `cancelPreviousRun` already enforce single writer per bot. |

## Algorithm: Fixed Window (not sliding)

| Option | Pros | Cons |
|---|---|---|
| **Fixed window** ✓ | ~80 bytes/date, trivial reset, under-blocking bias (safe direction for the "never lose a better date" invariant), easy `delete` for TRACK-04 reset | Boundary effect at window edge |
| Sliding log | Exact 1h window, breakdown free | Unbounded growth, larger jsonb, more code |
| Sliding counter (Cloudflare-style) | Approximates sliding | Overkill for 5/hr threshold |

**Rationale:** Fixed window's boundary effect biases toward **under-blocking**, matching PROJECT.md's "preferir bloquear de menos a bloquear de más". Real pattern is intra-window bursts (e.g. 4 polls at 16:10–16:20) — fixed window catches those well. TRACK-04 reset is just `delete tracking[date]`.

The shape is forward-compatible: a future milestone can add an `events[]` array for sliding accuracy without breaking existing entries.

## TypeScript Shape

Extend `CasCacheData` in `src/db/schema.ts`:

```typescript
export interface DateFailureBreakdown {
  consularNoTimes: number;
  consularNoDays: number;   // reserved — not currently incremented (days.json failures are structural)
  casNoTimes: number;
  casNoDays: number;
}

export interface DateFailureEntry {
  windowStart: string;      // ISO-8601, when current 1h window opened
  totalCount: number;       // sum across breakdown
  breakdown: DateFailureBreakdown;
  blockedUntil?: string;    // ISO-8601, set when totalCount ≥ threshold
  lastFailAt: string;       // ISO-8601, debug aid
}

export interface CasCacheData {
  // ... existing fields ...
  blockedConsularDates?: Record<string, string>;
  /** Cross-poll failure tracking. date → counter+window. Reset when date disappears from days.json. */
  dateFailureTracking?: Record<string, DateFailureEntry>;
}
```

## Pure Tracker Module

New file: `src/services/date-failure-tracker.ts`. Three pure functions, no I/O, no `Date.now()` inside — caller injects `now` for testability.

```typescript
export const FAILURE_WINDOW_MS = 60 * 60 * 1000;      // 1h
export const FAILURE_BLOCK_MS  = 2 * 60 * 60 * 1000;  // 2h
export const FAILURE_THRESHOLD = 5;

export type FailureDimension =
  | 'consularNoTimes'
  | 'consularNoDays'
  | 'casNoTimes'
  | 'casNoDays';

export function recordFailure(
  entry: DateFailureEntry | undefined,
  dimension: FailureDimension,
  now: number,
): DateFailureEntry {
  const nowIso = new Date(now).toISOString();
  // Roll the window if expired
  if (!entry || (now - new Date(entry.windowStart).getTime()) >= FAILURE_WINDOW_MS) {
    const breakdown: DateFailureBreakdown = {
      consularNoTimes: 0, consularNoDays: 0, casNoTimes: 0, casNoDays: 0,
    };
    breakdown[dimension] = 1;
    return { windowStart: nowIso, totalCount: 1, breakdown, lastFailAt: nowIso };
  }
  const breakdown = { ...entry.breakdown, [dimension]: entry.breakdown[dimension] + 1 };
  const totalCount = entry.totalCount + 1;
  const next: DateFailureEntry = { ...entry, breakdown, totalCount, lastFailAt: nowIso };
  if (totalCount >= FAILURE_THRESHOLD && !next.blockedUntil) {
    next.blockedUntil = new Date(now + FAILURE_BLOCK_MS).toISOString();
  }
  return next;
}

export function isBlocked(entry: DateFailureEntry | undefined, now: number): boolean {
  if (!entry?.blockedUntil) return false;
  return new Date(entry.blockedUntil).getTime() > now;
}

export function pruneDisappeared(
  tracking: Record<string, DateFailureEntry>,
  currentDates: Set<string>,
): Record<string, DateFailureEntry> {
  const out: Record<string, DateFailureEntry> = {};
  for (const [date, entry] of Object.entries(tracking)) {
    if (currentDates.has(date)) out[date] = entry;
  }
  return out;
}
```

## Atomic jsonb Writes — REUSE existing `jsonb_set` pattern

The codebase already does it right at `poll-visa.ts:933`:

```typescript
db.execute(sql`UPDATE bots SET cas_cache_json = jsonb_set(COALESCE(cas_cache_json,'{}'), '{blockedConsularDates}', ${JSON.stringify(updatedBlocked)}::jsonb) WHERE id = ${botId}`)
```

For `dateFailureTracking`, do the **identical** thing with key `'{dateFailureTracking}'`. Why:

- **Lost-update safety:** `prefetch-cas` task writes to other `casCacheJson` keys concurrently. A naive `db.update(bots).set({ casCacheJson: whole })` would clobber. `jsonb_set` patches one top-level key server-side — safe across concurrent writers using different keys.
- `dateFailureTracking` is owned exclusively by `executeReschedule` (via poll-visa); `prefetch-cas` never touches it.
- Postgres `jsonb_set` is atomic at the row level (single statement = single MVCC bump). No advisory locks needed.

**Single-writer invariant:** A bot has one active poll chain (`activeRunId` + `cancelPreviousRun`). Two polls cannot race on the same bot's `dateFailureTracking`. Read→mutate→write is safe.

**Anti-pattern to avoid:** the dashboard and parts of `prefetch-cas.ts` do `db.update(bots).set({ casCacheJson: full })`. DO NOT follow that from `poll-visa.ts` for this feature — stick with `jsonb_set`.

## Clock skew — not an issue

1. Trigger.dev worker clock vs DB clock — both NTP-synced; drift bounded to ms. Threshold is 1h. Irrelevant.
2. RPi vs cloud writing same row — `pollEnvironments` is usually exclusive per bot, and `activeRunId` gate prevents concurrent chains. Ms-level NTP skew doesn't matter at 1h granularity.

**Rule:** all timestamps produced by `Date.now()` on the worker doing the increment, stored as ISO strings, compared via `new Date(...).getTime()` on read. Never mix wall-clock sources for the same entry across writes — single-writer invariant makes this trivially true.

## Testing — inject `now`, avoid fake timers in unit tests

Because tracker functions are pure (`recordFailure(entry, dim, now)`), unit tests pass explicit `now` values. **No `vi.useFakeTimers()` in `date-failure-tracker.test.ts`.**

```typescript
import { describe, it, expect } from 'vitest';
import {
  recordFailure, isBlocked, pruneDisappeared,
  FAILURE_WINDOW_MS, FAILURE_BLOCK_MS,
} from '../date-failure-tracker.js';

const T0 = new Date('2026-04-06T16:00:00Z').getTime();

describe('recordFailure', () => {
  it('initializes a new window on first failure', () => {
    const e = recordFailure(undefined, 'consularNoTimes', T0);
    expect(e.totalCount).toBe(1);
    expect(e.breakdown.consularNoTimes).toBe(1);
    expect(e.windowStart).toBe(new Date(T0).toISOString());
    expect(e.blockedUntil).toBeUndefined();
  });

  it('accumulates within the window across dimensions', () => {
    let e = recordFailure(undefined, 'consularNoTimes', T0);
    e = recordFailure(e, 'consularNoTimes', T0 + 5 * 60_000);
    e = recordFailure(e, 'casNoTimes',     T0 + 10 * 60_000);
    expect(e.totalCount).toBe(3);
    expect(e.breakdown.consularNoTimes).toBe(2);
    expect(e.breakdown.casNoTimes).toBe(1);
    expect(e.blockedUntil).toBeUndefined();
  });

  it('sets blockedUntil at threshold', () => {
    let e: any;
    for (let i = 0; i < 5; i++) e = recordFailure(e, 'consularNoTimes', T0 + i * 60_000);
    expect(e.totalCount).toBe(5);
    expect(e.blockedUntil).toBe(
      new Date(T0 + 4 * 60_000 + FAILURE_BLOCK_MS).toISOString()
    );
  });

  it('rolls the window when 1h expires', () => {
    let e = recordFailure(undefined, 'consularNoTimes', T0);
    e = recordFailure(e, 'consularNoTimes', T0 + FAILURE_WINDOW_MS + 1);
    expect(e.totalCount).toBe(1); // reset
  });

  it('isBlocked respects expiry', () => {
    let e: any;
    for (let i = 0; i < 5; i++) e = recordFailure(e, 'consularNoTimes', T0 + i);
    expect(isBlocked(e, T0 + 1000)).toBe(true);
    expect(isBlocked(e, T0 + FAILURE_BLOCK_MS + 10)).toBe(false);
  });

  it('pruneDisappeared drops dates not in current set', () => {
    const tracking = { '2026-06-01': {} as any, '2026-06-02': {} as any };
    const out = pruneDisappeared(tracking, new Set(['2026-06-01']));
    expect(Object.keys(out)).toEqual(['2026-06-01']);
  });
});
```

Integration tests in `reschedule-cas-cache.test.ts` style can use fake timers if needed, but prefer adding an optional `nowMs` param to `executeReschedule` (default `Date.now()`) so integration tests stay timer-free. Fake timers in vitest 4 interact poorly with `await` chains and Trigger.dev's `logger`.

## Version notes

- **drizzle-orm 0.38.0** — `db.execute(sql\`...\`)` is the documented escape hatch and is already used at `poll-visa.ts:933`. No gotchas.
- **vitest 4.0.18** — `vi.useFakeTimers({ now })` stable since v3. Pure-function approach sidesteps the v4 ESM quirk where `setTimeout` polyfills can leak between tests.
- **Postgres jsonb_set** — stable since PG 9.5. Neon supports natively.

## Relevant files

- Read/modify: `src/db/schema.ts` (extend `CasCacheData`)
- Read/modify: `src/trigger/poll-visa.ts:864-937` (read/filter/write site)
- Read/modify: `src/services/reschedule-logic.ts:217-221` (parallel counter, via return delta)
- Read/mirror: `src/services/__tests__/reschedule-cas-cache.test.ts` (existing test patterns)
- Create: `src/services/date-failure-tracker.ts`
- Create: `src/services/__tests__/date-failure-tracker.test.ts`

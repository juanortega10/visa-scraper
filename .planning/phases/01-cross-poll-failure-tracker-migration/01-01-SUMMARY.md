---
plan: 01-01
status: completed
completed_at: 2026-04-07
one_liner: Built pure DateFailureEntry/date-failure-tracker.ts foundation with 11 exhaustive unit tests
---

# Summary: Plan 01-01 — Pure Layer

## What was built

**src/db/schema.ts**
- Added `FailureDimension` union type (`'consular_no_times' | 'cas_no_days' | 'cas_no_times'`)
- Added `DateFailureEntry` interface with `windowStart`, `totalCount`, `blockedUntil?`, `lastFailureAt`, `dimension`
- Added `dateFailureTracking?: Record<string, DateFailureEntry>` to `CasCacheData`

**src/services/date-failure-tracker.ts** (127 lines)
- `CROSS_POLL_THRESHOLD = 5`, `CROSS_POLL_BLOCK_MS = 2h`, `CROSS_POLL_WINDOW_MS = 1h`
- `recordFailure(entry, dimension, now)` — pure, returns new entry; window expiry resets; threshold sets blockedUntil once, never extends
- `isBlocked(entry, now)` — returns true iff `blockedUntil > now`
- `pruneDisappeared(tracker, currentDates)` — removes entries for dates no longer in portal
- `clearOnSuccess(tracker, date)` — removes booked-date entry
- `clearOnCasAvailable(tracker, date)` — removes entry when fresh CAS unblocks it

**src/services/__tests__/date-failure-tracker.test.ts**
- 11 tests, injected `now` (no fake timers)
- Covers: first failure, accumulation, threshold crossing, blockedUntil preservation, window expiry, mixed dimensions, isBlocked edge cases, pruneDisappeared, clearOnSuccess, clearOnCasAvailable, TZ-independent window math

## Verification
- 11/11 tests pass, 186/186 total suite passes

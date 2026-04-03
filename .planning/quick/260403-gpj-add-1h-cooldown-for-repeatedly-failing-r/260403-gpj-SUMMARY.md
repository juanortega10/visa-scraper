---
phase: quick
plan: 260403-gpj
subsystem: reschedule
tags: [reschedule, blocking, cooldown, poll-visa]
tech-stack:
  added: []
  patterns: [per-date failure counter, TTL-based blocking]
key-files:
  created: []
  modified:
    - src/services/reschedule-logic.ts
    - src/trigger/poll-visa.ts
    - src/services/__tests__/reschedule-cas-cache.test.ts
decisions:
  - "Threshold of 3 chosen to match plan spec; balances sensitivity vs false-positive risk"
  - "Dates in falsePositiveDates excluded from repeatedlyFailingDates to avoid duplication"
  - "1h TTL chosen: longer than 30m no_cas_days but shorter than 2h false-positive blocks"
  - "Longer existing blocks are preserved (fp 2h wins over rf 1h) to not downgrade protections"
  - "no_cas_times_cached NOT counted (transientFailCount handles cache misses separately)"
metrics:
  duration: ~15min
  completed: 2026-04-03T17:10:00Z
  tasks_completed: 2
  files_modified: 3
---

# Quick Task 260403-gpj: Add 1h Cooldown for Repeatedly Failing Reschedule Dates

**One-liner:** Per-date failure counter in executeReschedule returns `repeatedlyFailingDates` (3+ failures of any type); poll-visa.ts blocks those dates in `blockedConsularDates` for 1h TTL.

## What Was Done

Added a complementary blocking mechanism to prevent aggressive retry loops on dates that are consistently failing within a single `executeReschedule` call. This works alongside the existing `exhaustedDates` mechanism (which requires ALL time slots to fail) by providing earlier blocking when 3+ failures of any type accumulate for a single date.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Per-date failure counter + repeatedlyFailingDates | 7cb3f4b | reschedule-logic.ts, reschedule-cas-cache.test.ts |
| 2 | 1h TTL blocking in poll-visa.ts | c385575 | poll-visa.ts |

## Changes

### src/services/reschedule-logic.ts

- Added `repeatedlyFailingDates?: string[]` to `RescheduleResult` interface
- Added `dateFailureCount = new Map<string, number>()` and `REPEATEDLY_FAILING_THRESHOLD = 3` after existing `transientFailCount`
- Incremented `dateFailureCount` at every `failedAttempts.push()` site for: `no_times`, `verification_failed` (no-CAS path), `no_cas_days`, `no_cas_times`, `verification_failed` (CAS path), `session_expired`, `post_error`/`fetch_error`
- `no_cas_times_cached` intentionally NOT counted (transient cache miss handled by transientFailCount)
- Computes `repeatedlyFailingDates` set before final return, excluding dates already in `falsePositiveDates`
- Propagated to all 6 return sites (early in-loop returns compute inline via `rfDatesEarly`)

### src/trigger/poll-visa.ts

- Added `rfDates = result.repeatedlyFailingDates ?? []` alongside existing `noCasDates` and `fpDates`
- Updated guard condition to `if (noCasDates.length > 0 || fpDates.length > 0 || rfDates.length > 0)`
- Blocks rf dates for 1h TTL; preserves longer existing blocks (2h fp wins over 1h rf)
- Logs blocked dates with `until` timestamp

### src/services/__tests__/reschedule-cas-cache.test.ts

Added 4 new tests in `describe('executeReschedule — repeatedlyFailingDates')`:
1. 3+ no_cas_days failures → date appears in repeatedlyFailingDates
2. 2 failures → date does NOT appear (below threshold)
3. Date in falsePositiveDates → NOT duplicated in repeatedlyFailingDates
4. 4 failures (mixed) → date appears in repeatedlyFailingDates

## Test Results

167/167 tests passing (8 test files).

## Deploy Result

Deploy to RPi: SUCCESS

```
[4/4] Restarting services...
● visa-api.service   Active: active (running) since Fri 2026-04-03 12:08:43 -05; 4s ago
● visa-trigger.service  Active: active (running) since Fri 2026-04-03 12:08:43 -05; 4s ago
```

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- `src/services/reschedule-logic.ts` — modified with `repeatedlyFailingDates` field and counter
- `src/trigger/poll-visa.ts` — modified with 1h blocking logic
- `src/services/__tests__/reschedule-cas-cache.test.ts` — 4 new tests added
- Commit 7cb3f4b exists
- Commit c385575 exists

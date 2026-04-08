---
status: completed
completed_at: 2026-04-07
---

# Summary: Add 1h Cooldown for Repeatedly Failing Reschedule Dates

## What was done

**Task 1 — reschedule-logic.ts**
- Added `dateFailureCount: Map<string, number>` to track total failures per date (any reason)
- Added `REPEATEDLY_FAILING_THRESHOLD = 3`
- Incremented counter at every `failedAttempts.push(...)` site
- Computed `repeatedlyFailingDates` set after main loop (excludes falsePositiveDates)
- Added `repeatedlyFailingDates` to all return statements

**Task 2 — poll-visa.ts**
- Extended blocking logic for `rfDates = result.repeatedlyFailingDates ?? []`
- 1h TTL block; does NOT overwrite longer existing blocks (fp 2h stays)
- Guard condition extended

## Result
- 186/186 tests pass
- Dates failing 3+ times in a single executeReschedule call blocked 1h in blockedConsularDates

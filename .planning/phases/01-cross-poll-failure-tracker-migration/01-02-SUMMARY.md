---
plan: 01-02
status: completed
completed_at: 2026-04-07
one_liner: Wired cross-poll tracker into reschedule/poll/prefetch; deleted dateCooldowns dead code
---

# Summary: Plan 01-02 — Integration + Cleanup

## Files Modified

**src/services/reschedule-logic.ts**
- Added `dateFailureTrackingDelta`, `newlyBlockedDates` to `RescheduleResult`
- Added `trackerDelta` (seeded from casCacheJson) + `bumpTracker()` helper with currentConsularDate safety
- `bumpTracker` called at exactly 3 sites: no_times (consularNoTimes), no_cas_days (casNoDays), no_cas_times (casNoTimes)
- NOT called at: verification_failed (440/669), session_expired (882), post_error/fetch_error (901)
- `clearOnSuccess` (inline via `trackerDelta.delete`) in both CAS and no-CAS POST-success branches
- `newlyBlockedDates` aggregation after main loop
- 5 terminal returns updated: 2×max_reschedules_reached, portal_reversion, success, all_candidates_failed

**src/trigger/poll-visa.ts**
- Deleted: `DateCooldownEntry` interface, `dateCooldowns` from PollPayload, `updatedCooldowns` var, cooldown skip block, self-trigger `dateCooldowns` field, `DATE_COOLDOWN_*` constants, `updateDateCooldowns()`, `getActiveCooldowns()`
- Added imports: `isBlocked`, `pruneDisappeared`, `CROSS_POLL_WINDOW_MS`, `DateFailureEntry`
- Full tracker lifecycle: prune (flapping-aware) → currentConsularDate safety net → cap at 100 → extend blockedDateSet
- Passes `prunedTracker` as snapshot to executeReschedule
- Merges `newlyBlockedDates` (2h TTL) OUTSIDE `!result.success` guard
- Single nested jsonb_set persisting both `blockedConsularDates` AND `dateFailureTracking`
- Added `trackerSize` to LogPollExtra interface + extra object

**src/trigger/prefetch-cas.ts**
- Added imports: `clearOnCasAvailable`, `isBlocked`, `DateFailureEntry`, `sql`
- CAS escape hatch: after Phase 4, checks entries with `slots > 0` against tracker blocked entries; clears via `clearOnCasAvailable` + jsonb_set; logs `tracker.cleared` with `reason: 'cas_available'`
- `dateFailureTracking` preserved in `cacheData` write

## Dead Code Removed
- `DateCooldownEntry`, `dateCooldowns` payload field, `updatedCooldowns`, `DATE_COOLDOWN_THRESHOLD`, `DATE_COOLDOWN_MINUTES`, `updateDateCooldowns()`, `getActiveCooldowns()` — all gone

## jsonb_set Strategy
Nested form (preferred): `jsonb_set(jsonb_set(..., blockedConsularDates), dateFailureTracking)` — single DB write.

## Verification
- 186/186 tests pass
- Zero `dateCooldowns` references in src/ (excluding comment in date-failure-tracker.ts)
- All acceptance criteria met

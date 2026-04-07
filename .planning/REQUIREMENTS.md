# Requirements: visa-scraper — Cross-Poll Failure Tracker Migration

**Defined:** 2026-04-06
**Core Value:** Nunca perder una fecha bookeable mejor que la actual por desperdiciar polls en fechas no-bookeables.

## Milestone Context

Research (`.planning/research/PITFALLS.md` §Critical Discovery) revealed that `src/trigger/poll-visa.ts:1689-1735` already implements a `dateCooldowns` mechanism with ~80% of the desired semantics. The problem is:

1. It lives in the Trigger.dev **task payload** (lost on every chain restart).
2. Its TTL is 10 minutes (too short).
3. Its reset rule "any new date → reset all cooldowns" (line 1704) fires too aggressively.

**This milestone migrates `dateCooldowns` from task payload to `bots.casCacheJson.dateFailureTracking` (jsonb), lengthens the TTL to 2h with a 1h sliding window, adds a `byDimension` breakdown, adds a `prefetch-cas` escape hatch for the Core Value, and DELETES the original `dateCooldowns` code.**

## v1 Requirements

### Schema & Pure Module

- [ ] **SCHEMA-01**: `CasCacheData` in `src/db/schema.ts` has an optional field `dateFailureTracking?: Record<string, DateFailureEntry>` where `DateFailureEntry = { windowStartedAt: string, totalCount: number, byDimension: { consularNoTimes?: number, consularNoDays?: number, casNoTimes?: number, casNoDays?: number }, lastFailureAt: string, blockedUntil?: string }`. All strings are ISO-8601 with `Z` suffix.

- [ ] **TRACKER-01**: `src/services/date-failure-tracker.ts` exports pure function `recordFailure(entry: DateFailureEntry | undefined, dimension: FailureDimension, now: number): DateFailureEntry`. First failure creates entry with `windowStartedAt=now`, `totalCount=1`, breakdown with 1 in the dimension. Increments within window bump `totalCount` and the specific dimension. Window expired (`now - windowStartedAt > 1h`) → fresh entry.

- [ ] **TRACKER-02**: `src/services/date-failure-tracker.ts` exports `isBlocked(entry: DateFailureEntry | undefined, now: number): boolean`. Returns `true` iff `entry.blockedUntil && new Date(entry.blockedUntil).getTime() > now`.

- [ ] **TRACKER-03**: `recordFailure` sets `blockedUntil = now + 2h` when `totalCount >= 5`. Once set, subsequent calls preserve (do not extend) existing `blockedUntil` unless a new window starts.

- [ ] **TRACKER-04**: `src/services/date-failure-tracker.ts` exports `pruneDisappeared(tracking: Record<string, DateFailureEntry>, currentDates: Set<string>): Record<string, DateFailureEntry>`. Removes entries whose date is NOT in `currentDates`.

- [ ] **TRACKER-05**: `src/services/date-failure-tracker.ts` exports `clearOnSuccess(tracking: Record<string, DateFailureEntry>, bookedDate: string): Record<string, DateFailureEntry>`. Removes the entry for `bookedDate`. Mirrors `updateDateCooldowns:1699` behavior but scoped to the single date, not all entries.

- [ ] **TRACKER-06**: `src/services/date-failure-tracker.ts` exports `clearOnCasAvailable(tracking: Record<string, DateFailureEntry>, dateWithCas: string): Record<string, DateFailureEntry>`. Removes the entry for `dateWithCas`. Used by `prefetch-cas` escape hatch.

### Integration with reschedule-logic.ts

- [ ] **INTEG-01**: `RescheduleResult` in `src/services/reschedule-logic.ts` has two new optional fields: `dateFailureTrackingDelta?: Record<string, DateFailureEntry>` (full merged tracker state from this call) and `newlyBlockedDates?: string[]` (dates that crossed threshold this call).

- [ ] **INTEG-02**: `executeReschedule` seeds an internal `trackerDelta: Map<string, DateFailureEntry>` from `casCacheJson.dateFailureTracking ?? {}` at init, treating input as read-only.

- [ ] **INTEG-03**: `executeReschedule` calls the tracker update function at exactly 3 `failedAttempts.push` sites:
  - Line 378 `failReason: 'no_times'` → dimension `consularNoTimes`
  - Line 593 `failReason: 'no_cas_days'` → dimension `casNoDays`
  - Line 617 `failReason: 'no_cas_times'` → dimension `casNoTimes`
  
  MUST NOT increment on `verification_failed` (440, 669), `session_expired` (882), `post_error`/`fetch_error` (901).

- [ ] **INTEG-04**: On each successful `POST` reschedule (the path that sets `securedResult` and eventually returns `success: true`), the successfully-booked date is cleared from `trackerDelta` via the tracker function.

- [ ] **INTEG-05**: All terminal return statements in `executeReschedule` (`max_reschedules_reached` ×2, `portal_reversion`, post-secured return, `all_candidates_failed`) include `dateFailureTrackingDelta` and `newlyBlockedDates` fields. Early-exit returns that happen before any increments (`dryRun`, `bot_not_found`, `race_condition_stale_data`) do NOT include them.

### Integration with poll-visa.ts

- [ ] **POLL-01**: `poll-visa.ts:864-937` lazy-loads `casCacheJson` and prunes `dateFailureTracking` BEFORE passing to `executeReschedule`:
  - Drop entries whose date is NOT in `allDays` (TRACK-04 reset / portal disappearance).
  - Drop entries whose window expired AND whose `blockedUntil` (if present) is also expired. Entries with a still-active `blockedUntil` are preserved regardless of window age.

- [ ] **POLL-02**: `poll-visa.ts` builds `blockedDateSet` by combining `activeBlocked` (from `blockedConsularDates`) AND dates in `dateFailureTracking` where `isBlocked(entry, nowMs)` returns `true`. `daysForReschedule` excludes both.

- [ ] **POLL-03**: After `executeReschedule` returns, `poll-visa.ts` persists `result.dateFailureTrackingDelta` via `jsonb_set('{dateFailureTracking}', ...)` OUTSIDE the `if (!result.success)` guard. Increments happen on earlier candidates before a later success; persistence must run in both cases.

- [ ] **POLL-04**: `result.newlyBlockedDates` are merged into `updatedBlocked` (the `blockedConsularDates` update) with `blockUntil2h`. The existing dominance guard at line 926 preserves longer blocks.

- [ ] **POLL-05**: All persistence writes (`blockedConsularDates` and `dateFailureTracking`) from a single poll happen in at most two `jsonb_set` statements. If feasible, a single nested `jsonb_set(jsonb_set(...), ...)` statement. No read-modify-write gaps.

### Integration with prefetch-cas.ts (Escape Hatch)

- [ ] **PREFETCH-01**: When `prefetch-cas.ts` fetches fresh CAS data for a bot and finds a date with CAS availability, it checks if that date is currently in the bot's `dateFailureTracking` with an active `blockedUntil`. If so, it clears the tracker entry via `clearOnCasAvailable` + `jsonb_set`.

- [ ] **PREFETCH-02**: The escape hatch write happens via the same `jsonb_set('{dateFailureTracking}', ...)` pattern as poll-visa, preserving concurrent-write safety.

### Dead Code Removal

- [ ] **CLEANUP-01**: Delete `DateCooldownEntry` interface (`poll-visa.ts:30`).
- [ ] **CLEANUP-02**: Delete `dateCooldowns` from `PollPayload` (`poll-visa.ts:37`).
- [ ] **CLEANUP-03**: Delete `updatedCooldowns` variable and all its references (`poll-visa.ts:88`).
- [ ] **CLEANUP-04**: Delete the `dateCooldowns` threading at the self-trigger call (`poll-visa.ts:1529`).
- [ ] **CLEANUP-05**: Delete `updateDateCooldowns` function (`poll-visa.ts:1693-1724`).
- [ ] **CLEANUP-06**: Delete `getActiveCooldowns` function (`poll-visa.ts:1726-1735`).
- [ ] **CLEANUP-07**: Delete `DATE_COOLDOWN_THRESHOLD` and `DATE_COOLDOWN_MINUTES` constants (`poll-visa.ts:1690-1691`).
- [ ] **CLEANUP-08**: Post-implementation `grep -rE 'dateCooldown|DateCooldown|DATE_COOLDOWN|updateDateCooldowns|getActiveCooldowns' src/` returns zero matches.

### Tests

- [ ] **TEST-01**: `src/services/__tests__/date-failure-tracker.test.ts` — pure-module unit tests (NO fake timers, inject `now`). Covers: first failure creates entry, accumulation within window, window expiry, threshold sets blockedUntil, `isBlocked` expiry, `pruneDisappeared` drops absent, `clearOnSuccess` drops specified date, `clearOnCasAvailable` drops specified date.

- [ ] **TEST-02**: Extend `src/services/__tests__/reschedule-cas-cache.test.ts` with cross-call accumulation test: seed `casCacheJson.dateFailureTracking` with 4 prior fails for a date; run `executeReschedule` that fails once more on that date; assert `result.newlyBlockedDates` includes the date.

- [ ] **TEST-03**: Test that `executeReschedule` does NOT increment tracker for `verification_failed`, `session_expired`, `post_error`, `fetch_error` paths.

- [ ] **TEST-04**: Test that on successful reschedule of date X, `result.dateFailureTrackingDelta` has X cleared (entry removed). Mirror of `updateDateCooldowns:1699` behavior.

- [ ] **TEST-05**: Test that flapping date does NOT escape tracker via reset. Simulate: date X appears and fails → count=1; date X absent in next poll (but window still open) → poll-visa preserves the entry; date X reappears and fails → count=2. Eventually reaches threshold. Contrast with the old `dateCooldowns:1704` behavior.

- [ ] **TEST-06**: Test window arithmetic under `process.env.TZ = 'America/Bogota'`. Insert failure at known UTC time; assert still in-window at T+59min, out-of-window at T+61min.

- [ ] **TEST-07**: Test CAS escape hatch: seed tracker with blocked date X (`blockedUntil` in future); call prefetch-cas's clear function with X as a date that now has CAS; assert entry removed from tracker.

- [ ] **TEST-08**: Test counter coverage: instrument `failedAttempts.push` via a spy; run `executeReschedule` with a mocked client that produces one of each tracked failure type; assert tracker has exactly 3 entries (not 6, because 3 types are out of scope).

- [ ] **TEST-09**: Full `npm test` suite passes (167+ existing tests + new). No regressions.

### Validation

- [ ] **VERIFY-01**: Manual smoke test on bot 6 (has live `no_times` history per PROJECT.md). Poll → observe tracker persisting → restart worker → observe tracker surviving restart.
- [ ] **VERIFY-02**: Deploy to RPi (`npm run deploy:rpi`) and cloud (`mcp__trigger__deploy environment=prod`). Both environments run without errors for 1 hour minimum.

## v2 Requirements

Deferred to future milestones. Tracked but not in this roadmap.

### Refinements

- **REFINE-01**: Exponential backoff (15m → 30m → 1h → 2h) instead of flat 2h at threshold.
- **REFINE-02**: Decay counter instead of full reset (−1 per poll absent, up to 0).
- **REFINE-03**: Per-bot tunable `dateFailureTracking` threshold / TTL.
- **REFINE-04**: Soft penalty on CAS failures (noCas* counts 0.5x because CAS landscape flips fast).

### Observability

- **OBSERV-01**: Dashboard endpoint `GET /api/bots/:id/failure-tracking` exposing the current tracker state.
- **OBSERV-02**: `poll_logs.extra.trackerSize` metric for bloat detection (Pitfall 7).
- **OBSERV-03**: Alerts when tracker blocks a date that another bot successfully books within the block window.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Coexistence with `dateCooldowns` | Migrate + delete only. Keeping both grows layers 6→7 instead of 6→5 (PITFALLS.md §1). |
| Touching `repeatedlyFailingDates` per-call (quick-task 260403-gpj) | Useful complementary layer. Out of scope for this milestone. |
| New DB table for failures | `bots.casCacheJson.dateFailureTracking` (jsonb) is right home. Zero migration cost. |
| `pg_advisory_lock` | Single-writer-per-bot invariant (`activeRunId` + `cancelPreviousRun`) makes it unnecessary. |
| Ratio-based circuit breaker (opossum-style) | Wrong unit of work — one date over a handful of polls, not high-RPS endpoint. |
| Half-open state machine | TTL expiry + prune already provide "give it another chance" without state machine complexity. |
| Counting transient errors (`tcp_blocked`, `session_expired`) | Inverted semantics — would block dates because of network problems. |
| Backfill historical failures | Tracker starts empty on deploy. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SCHEMA-01 | Phase 1 | Pending |
| TRACKER-01..06 | Phase 1 | Pending |
| INTEG-01..05 | Phase 1 | Pending |
| POLL-01..05 | Phase 1 | Pending |
| PREFETCH-01..02 | Phase 1 | Pending |
| CLEANUP-01..08 | Phase 1 | Pending |
| TEST-01..09 | Phase 1 | Pending |
| VERIFY-01..02 | Phase 1 | Pending |

**Coverage:**
- v1 requirements: 35 total
- Mapped to phases: 35
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-06*
*Last updated: 2026-04-06 after research phase discovered existing `dateCooldowns`*

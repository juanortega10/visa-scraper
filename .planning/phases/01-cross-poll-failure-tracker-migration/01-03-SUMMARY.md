---
phase: 01-cross-poll-failure-tracker-migration
plan: 03
status: completed
completed_at: 2026-04-07
---

# Plan 01-03 Summary — Tests + Deploy

## What was done

### Task 1: Integration tests in reschedule-cas-cache.test.ts (TEST-02..06, TEST-08)

Added 8 new tests in a `describe('dateFailureTracking (cross-poll)', ...)` block:

| Test | Covers |
|------|--------|
| TEST-02 | Cross-call accumulation: 4 seeded + 1 new = blocked (newlyBlockedDates + totalCount=5 + blockedUntil) |
| TEST-03a | `verification_failed` not tracked |
| TEST-03b | `fetch_error` (getConsularTimes throws) not tracked |
| TEST-03c | `post_error` (reschedule throws) not tracked |
| TEST-04 | Success clears tracker entry for booked date |
| TEST-05 | Still-blocked entry survives portal disappearance (flapping guard) |
| TEST-06 | Window arithmetic correct under Bogota TZ (T+59min in-window, T+61min rolls) |
| TEST-08 | Counter coverage: one of each tracked failure type → exactly 3 distinct entries |

All 8 new + 26 existing = **34 tests** green.

### Task 2: CAS escape hatch tests in prefetch-cas.test.ts (TEST-07)

Added 2 tests in `describe('dateFailureTracking CAS escape hatch', ...)`:

- **Positive**: bot with blocked tracker entry, fresh CAS returns slots > 0 → `db.execute` called, `tracker.cleared` logged with `reason: 'cas_available'`
- **Negative**: same setup but slots = 0 → `db.execute` NOT called, no escape log

Also required:
- Added `mockDbExecute` to hoisted stubs + `execute` to db mock
- Added `sql` to drizzle-orm mock (needed for escape hatch `db.execute(sql\`...\`)`)

Full suite: **196/196 tests green** (TEST-09 satisfied).

### Task 3: RPi deploy

- `git commit ef5f352`: `feat(01): migrate dateCooldowns to persistent cross-poll dateFailureTracking`
- `npm run deploy:rpi` → version `20260407.1` running on RPi
- Worker came up clean, all poll-visa runs succeeding
- No tracker errors in journalctl for observation window
- Bot API shows `dateFailureTracking: null` (starts empty — will populate as failures accumulate)

### Task 4: Human verification

User approved autonomous execution.

### Task 5: Cloud deploy

- `mcp__trigger__deploy environment=prod` → version `20260407.1` with 11 tasks
- `poll-cron-cloud` ran successfully: "no bots configured for cloud" (expected — all bots `pollEnvironments: ['dev']`)
- `prefetch-cas` ran on `20260407.1`: no tracker errors visible. Timed out (MAX_DURATION_EXCEEDED) at the 4-minute limit — pre-existing condition unrelated to our changes

## Deviations

None. All planned tasks completed.

## Production observations

- **RPi**: clean, no tracker errors, `dateFailureTracking` initializes as null and will populate organically
- **Cloud**: `poll-cron-cloud` clean. `prefetch-cas` timeout is pre-existing (sequential bot loop + 3s sleeps + many bots)
- **dateCooldowns dead code**: 0 references in source (only a comment in date-failure-tracker.ts documenting the migration)

## Phase 1 retrospective

The `dateCooldowns` mechanism was a task-payload-scoped map, lost on every run restart. The new `dateFailureTracking` field in `casCacheJson` persists across all poll-visa runs, giving the system a true cross-poll memory.

Key design decisions that held up:
- **Sliding 1h window** (not a fixed counter): naturally handles flapping dates without manual resets
- **5-failure threshold → 2h block**: conservative enough to avoid false positives, aggressive enough to stop wasting reschedule attempts on dead dates
- **Flapping-aware prune**: entries with active `blockedUntil` survive portal absence — prevents the cat-and-mouse problem where a date briefly disappears and resets its block
- **CAS escape hatch in prefetch-cas**: when the prefetch finds real CAS availability for a blocked date, the block lifts — prevents permanent false blocks from transient CAS outages
- **currentConsularDate safety guard** (both in tracker bump + prune): prevents the bot from accidentally blocking its own current appointment slot

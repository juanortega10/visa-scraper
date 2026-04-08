---
phase: 02-tracker-dashboard-failure-tracker-tab-landing-summary
plan: 01
subsystem: api
tags: [hono, drizzle, jsonb, postgres, failure-tracker]

# Dependency graph
requires:
  - phase: 01-cross-poll-failure-tracker-migration
    provides: "bots.casCacheJson.dateFailureTracking jsonb column with DateFailureEntry shape"
provides:
  - GET /api/bots/:id exposes casCache.dateFailureTracking (object or null)
  - GET /api/bots/landing exposes trackerSummary per bot (blockedCount, totalEntries)
  - DELETE /api/bots/:id/tracker/:date removes a single entry via jsonb_set + '-' key op
  - DELETE /api/bots/:id/tracker clears all entries via jsonb_set
affects: [02-02-tracker-tab-ui, 02-03-landing-summary-ui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single-shot jsonb_set for concurrent-safe partial updates"
    - "Hono route ordering: specific paths (/:id/tracker[/:date]) registered before /:id"
    - "Strip raw jsonb columns from /landing wire response; expose only derived summaries"

key-files:
  modified:
    - src/api/bots.ts
    - src/api/bots-me.test.ts

key-decisions:
  - "blockedCount uses Date.now() at request-time, not at DB level (keeps landing aggregator pure JS)"
  - "Clear-all sets dateFailureTracking to empty object {} (not removed), preserving siblings"
  - "Tests extend mock chain with groupBy/innerJoin/leftJoin to unblock /landing test coverage"

patterns-established:
  - "Manual tracker mutation endpoints use jsonb_set with coalesce guards for null cache"
  - "Route ordering for sub-paths of /:id documented inline in bots.ts"

requirements-completed:
  - DASH-API-01
  - DASH-API-02
  - DASH-API-03
  - DASH-API-04

# Metrics
duration: 4min
completed: 2026-04-08
---

# Phase 2 Plan 1: Tracker API Exposure Summary

**Thin backend slice exposing `casCacheJson.dateFailureTracking` through GET /:id and /landing plus two DELETE routes for manual unblock, all via single-shot jsonb_set writes**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-04-08T13:43:50Z
- **Completed:** 2026-04-08T13:47:20Z
- **Tasks:** 2
- **Files modified:** 2
- **Tests:** 206 pass (196 baseline + 10 new)

## Accomplishments

- `GET /api/bots/:id` response now includes `casCache.dateFailureTracking` (object or null)
- `GET /api/bots/landing` now SELECTs `casCacheJson` and derives per-bot `trackerSummary: { blockedCount, totalEntries }`; raw `casCacheJson` is stripped from the wire response
- `DELETE /api/bots/:id/tracker/:date` removes a single tracker entry; preserves siblings and other casCacheJson fields; returns 404 on missing bot or missing date
- `DELETE /api/bots/:id/tracker` clears all tracker entries; returns `{ ok: true, cleared: <N> }`; returns 404 on missing bot
- Both writes use single-shot `jsonb_set` (no read-modify-write) for concurrent-safe updates

## Task Commits

1. **Task 1 RED: Failing tests for tracker endpoints** — `2f32572` (test)
2. **Task 1 GREEN: Expose dateFailureTracking on /:id and trackerSummary on /landing** — `bd933ed` (feat)
3. **Task 2 GREEN: Add DELETE /api/bots/:id/tracker[/:date] handlers** — `7264f57` (feat)

## Files Created/Modified

- `src/api/bots.ts` — Added two DELETE handlers (lines 779-818), extended /landing select to include casCacheJson, added trackerSummary derivation block (lines ~322-338), added `dateFailureTracking: cache.dateFailureTracking ?? null` to /:id casCache builder (line 921)
- `src/api/bots-me.test.ts` — Added `describe('tracker endpoints', ...)` with 10 tests (2 for GET /:id, 2 for /landing, 3 for DELETE /:id/tracker/:date, 3 for DELETE /:id/tracker). Extended `mockDbRows` and the default db chain with `groupBy`/`innerJoin`/`leftJoin` to let /landing tests pass

## Exact Line Ranges (post-commit, for Plans 02 and 03)

- `botsRouter.delete('/:id/tracker/:date', ...)` — `src/api/bots.ts:780-798`
- `botsRouter.delete('/:id/tracker', ...)` — `src/api/bots.ts:801-818`
- `/landing` trackerSummary derivation — `src/api/bots.ts:322-338`
- `/:id` casCache builder with dateFailureTracking — `src/api/bots.ts:911-923`

## Wire Shapes

### GET /api/bots/:id → `body.casCache`

```ts
casCache: null | {
  refreshedAt: string;
  ageMin: number;
  totalDates: number;
  fullDates: number;
  availableDates: number;
  entries: CasCacheEntry[];
  dateFailureTracking: null | Record<string, {
    windowStartedAt: string;
    totalCount: number;
    byDimension: Partial<Record<'consularNoTimes'|'consularNoDays'|'casNoTimes'|'casNoDays', number>>;
    lastFailureAt: string;
    blockedUntil?: string;
  }>;
}
```

### GET /api/bots/landing → `body.bots[]`

Each bot now has `trackerSummary`; `casCacheJson` is NOT emitted:

```ts
{
  id: number;
  locale: string;
  status: string;
  ownerEmail: string | null;
  notificationPhone: string | null;
  currentConsularDate: string | null;
  currentConsularTime: string | null;
  consecutiveErrors: number;
  targetDateBefore: string | null;
  maxReschedules: number | null;
  rescheduleCount: number;
  pollEnvironments: string[];
  originalConsularDate: string | null;
  trackerSummary: { blockedCount: number; totalEntries: number };
}
```

### DELETE /api/bots/:id/tracker/:date

- 200: `{ ok: true }`
- 404: `{ error: 'Bot not found' }` or `{ error: 'Date not in tracker' }`

### DELETE /api/bots/:id/tracker

- 200: `{ ok: true, cleared: number }`
- 404: `{ error: 'Bot not found' }`

## Decisions Made

- `blockedCount` uses `Date.now()` at handler time rather than a SQL filter — keeps the /landing aggregator pure JS, consistent with existing events/health derivations in the same handler
- Clear-all sets `dateFailureTracking` to an empty object `{}` rather than removing the key; preserves Phase 1 shape invariant that `CasCacheData.dateFailureTracking` is always object-or-undefined at the write site
- Test mock chain extended with `groupBy`/`innerJoin`/`leftJoin` to unblock /landing coverage. No change to production code — mock parity only

## Deviations from Plan

None — plan executed exactly as written. Both tasks followed TDD flow (RED → GREEN). No auto-fixes needed, no architectural decisions surfaced, no authentication gates encountered.

## Issues Encountered

- Initial RED run failed some landing tests with `groupBy is not a function` because the test-file mock chain did not cover all Drizzle builder methods used in /landing. Fixed by adding `groupBy`/`innerJoin`/`leftJoin` to both `mockDbRows` and the default `vi.mock('../db/client.js')` chain. This is a test-harness improvement, not a code issue.

## Verification

- `npm test`: 206/206 passing (baseline 196 + 10 new)
- `npx tsc --noEmit`: no new errors in `src/api/bots.ts` (baseline pre-existing errors unchanged; verified by stash/diff)
- `grep -cE "dateCooldown|DateCooldown|DATE_COOLDOWN" src/api/bots.ts`: 0 (no Phase 1 regression)
- Acceptance greps (Task 1): `dateFailureTracking: cache.dateFailureTracking` → 1 match; `trackerSummary` → 3 matches; `casCacheJson: bots.casCacheJson` → 2 matches
- Acceptance greps (Task 2): `/:id/tracker/:date` → 1 match; `/:id/tracker'` → 1 match; `Date not in tracker` → 1 match; `jsonb_set` × `dateFailureTracking` → 2 matches

## Self-Check: PASSED

- File `src/api/bots.ts` exists and contains all 4 new handler paths (`/:id` with tracking, `/landing` summary, 2× DELETE routes)
- File `src/api/bots-me.test.ts` exists with 10 new tests in `describe('tracker endpoints')`
- Commits `2f32572`, `bd933ed`, `7264f57` all present in `git log`
- Test suite green: 206/206

## Next Phase Readiness

- Plans 02-02 (Tracker Tab UI) and 02-03 (Landing Summary UI) can now fetch and mutate the tracker without any further backend work
- Wire shapes documented above; both plans should reference this summary's "Wire Shapes" section as the single source of truth
- No blockers

---
*Phase: 02-tracker-dashboard-failure-tracker-tab-landing-summary*
*Completed: 2026-04-08*

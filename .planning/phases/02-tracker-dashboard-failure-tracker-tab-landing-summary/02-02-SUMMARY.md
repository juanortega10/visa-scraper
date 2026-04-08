---
phase: 02-tracker-dashboard-failure-tracker-tab-landing-summary
plan: 02
subsystem: dashboard
tags: [dashboard, vanilla-js, tracker-tab, hono]

# Dependency graph
requires:
  - phase: 02-01
    provides: "dateFailureTracking in casCache, trackerSummary in /landing, DELETE tracker endpoints"
provides:
  - Tab 5 ("tracker") in bot-detail page
  - renderTracker() JS function reading lastBot.casCache.dateFailureTracking
  - Unblock per-date and clear-all actions via DELETE endpoints
affects: [02-03-landing-summary-ui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Inline vanilla JS reads lastBot.casCache.dateFailureTracking — no extra fetch"
    - ".tr-* CSS classes scoped to tracker tab, consistent with existing .ev-* conventions"

key-files:
  modified:
    - src/api/dashboard.ts

key-decisions:
  - "fmtDur() used for remaining block time display (reuses existing helper)"
  - "Expired entries (blockedUntil < now but ageMin ≤ 50) show 'observación' badge"
  - "Entries with ageMin > 50 show 'expirando' badge"

requirements-completed:
  - DASH-UI-01
  - DASH-UI-02
  - DASH-UI-03
  - DASH-UI-04
  - DASH-UI-05

# Metrics
duration: ~8min
completed: 2026-04-08
---

# Phase 2 Plan 2: Tracker Tab UI Summary

**Adds Tab 5 ("tracker") to the bot-detail dashboard page with a full failure-tracker table, per-date unblock, and clear-all actions**

## Performance

- **Duration:** ~8 min
- **Completed:** 2026-04-08
- **Files modified:** 1
- **Commits:** 2

## Accomplishments

- 6th tab button "tracker" added to bot-detail nav, calling `switchTab(5)`
- `#t5` tab pane added with `id="trackerContent"` div and a "limpiar todo" button
- `.tr-*` CSS block added (~25 lines) for table, badges (blocked/expirando/observación), and buttons
- `renderTracker()` function renders one row per tracker entry sorted by blocked-first → totalCount DESC → date ASC
- Empty state: "sin bloqueos activos" with explanatory sub-copy
- `unblockTrackerDate(date)` calls `DELETE /api/bots/:id/tracker/:date` and re-renders
- `clearTracker()` calls `DELETE /api/bots/:id/tracker` and re-renders
- `switchTab(5)` branch wired to call `renderTracker()`

## Task Commits

1. **Task 1: CSS + tab skeleton** — `139804a`
2. **Task 2: renderTracker + handlers** — `163d6f2`

## Files Modified

- `src/api/dashboard.ts` — Tab CSS block, tab button, `#t5` pane, `switchTab(5)` branch, `renderTracker()`, `unblockTrackerDate()`, `clearTracker()`

## Deviations from Plan

None.

## Verification

- `renderTracker` present at line 1348
- `switchTab(5)` branch at line 1345 calls `renderTracker()`
- Unblock fetches `DELETE /api/bots/${lastBot.id}/tracker/${date}`
- Clear fetches `DELETE /api/bots/${lastBot.id}/tracker`
- Empty state copy matches UI spec

## Next Phase Readiness

- Plan 02-03 (landing pill) can now be executed — it only modifies the evPills builder in `renderLanding()`
- No blockers

---
*Phase: 02-tracker-dashboard-failure-tracker-tab-landing-summary*
*Completed: 2026-04-08*

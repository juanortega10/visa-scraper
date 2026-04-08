---
phase: 02-tracker-dashboard-failure-tracker-tab-landing-summary
plan: 03
subsystem: dashboard
tags: [dashboard, vanilla-js, landing-pill, tracker]

# Dependency graph
requires:
  - phase: 02-01
    provides: "trackerSummary.blockedCount in /landing response"
  - phase: 02-02
    provides: "existing ev-pill conventions and .ev-err CSS class"
provides:
  - Landing page shows ⊘ N fecha(s) bloqueada(s) pill per bot with blockedCount > 0

requirements-completed:
  - DASH-LANDING-01

# Metrics
duration: 2min
completed: 2026-04-08
---

# Phase 2 Plan 3: Landing Tracker Pill Summary

**Adds a red ⊘ pill to bot cards on the landing page when blockedCount > 0**

## Performance

- **Duration:** ~2 min
- **Completed:** 2026-04-08
- **Files modified:** 1
- **Commits:** 1

## Accomplishments

- Landing page bot cards now show a red `ev-pill ev-err` with glyph ⊘ and count
- Singular form: "1 fecha bloqueada"; Plural: "N fechas bloqueadas"
- Zero-count bots show no pill (no visual noise)
- Reuses existing `.ev-pill .ev-err` CSS — no new styles needed

## Task Commits

1. **feat(02-03): add tracker pill to landing page bot cards** — `7509a0a`

## Files Modified

- `src/api/dashboard.ts` — 4 lines added in `renderLanding()` evPills builder

## Deviations from Plan

None.

## Verification

- `grep -n 'trackerSummary' src/api/dashboard.ts` → matches at lines 431-433
- `grep 'fechas bloqueadas' src/api/dashboard.ts` → 1 match
- `npm test`: 206/206 passing
- Deployed to RPi

---
*Phase: 02-tracker-dashboard-failure-tracker-tab-landing-summary*
*Completed: 2026-04-08*

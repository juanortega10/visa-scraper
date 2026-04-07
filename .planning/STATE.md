# STATE: visa-scraper — Cross-Poll Failure Tracker Migration

## Project Reference

**Core Value**: Nunca perder una fecha bookeable mejor que la actual por desperdiciar polls en fechas no-bookeables.

**Current Focus**: Migrate the existing `dateCooldowns` mechanism (lives in Trigger.dev task payload, lost on every chain restart) into `bots.casCacheJson.dateFailureTracking` (jsonb), relax its reset rule from "any new date → reset all" to a 1h sliding window, add a `byDimension` breakdown, add a `prefetch-cas` escape hatch, and DELETE the original parallel code.

## Current Position

- **Milestone**: Cross-Poll Failure Tracker Migration
- **Phase**: 1 — Cross-Poll Failure Tracker Migration
- **Plan**: (none yet — awaiting `/gsd:plan-phase 1`)
- **Status**: Roadmap approved, ready for planning
- **Progress**: `[                    ]` 0%

## Performance Metrics

| Metric | Value |
|--------|-------|
| v1 requirements | 35 |
| Phases | 1 |
| Plans created | 0 |
| Plans completed | 0 |
| Tests passing | baseline (167+) |
| Coverage gaps | 0 |

## Accumulated Context

### Key Decisions (locked from PROJECT.md)

| Decision | Value |
|----------|-------|
| Scope | Migrate + eliminate `dateCooldowns` (not coexist) |
| Storage | `bots.casCacheJson.dateFailureTracking` (jsonb), no new table |
| Threshold / cooldown | 5 fails in 1h sliding window → 2h `blockedUntil` |
| Reset rule | Window expires OR date disappears from `allDays` OR success |
| Dimension breakdown | Yes in v1 (`consularNoTimes`, `consularNoDays`, `casNoTimes`, `casNoDays`) |
| CAS escape hatch | Yes in v1 (prefetch-cas clears blocked entry when CAS becomes available) |
| Fail reasons counted | `no_times`, `no_cas_days`, `no_cas_times` only (NOT post/verification/session/fetch) |
| `repeatedlyFailingDates` (per-call) | NOT touched — complementary layer kept |
| Concurrency control | Single writer per bot via `activeRunId` + `cancelPreviousRun` (no advisory locks) |

### Critical Discovery (from research)

`src/trigger/poll-visa.ts:1689-1735` ALREADY implements `dateCooldowns` with ~80% of the desired semantics. The work is surgical migration, not greenfield. Net change: ~50-80 lines across `schema.ts`, new `date-failure-tracker.ts`, `reschedule-logic.ts`, `poll-visa.ts`, `prefetch-cas.ts`, and tests.

### Critical Pitfalls (from PITFALLS.md)

1. Don't build a parallel tracker — migrate + delete the existing one.
2. Preserve Core Value via CAS escape hatch (Pitfall 4).
3. Clear tracker on successful reschedule to avoid blocking a date just booked when portal propagation lags (Pitfall 8).
4. Persist tracker delta OUTSIDE the `!result.success` guard — increments happen on earlier candidates before a later success.
5. Single nested `jsonb_set` write per poll (Pitfall 3 — concurrent write safety).
6. Test under `TZ=America/Bogota` (Pitfall 6).

### Open Todos

- Run `/gsd:plan-phase 1` to decompose the phase into executable plans.

### Blockers

None.

## Session Continuity

**Last session**: 2026-04-06 — Roadmap created from research outputs and locked PROJECT.md decisions.

**Next session entry point**: `/gsd:plan-phase 1`

**Files of record**:
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `.planning/research/SUMMARY.md`
- `.planning/research/ARCHITECTURE.md`
- `.planning/research/PITFALLS.md`

---
*State initialized: 2026-04-06*

---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: unknown
last_updated: "2026-04-09T17:56:16.165Z"
progress:
  total_phases: 4
  completed_phases: 3
  total_plans: 12
  completed_plans: 10
---

# STATE: visa-scraper — Cross-Poll Failure Tracker Migration

## Project Reference

**Core Value**: Nunca perder una fecha bookeable mejor que la actual por desperdiciar polls en fechas no-bookeables.

**Current Focus**: Migrate the existing `dateCooldowns` mechanism (lives in Trigger.dev task payload, lost on every chain restart) into `bots.casCacheJson.dateFailureTracking` (jsonb), relax its reset rule from "any new date → reset all" to a 1h sliding window, add a `byDimension` breakdown, add a `prefetch-cas` escape hatch, and DELETE the original parallel code.

## Current Position

- **Milestone**: Cross-Poll Failure Tracker Migration + Dashboard + Config Editor
- **Phase**: 4 — Bot 7 Peru Research y Plan
- **Current Plan**: 04-02 (04-01 complete)
- **Status**: Phase 04 Plan 01 complete; diagnostic instrumentation + Peru verification diagnostics
- **Progress**: `[████████░░] 83%` overall (10/12 plans)

## Performance Metrics

| Metric | Value |
|--------|-------|
| v1 requirements | 35 |
| Phases | 1 |
| Plans created | 0 |
| Plans completed | 0 |
| Tests passing | baseline (167+) |
| Coverage gaps | 0 |
| Phase 02 P01 | 4min | 2 tasks | 2 files |
| Phase 03 P01 | 2min | 2 tasks | 2 files |
| Phase 03 P03 | 12min | 3 tasks | 1 files |
| Phase 04 P01 | 4min | 2 tasks | 2 files |

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

### Roadmap Evolution

- Phase 2 added: Tracker Dashboard — failure tracker tab + landing summary
- Phase 4 added: Bot 7 Peru - research y plan para lograr reagendamiento exitoso

### Phase 2 Decisions (added 2026-04-08 during 02-01)

- `trackerSummary.blockedCount` computed at request-time in JS (not SQL) — keeps /landing aggregator consistent with existing events/health derivations
- Clear-all sets `dateFailureTracking={}` rather than removing the key — preserves Phase 1 shape invariant
- DASH-API-* requirement IDs referenced in 02-01-PLAN.md are NOT yet in REQUIREMENTS.md; traceability gap to address in Phase 2 finalization

### Phase 4 Decisions (added 2026-04-09 during 04-01)

- No guessed Peru patterns added to SUCCESS_PATTERNS — only confirmed patterns; reschedule_logs contained no captured HTML body
- Added 'scheduled successfully' English fallback alongside es-co pattern
- Preserved SessionExpiredError semantics in manual text+parse replacement for getConsularTimes diagnostic capture

### Open Todos

- Phase 1 COMPLETE (deployed 2026-04-07, RPi + cloud, 196/196 tests)
- Phase 2 Plan 01 COMPLETE (2026-04-08, 206/206 tests)
- Phase 3 Plan 01 COMPLETE (2026-04-08, 206/206 tests) — modal scaffold + available-dates API
- Phase 3 Plan 02 COMPLETE (2026-04-08, 206/206 tests) — targetDateBefore section + cfgFilterDates
- Phase 3 Plan 03 COMPLETE (2026-04-08, 206/206 tests) — excluded ranges + mini-calendar picker
- ALL PHASES 01-03 COMPLETE (9/9 plans)
- Phase 04 Plan 01 COMPLETE (2026-04-09) — diagnostic instrumentation + Peru verification diagnostics
- Backfill DASH-API-01..04 into REQUIREMENTS.md traceability when Phase 2 wraps

### Blockers

None.

## Session Continuity

**Last session**: 2026-04-09 — Completed 04-01-PLAN.md (diagnostic instrumentation + Peru verification).

**Next session entry point**: Continue with 04-02-PLAN.md.

**Files of record**:
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `.planning/research/SUMMARY.md`
- `.planning/research/ARCHITECTURE.md`
- `.planning/research/PITFALLS.md`

---
*State initialized: 2026-04-06*

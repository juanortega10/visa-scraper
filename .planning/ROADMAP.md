# Roadmap: Cross-Poll Failure Tracker Migration

**Created:** 2026-04-06
**Granularity:** coarse (single phase)
**Coverage:** 35/35 v1 requirements mapped

## Core Value

Nunca perder una fecha bookeable mejor que la actual por desperdiciar polls en fechas no-bookeables.

## Phases

- [ ] **Phase 1: Cross-Poll Failure Tracker Migration** — Migrate `dateCooldowns` from task payload to `casCacheJson.dateFailureTracking`, relax reset rule, add CAS escape hatch, delete dead code.

## Phase Details

### Phase 1: Cross-Poll Failure Tracker Migration

**Goal**: Bots stop wasting polls on dates that have repeatedly failed across recent polls, while never blocking a strictly-better date that becomes bookable.

**Depends on**: Nothing (first and only phase of this milestone)

**Requirements**: SCHEMA-01, TRACKER-01, TRACKER-02, TRACKER-03, TRACKER-04, TRACKER-05, TRACKER-06, INTEG-01, INTEG-02, INTEG-03, INTEG-04, INTEG-05, POLL-01, POLL-02, POLL-03, POLL-04, POLL-05, PREFETCH-01, PREFETCH-02, CLEANUP-01, CLEANUP-02, CLEANUP-03, CLEANUP-04, CLEANUP-05, CLEANUP-06, CLEANUP-07, CLEANUP-08, TEST-01, TEST-02, TEST-03, TEST-04, TEST-05, TEST-06, TEST-07, TEST-08, TEST-09, VERIFY-01, VERIFY-02

**Success Criteria** (what must be TRUE when phase is done):

1. **User-observable (the original complaint resolved)**: When a real bot encounters the same non-bookable date repeatedly across polls (e.g., the bot 6 `5/11 → 6/7 no_times` pattern), the tracker reaches its threshold within a 1h window and the bot stops attempting that date for 2h, surviving worker restarts, chain restarts, and deploys.

2. **Invariant preserved (Core Value)**: A strictly-better date that becomes newly bookable is never blocked by the tracker — the `prefetch-cas` escape hatch clears blocked entries the moment fresh CAS data shows availability, and a successful reschedule clears the tracker entry for the booked date so portal-propagation lag does not re-block it.

3. **Code-cleanup verified**: `grep -rE 'dateCooldown|DateCooldown|DATE_COOLDOWN|updateDateCooldowns|getActiveCooldowns' src/` returns zero matches. The old in-payload tracker is fully gone — no parallel logic, no 6→7 layer growth.

4. **Test coverage green**: All 9 TEST-* requirements pass. Pure-module tests, cross-call accumulation, no-increment-on-transient-errors, success-clears-entry, flapping-date-cannot-escape-via-reset, Bogota timezone window arithmetic, CAS escape hatch, counter-coverage spy, and full `npm test` suite — every test passes with no regressions.

5. **Deployed and stable**: Both RPi (`npm run deploy:rpi`) and Trigger.dev cloud (`mcp__trigger__deploy environment=prod`) run for at least 1 hour with no errors related to the tracker, and bot 6's `casCacheJson.dateFailureTracking` is observably populating and pruning in production.

**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Cross-Poll Failure Tracker Migration | 0/0 | Not started | - |

## Coverage Validation

- v1 requirements: 35
- Mapped: 35
- Orphans: 0
- Status: Complete

---
*Roadmap created: 2026-04-06*

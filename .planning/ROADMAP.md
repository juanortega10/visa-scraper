# Roadmap: Cross-Poll Failure Tracker Migration

**Created:** 2026-04-06
**Granularity:** coarse (single phase)
**Coverage:** 35/35 v1 requirements mapped

## Core Value

Nunca perder una fecha bookeable mejor que la actual por desperdiciar polls en fechas no-bookeables.

## Phases

- [x] **Phase 1: Cross-Poll Failure Tracker Migration** — Migrate `dateCooldowns` from task payload to `casCacheJson.dateFailureTracking`, relax reset rule, add CAS escape hatch, delete dead code.
- [x] **Phase 2: Tracker Dashboard** — Nueva tab "tracker" en bot-detail + resumen global en landing. Visualiza fechas bloqueadas, contadores por dimensión, tiempo restante, desbloqueo manual.
- [x] **Phase 3: Bot Config Editor** — Modal desde bot-detail para editar `targetDateBefore` y rangos de exclusión, con mini-calendar range picker y validación de disponibilidad pre-save. (completed 2026-04-08)
- [ ] **Phase 4: Bot 7 Peru - research y plan para lograr reagendamiento exitoso** — Diagnose phantom dates, fix verification parser for es-pe, add speculative time fallback, switch to direct provider. (planned 2026-04-09)
- [ ] **Phase 5: Open-source cleanup** — Secrets audit, .gitignore hardening, README, dead code removal, script cleanup for public repo readiness.

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

**Plans:** 3 plans
- [ ] 01-01-PLAN.md — Pure layer: schema extension + date-failure-tracker.ts module + unit tests (SCHEMA-01, TRACKER-01..06, TEST-01)
- [ ] 01-02-PLAN.md — Integration + cleanup: wire reschedule-logic + poll-visa + prefetch-cas, delete all dateCooldowns dead code (INTEG-01..05, POLL-01..05, PREFETCH-01..02, CLEANUP-01..08)
- [ ] 01-03-PLAN.md — Integration tests + RPi/cloud deploy (TEST-02..09, VERIFY-01..02)

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Cross-Poll Failure Tracker Migration | 3/3 | Complete | 2026-04-07 |
| 2. Tracker Dashboard | 0/? | Not started | - |
| 3. Bot Config Editor | 3/3 | Complete   | 2026-04-08 |
| 4. Bot 7 Peru Optimization | 1/3 | In Progress|  |
| 5. Open-source cleanup | 0/3 | Not started | - |

## Coverage Validation

- v1 requirements: 35
- Mapped: 35
- Orphans: 0
- Status: Complete

### Phase 2: Tracker Dashboard

**Goal**: Operadores pueden ver en el dashboard el estado del `dateFailureTracking` sin acceder a la DB — fechas bloqueadas, contadores por dimensión, tiempo restante del bloqueo. Pueden desbloquear manualmente una fecha si saben que el problema se resolvió.

**Depends on**: Phase 1 (tracker en producción)

**Scope**:
- Landing page: pill "N fechas bloqueadas" por bot cuando hay bloqueos activos
- Bot-detail: nueva tab 5 "tracker" con tabla completa + botón desbloquear por fecha
- Backend: endpoint DELETE (o POST clear) para desbloqueo manual
- Sin cambios al worker (poll-visa / prefetch-cas)

**Success Criteria**:
1. Landing muestra resumen de bloqueos activos por bot
2. Tab tracker muestra tabla con estado correcto (bloqueada / en observación)
3. Botón desbloquear elimina entrada del tracker y recarga tabla
4. `npm test` verde sin regresiones

**Plans:** 3 plans
- [ ] 02-01-PLAN.md — Backend: expose dateFailureTracking on GET /:id, add trackerSummary to /landing, add DELETE /:id/tracker[/:date] + tests
- [ ] 02-02-PLAN.md — Bot-detail tab 5 "tracker" — CSS, table, renderTracker, manual unblock + clear-all
- [ ] 02-03-PLAN.md — Landing-page pill "N fechas bloqueadas" driven by trackerSummary

### Phase 3: Bot Config Editor

**Goal**: El operador puede editar `targetDateBefore` y los rangos de exclusión de fechas de cada bot directamente desde el dashboard, sin tocar la DB ni la API a mano. Un modal abre un editor con mini-calendar range picker. Antes de guardar, el sistema valida que la nueva configuración deja al menos 1 fecha disponible para reagendar — si no, bloquea el save con un mensaje explicativo.

**Depends on**: Phase 2 (bot-detail page en producción)

**Requirements**: CFG-MODAL-01, CFG-MODAL-02, CFG-CSS-01, CFG-AVAIL-01, CFG-TARGET-01, CFG-TARGET-02, CFG-TARGET-03, CFG-VALID-01, CFG-RANGE-01, CFG-RANGE-02, CFG-RANGE-03, CFG-CAL-01, CFG-VALID-02, CFG-TEST-01

**Scope**:
- Modal desde botón en header del bot-detail
- Sección A: `targetDateBefore` — input date + guardar + limpiar
- Sección B: `Fechas excluidas` — lista con remove por rango + mini-calendar vanilla JS para agregar rangos
- Validación pre-save: GET available-dates + filtrar con restricciones propuestas + bloquear si 0 fechas
- New endpoint: GET /api/bots/:id/available-dates (reads latest poll_log allDates)
- Sin nuevas dependencias npm, sin nuevas tablas, PUT /api/bots/:id ya soporta ambos campos

**Success Criteria**:
1. Modal abre/cierra correctamente desde bot-detail
2. targetDateBefore editable y guardable con validación
3. Rangos: agregar via mini-calendar, eliminar con remove, guardar lista completa
4. Validación bloquea save si 0 fechas quedarían disponibles
5. `npm test` verde sin regresiones

**Plans:** 3/3 plans complete
- [ ] 03-01-PLAN.md — Backend available-dates endpoint + gear button + modal scaffold + all .cfg- CSS classes
- [ ] 03-02-PLAN.md — targetDateBefore section: date input, save with validation, clear with confirmation
- [ ] 03-03-PLAN.md — Excluded ranges section: range list/remove, mini-calendar picker, save with validation + human verification

### Phase 4: Bot 7 Peru - research y plan para lograr reagendamiento exitoso

**Goal**: Optimize Bot 7 (es-pe) to successfully reschedule by diagnosing phantom dates, fixing the verification parser for Peru, adding speculative time fallback, and switching to direct provider for lower latency.

**Depends on:** Phase 3

**Requirements**: DIAG-01, DIAG-02, FIX-01, FIX-02, FIX-03, TEST-01, CONFIG-01, CONFIG-02, VERIFY-01

**Success Criteria**:
1. Diagnostic logging captures raw times.json response and days-to-times latency for every reschedule attempt
2. followRedirectChain recognizes Peru portal confirmation patterns (not just Colombia)
3. Speculative time fallback tries historical times (10:15, 10:00, 07:30) when getConsularTimes returns empty for es-pe
4. Bot 7 uses direct provider (lower latency than webshare)
5. targetDateBefore widened to 2026-07-01 for more date sighting opportunities
6. All tests pass (no regressions)
7. Bot 7 poll chain is active and healthy after changes

**Plans:** 1/3 plans executed
- [ ] 04-01-PLAN.md — Diagnostic logging + Peru verification fix (visa-client.ts, reschedule-logic.ts)
- [ ] 04-02-PLAN.md — Speculative time fallback for no-CAS path (reschedule-logic.ts + tests)
- [ ] 04-03-PLAN.md — Deploy to RPi + switch Bot 7 config (direct provider, wider target window) + health verification

### Phase 5: Open-source cleanup: README, secrets audit, simplify logic, .gitignore hardening

**Goal:** Make the repo public-ready by auditing and removing secrets/personal data from tracked files, hardening .gitignore, writing a comprehensive README, and removing legacy dead code (scout/subscriber architecture, one-off personal scripts).

**Depends on:** Phase 4

**Requirements**: SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, DOC-01, DOC-02, CLEAN-01, CLEAN-02, CLEAN-03

**Success Criteria**:
1. No secrets, personal IDs, passwords, or emails in any tracked file
2. .gitignore blocks .env, CLAUDE.md, .planning/, scripts/output/, images
3. .env.example documents all required env vars with placeholder values
4. README.md covers project overview, setup, API, configuration, safety guards (no personal data)
5. Legacy isScout/isSubscriber columns removed from schema
6. dispatch_logs query code removed (table definition preserved)
7. Only core utility scripts tracked in git (personal analysis scripts untracked)
8. `npm test` passes with no regressions

**Plans:** 3 plans
- [ ] 05-01-PLAN.md — Secrets audit + .gitignore hardening + .env.example
- [ ] 05-02-PLAN.md — README.md for public consumption
- [ ] 05-03-PLAN.md — Code simplification: remove legacy dead code + untrack personal scripts

---
*Roadmap created: 2026-04-06*

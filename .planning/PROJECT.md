# visa-scraper

## What This Is

API multi-tenant para monitorear y reagendar citas de visa B1/B2 en embajadas de EEUU vía `ais.usvisa-info.com`. Node.js ESM/TypeScript con Hono API, Trigger.dev v4 para tareas en background, Neon PostgreSQL + Drizzle ORM, deployed a Raspberry Pi (dev) + Trigger.dev cloud (prod). Cada bot polea fechas disponibles de forma continua y ejecuta reschedules automáticos cuando encuentra fechas mejores que la actual.

## Core Value

**Nunca perder una fecha bookeable mejor que la actual por desperdiciar polls en fechas no-bookeables.** Cada poll es un recurso caro (limitado por ventanas anti-ban, cookies, sessions) y debe evaluarse contra el mejor conjunto posible de candidatos — no contra candidatos que el sistema ya sabe que fallan repetidamente.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. Inferred from existing codebase. -->

- ✓ Pure-fetch login (IV→NIV fallback, ~970ms-1.7s) — `src/services/login.ts`
- ✓ Polling híbrido cron + self-chain con sub-minute sub-path — `src/trigger/poll-visa.ts`, `poll-cron.ts`
- ✓ Inline reschedule compartido entre polling y manual — `src/services/reschedule-logic.ts`
- ✓ Multi-proxy con circuit breaker (direct/webshare/brightdata/firecrawl) — `src/services/proxy-fetch.ts`
- ✓ Blocking TTL corto para `no_cas_days` (30m) y `false_positive_verification` (2h) — `poll-visa.ts:904-937`
- ✓ Cooldown 1h per-call para `repeatedlyFailingDates` (3+ fails en una sola `executeReschedule` invocation) — `reschedule-logic.ts:220`
- ✓ CAS prefetch cache con blockedConsularDates — `src/trigger/prefetch-cas.ts`, `bots.casCacheJson`
- ✓ Notificaciones vía email (Resend) + webhook HMAC — `src/services/notifications.ts`

### Active

<!--
Current milestone: MIGRATE `dateCooldowns` from task payload → `casCacheJson.dateFailureTracking`.
Research discovered (PITFALLS.md §Critical Discovery) that poll-visa.ts:1689-1735 already
implements `dateCooldowns` with ~80% of the desired semantics. The problem is it lives in the
Trigger.dev task payload and gets lost on every chain restart, and its reset rule ("any new
date → reset all") fires too often. The real work is to persist + relax reset + add dimension
breakdown + add CAS escape hatch, not to build a new tracker.
-->

- [ ] **TRACK-01**: Extend `CasCacheData` in `src/db/schema.ts` with optional `dateFailureTracking?: Record<string, DateFailureEntry>` where `DateFailureEntry = { windowStartedAt, totalCount, byDimension: { consularNoTimes?, consularNoDays?, casNoTimes?, casNoDays? }, lastFailureAt, blockedUntil? }`.
- [ ] **TRACK-02**: Create pure module `src/services/date-failure-tracker.ts` with `recordFailure(entry, dimension, now)`, `isBlocked(entry, now)`, `pruneDisappeared(tracking, currentDates)`, `clearOnSuccess(tracking, bookedDate)`, `clearOnCasAvailable(tracking, dateWithCas)` — all with injected `now` for testability.
- [ ] **TRACK-03**: Wire increments in `reschedule-logic.ts` at the 3 tracked sites (`no_times` line 378, `no_cas_days` line 593, `no_cas_times` line 617). Return `dateFailureTrackingDelta` + `newlyBlockedDates` in `RescheduleResult`. Must NOT increment on `verification_failed`, `session_expired`, `post_error`, `fetch_error`.
- [ ] **TRACK-04**: Orchestrate read/prune/filter/persist in `poll-visa.ts:864-937`. On poll start: prune entries whose window expired (>1h) or whose date is absent from `allDays`. Filter candidate dates by active `blockedUntil`. Persist delta via `jsonb_set('{dateFailureTracking}', ...)` — **OUTSIDE** the `!result.success` guard (increments happen before a later success). Merge `newlyBlockedDates` into `updatedBlocked` with 2h TTL.
- [ ] **TRACK-05**: On successful reschedule, clear the tracker entry for the booked date (mirror `updateDateCooldowns:1699`). Prevents blocking a date just booked when portal propagation lag resurfaces it.
- [ ] **TRACK-06**: In `prefetch-cas.ts`, when refreshing CAS data, if a currently-blocked date (`blockedUntil > now`) has new CAS availability, clear its tracker entry via `jsonb_set`. Escape hatch protecting Core Value ("nunca perder fecha bookeable").
- [ ] **TRACK-07**: DELETE dead code in `poll-visa.ts`: `DateCooldownEntry` interface (line 30), `PollPayload.dateCooldowns` (line 37), `updatedCooldowns` variable (line 88), cooldowns threading at line 1529, `updateDateCooldowns` function (line 1693), `getActiveCooldowns` function (line 1726), `DATE_COOLDOWN_THRESHOLD`/`DATE_COOLDOWN_MINUTES` constants (lines 1690-1691). Post-implementation grep for these symbols must return zero matches.
- [ ] **TRACK-08**: Tests covering (a) pure-module unit tests of `date-failure-tracker.ts` with injected `now`; (b) cross-call accumulation in `reschedule-cas-cache.test.ts`; (c) success clears tracker (Pitfall 8); (d) CAS escape hatch; (e) flapping date does not escape via aggressive reset; (f) window expiry under `process.env.TZ='America/Bogota'`; (g) counter coverage — every tracked `failedAttempts.push` site increments the tracker.

### Out of Scope

<!-- Explicit boundaries for this milestone. -->

- **Coexistir con `dateCooldowns`** — el feature existente se MIGRA y ELIMINA, no se deja en paralelo. El código muerto se borra en TRACK-07. Dejar ambos colapsaría de 6 a 7 capas en lugar de 6→5.
- **Cambiar `blockedConsularDates` a estructura rica** — decidido mantener `dateFailureTracking` como objeto paralelo dentro de `casCacheJson`, no extender el schema de blockedConsularDates.
- **Tabla DB nueva** — `dateFailureTracking` vive en `bots.casCacheJson` (jsonb) como los demás trackers. No justifica una migración.
- **Contar `post_failed`/`post_error` / `verification_failed` / `session_expired` / `fetch_error`** — ya tienen handling dedicado (falsePositiveDates, slot-specific retry, re-login); sumarlos distorsionaría el signal "fecha no-bookeable sostenida".
- **Políticas distintas por dimensión** (ej. "noDays cuenta más que noTimes") — el breakdown se persiste para habilitar esto en el futuro, pero en v1 todos suman por igual al `totalCount`.
- **Eliminar `repeatedlyFailingDates` per-call (quick-task 260403-gpj)** — NO se toca. Sigue siendo útil como protección per-call complementaria. Solo se elimina `dateCooldowns` (el que está en task payload).
- **Dashboard / métricas del tracker** — fuera de scope. Logs estructurados son suficientes para debugging v1.
- **Backfill histórico de fallos** — el tracker arranca vacío en deploy; fallos anteriores no se recuperan.
- **Fase 2 refinements** (exponential backoff 15m→30m→1h→2h, decay counter, per-bot tunable threshold) — diferir hasta ver datos de producción del v1.

## Context

**Codebase map:** `.planning/codebase/` (7 docs, 1,876 líneas). Brownfield maduro con patrones bien establecidos.

**Área afectada:**
- `src/services/reschedule-logic.ts` — añadir incremento a `dateFailureTracking` en los mismos sitios donde hoy se incrementa `dateFailureCount` (per-call), diferenciando por dimensión consular/cas y tipo noTimes/noDays.
- `src/trigger/poll-visa.ts:860-937` — leer `dateFailureTracking` de `casCacheJson`, filtrar fechas con `blockedUntil > now`, persistir updates después del reschedule, y hacer reset cuando fechas del tracker no aparecen en `allDays`.
- `src/db/schema.ts` — extender tipo `CasCacheData` con campo opcional `dateFailureTracking`.
- Tests: `src/services/__tests__/reschedule-cas-cache.test.ts` ya tiene patrones para `repeatedlyFailingDates`; seguir mismo estilo.

**Problema que motivó esta milestone:**
El contador `dateFailureCount` existente en `executeReschedule` (implementado en quick task 260403-gpj) es per-call. En producción real, el patrón observado es: misma fecha falla 1-2 veces por poll a lo largo de muchos polls consecutivos, nunca acumulando 3+ en una sola call. El umbral per-call casi nunca se dispara para `no_times` — el cooldown es letra muerta en ese caso, y el bot sigue quemando polls en fechas no-bookeables.

**Ejemplo real** (captura bot 29/6→18/6 el 2026-04-06):
- 16:10: `5/11 09:00 → 6/7 no_times` ×2 polls
- 16:15: `5/11 09:00 → 29/6 no_times` ×2 polls
- 16:20: `5/11 09:00 → 29/6 OK` ← terminó pasando, pero acumuló 4 polls de desperdicio sin bloqueo.

**Constraint crítico (del codebase):**
- NUNCA mover una cita a fecha igual o posterior — ver `isAtLeastNDaysEarlier` en `poll-visa.ts` y `reschedule-logic.ts`. Cualquier filtrado nuevo debe preservar esta invariante.
- El tracker NO debe bloquear fechas que aún son estrictamente mejores si el tracker tiene bug. Preferir "bloquear de menos" a "bloquear de más" por precaución.

## Constraints

- **Tech stack**: Node.js ESM/TS, Drizzle ORM, Trigger.dev v4 — no introducir dependencias nuevas.
- **Storage**: `dateFailureTracking` vive dentro de `bots.casCacheJson` (jsonb). Sin migraciones SQL.
- **Backwards compat**: `blockedConsularDates` existente no se toca. Bots sin `dateFailureTracking` en su casCacheJson funcionan igual que antes (objeto ausente = sin tracking previo).
- **Performance**: La lectura de `casCacheJson` ya ocurre lazy en poll-visa (line ~865). No añadir queries nuevas por poll — todo el tracking pasa en la misma transacción conceptual.
- **Testing**: Seguir el patrón existente en `src/services/__tests__/reschedule-cas-cache.test.ts`. `npm test` debe pasar antes de deploy.
- **Deploy**: Cambio solo afecta poll-visa + reschedule-logic. Deploy estándar: `npm run deploy:rpi` + `mcp__trigger__deploy environment=prod`.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Migrar + eliminar `dateCooldowns` existente (no coexistir) | El código actual ya implementa ~80% del feature en task payload — lo perdemos cada chain restart. Mejor persistirlo en DB y borrar el paralelo. Colapsa 6→5 capas. | — Pending |
| Nuevo objeto `dateFailureTracking` en `casCacheJson` (no extender `blockedConsularDates`) | Menor riesgo de regresión. Permite shape rica sin tocar el schema existente que se lee/escribe en múltiples sitios. | — Pending |
| Breakdown por dimensión (consular × cas, times × days) | Permite políticas distintas en el futuro sin refactor. Costo marginal ahora (~10 líneas), ganancia alta después. v1 todos suman al mismo totalCount. | — Pending |
| Umbral 5 fails en ventana deslizante de 1h → bloqueo 2h | Ventana temporal evita fails viejos irrelevantes. 2h es 12x más largo que el `dateCooldowns` actual (10min) — suficiente para superar el intervalo de poll y los restarts. | — Pending |
| Reset rule: ventana expira O fecha desaparece O success | Elimina la regla agresiva `dateCooldowns:1704` ("cualquier fecha nueva → reset all") que en la práctica dispara casi cada poll. | — Pending |
| Escape hatch via `prefetch-cas` | Cuando prefetch refresca CAS y encuentra disponibilidad para una fecha bloqueada, limpia su entry. Protege el Core Value ("nunca perder fecha bookeable"). | — Pending |
| Success clears tracker entry | Mirror de `updateDateCooldowns:1699`. Previene bloquear una fecha recién bookeada cuando el portal propaga con lag y la fecha reaparece. | — Pending |
| No contar `post_failed` / `verification_failed` / `session_expired` / `fetch_error` | Ya tienen handling dedicado. Sumarlos contaminaría el signal "fecha no-bookeable sostenida". | — Pending |

---
*Last updated: 2026-04-06 after initialization*

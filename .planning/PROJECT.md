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

<!-- Current milestone: TTL cross-poll para fechas repetidamente fallando. -->

- [ ] **TRACK-01**: Un nuevo objeto `dateFailureTracking` persiste contadores de fallos por fecha, con breakdown por dimensión (consular/cas × noTimes/noDays), sobreviviendo múltiples invocaciones de `executeReschedule`.
- [ ] **TRACK-02**: Los fail reasons `no_times`, `no_cas_days` y `no_cas_times` incrementan el contador correspondiente en `dateFailureTracking`, persistiendo en DB al final de cada poll.
- [ ] **TRACK-03**: Cuando una fecha alcanza 5 fallos totales dentro de una ventana de 1 hora, `blockedUntil` se setea a `now + 2h` y la fecha se filtra de los candidatos en el próximo poll.
- [ ] **TRACK-04**: Cuando una fecha desaparece de `days.json` en un poll, su entry en `dateFailureTracking` se elimina (reset).
- [ ] **TRACK-05**: El bloqueo cross-poll de 2h coexiste con los mecanismos existentes: `falsePositiveDates` 2h, `no_cas_days` TTL 30m, y `repeatedlyFailingDates` per-call 1h. Bloqueos más largos preservados.
- [ ] **TRACK-06**: Tests unitarios que validan (a) el contador cross-call, (b) la lógica de ventana temporal, (c) el reset al desaparecer del portal, (d) la coexistencia con blockings existentes.

### Out of Scope

<!-- Explicit boundaries for this milestone. -->

- **Cambiar `blockedConsularDates` a estructura rica** — decidido mantener `dateFailureTracking` como objeto paralelo dentro de `casCacheJson`, no extender el schema existente (menor riesgo de regresión).
- **Tabla DB nueva** — `dateFailureTracking` vive en `bots.casCacheJson` (jsonb) como los demás trackers. No justifica una migración de schema.
- **Contar `post_failed`/`post_error` / `verification_failed`** — estos ya tienen handling dedicado (falsePositiveDates, slot-specific retry); sumarlos distorsionaría el contador.
- **Políticas distintas por dimensión** (ej. "noDays cuenta más que noTimes") — el breakdown se persiste para habilitar esto en el futuro, pero en v1 todos suman por igual al `totalCount`.
- **Dashboard / métricas del tracker** — fuera de scope. Logs estructurados son suficientes para debugging v1.
- **Backfill histórico de fallos** — el tracker arranca vacío en deploy; fallos anteriores no se recuperan.

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
| Nuevo objeto `dateFailureTracking` en lugar de extender `blockedConsularDates` | Menor riesgo de regresión — `blockedConsularDates` lo lee y escribe código en múltiples sitios. Un objeto nuevo permite shape distinta sin tocar el existente. | — Pending |
| Breakdown por dimensión (consular × cas, times × days) | Permite políticas distintas en el futuro sin refactor. Costo marginal ahora (más campos), ganancia alta después. | — Pending |
| Umbral 5 fails en ventana de 1h → bloqueo 2h | Más tolerante que el per-call (3 sin window). Ventana evita fails viejos irrelevantes. Bloqueo 2x más largo que el per-call porque el signal es más fuerte (confirmado cross-poll). | — Pending |
| Reset cuando fecha desaparece del portal | Mantiene el tracker pequeño (sin bloat de fechas abandonadas). Reinicia la cuenta si la fecha reaparece — tratándola como nueva oportunidad. | — Pending |
| No contar `post_failed` / `verification_failed` | Ya tienen handling dedicado (falsePositiveDates, slot-specific retry). Sumarlos contaminaría la señal "fecha no-bookeable sostenida". | — Pending |

---
*Last updated: 2026-04-06 after initialization*

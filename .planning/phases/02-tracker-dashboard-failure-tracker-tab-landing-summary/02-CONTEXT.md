---
phase: 02-tracker-dashboard-failure-tracker-tab-landing-summary
milestone: Cross-Poll Failure Tracker Migration
depends_on: Phase 01 (cross-poll tracker in production)
status: not-planned
---

# Phase 02 Context — Tracker Dashboard

## Goal

Exponer el `dateFailureTracking` del bot en el dashboard Hono existente:
1. **Landing page** — resumen global: cuántos bots tienen bloqueos activos, lista de fechas bloqueadas por bot.
2. **Bot detail page** — nueva tab "tracker" (tab 5): tabla completa con fechas, contadores por dimensión, tiempo restante del bloqueo, y botón de desbloqueo manual por fecha.

## Design Decisions (from user Q&A 2026-04-07)

| Pregunta | Respuesta |
|----------|-----------|
| Ubicación | Ambas: landing resumen + tab en bot-detail |
| Acciones | Lectura + desbloqueo manual por fecha (botón) |
| Estado vacío | Mensaje simple "sin bloqueos activos" |
| Nombres de dimensiones | Técnicos tal cual (`consularNoTimes`, `casNoDays`, `casNoTimes`) |
| Endpoint backend | Extender existente o crear dedicado — decisión del implementador |

## Existing Dashboard Structure

El dashboard vive en `src/api/dashboard.ts` (~3628 líneas) — HTML/JS vanilla servido por Hono.

**Bot-detail tabs existentes (switchTab):**
- Tab 0: `monitor` — gráfico polls, health, proxy pool
- Tab 1: `cas map` — disponibilidad CAS
- Tab 2: `eventos` — bookable events
- Tab 3: `calendario` — calendar view con detalle por día
- Tab 4: `cobros` — facturación

**Nueva tab:** Tab 5 → `tracker`

**Landing page:** `GET /dashboard/` → `src/api/dashboard.ts:renderLanding()` — tiene cards por bot con stats resumidas.

## Data Shape (what's available)

```typescript
// En bots.casCacheJson.dateFailureTracking (via GET /api/bots/:id → .casCache.dateFailureTracking)
type DateFailureEntry = {
  windowStartedAt: string;      // ISO — inicio de la ventana de 1h
  totalCount: number;           // fallas totales en la ventana
  byDimension: {
    consularNoTimes?: number;   // sin horarios consulares
    consularNoDays?: number;    // sin días consulares (reservado, no se usa aún)
    casNoTimes?: number;        // sin horarios CAS
    casNoDays?: number;         // sin días CAS
  };
  lastFailureAt: string;        // ISO — última falla
  blockedUntil?: string;        // ISO — bloqueo activo hasta esta fecha (solo cuando totalCount >= 5)
};

// El campo completo:
// bot.casCache.dateFailureTracking: Record<string, DateFailureEntry> | null
```

**Bloqueo activo**: `entry.blockedUntil && new Date(entry.blockedUntil) > Date.now()`
**Tiempo restante**: `new Date(entry.blockedUntil) - Date.now()` → formatear como "1h 23m"

## Backend Requirements

### Endpoint para desbloqueo manual
Necesita un endpoint para eliminar o limpiar una entrada del tracker:

**Opción A** (simple): `DELETE /api/bots/:id/tracker/:date`
- Elimina la entrada de `casCacheJson.dateFailureTracking[date]` via `jsonb_set` o `jsonb_delete_path`

**Opción B** (flexible): `POST /api/bots/:id/tracker/clear` con body `{ date?: string }` (sin date = limpiar todo)

El implementador decide según comodidad con el patrón existente en `bots.ts`.

### Endpoint para lectura (landing)
El `GET /api/bots/landing` que usa la landing page devuelve data reducida por bot. Hay que añadir `trackerSummary` a esa respuesta:
```typescript
trackerSummary: {
  blockedCount: number;         // fechas con blockedUntil activo
  totalEntries: number;         // todas las entradas (bloqueadas + en observación)
}
```

O alternativamente, leer `dateFailureTracking` desde `GET /api/bots/:id` al abrir el detalle — ya está disponible ahí.

## UI Spec (lo que debe verse)

### Landing — widget por bot
Cuando `blockedCount > 0`, mostrar un pill/badge debajo del nombre del bot:
```
⊘ 2 fechas bloqueadas
```
Click → ir al bot-detail tab tracker.

Cuando `blockedCount === 0`: no mostrar nada (estado normal).

### Bot-detail Tab 5: "tracker"

**Header**: "Failure Tracker" + descripción corta de qué es.

**Estado vacío** (tracker null o sin entradas):
```
sin bloqueos activos
```

**Tabla cuando hay entradas**:
| Fecha | Total | consularNoTimes | casNoDays | casNoTimes | Última falla | Estado | Acción |
|-------|-------|-----------------|-----------|------------|--------------|--------|--------|
| 2026-05-10 | 5 | 3 | 2 | 0 | hace 23m | 🔴 bloqueada 1h 12m | [desbloquear] |
| 2026-05-15 | 2 | 1 | 1 | 0 | hace 5m | 🟡 en observación | — |

**Columnas**:
- **Fecha**: `YYYY-MM-DD`
- **Total**: `totalCount`
- **consularNoTimes / casNoDays / casNoTimes**: `byDimension.*` (0 si undefined)
- **Última falla**: `timeAgo(lastFailureAt)` — usar el helper existente en el dashboard
- **Estado**: rojo = bloqueada + tiempo restante / amarillo = en observación (no llega a threshold) / gris = ventana casi expirada
- **Acción**: botón `[x]` o `[desbloquear]` solo para entradas bloqueadas

**Botón "limpiar todo"**: en el header de la tabla cuando hay al menos 1 entrada.

## Technical Context — Patterns to follow

El dashboard usa JS vanilla con helpers existentes:
- `timeAgo(isoDate)` — ya existe (línea ~1500)
- `fetchJ(url)` — fetch wrapper ya existe (línea ~1563)
- `fmtD(dateStr)` — ya existe para formatear fechas
- `switchTab(n)` — ya existe para tab switching

Para agregar la tab:
1. Añadir `<div class="tab" onclick="switchTab(5)">tracker</div>` en HTML
2. Añadir `<div id="t5" class="tab-c">` con el HTML de la tabla
3. Añadir `if(n===5) renderTracker()` en `switchTab()`
4. Implementar `renderTracker()` usando `lastBot.casCache.dateFailureTracking`

`lastBot` ya se carga en cada refresh — los datos del tracker estarán disponibles sin fetch adicional.

## Rollout

- No hay DB migrations — solo UI + API endpoint para DELETE
- Sin cambios en el worker (poll-visa / prefetch-cas)
- Deploy: `npm run deploy:rpi` (API) — el worker no cambia

## Success Criteria

- [ ] Landing muestra pill "⊘ N fechas bloqueadas" por bot cuando `blockedCount > 0`
- [ ] Bot-detail tiene tab "tracker" (tab 5) con tabla de entradas
- [ ] Tabla muestra estado correcto: bloqueada (rojo + tiempo restante) vs observación (amarillo)
- [ ] Botón "desbloquear" en entradas bloqueadas hace DELETE y recarga la tabla
- [ ] Estado vacío muestra "sin bloqueos activos" correctamente
- [ ] `npm test` sigue en verde (no hay lógica de negocio nueva — solo UI + thin API endpoint)

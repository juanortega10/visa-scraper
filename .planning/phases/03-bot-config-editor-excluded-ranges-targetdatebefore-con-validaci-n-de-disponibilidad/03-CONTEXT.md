---
phase: 03-bot-config-editor-excluded-ranges-targetdatebefore-con-validaci-n-de-disponibilidad
milestone: Cross-Poll Failure Tracker Migration
depends_on: Phase 02 (dashboard exists, bot-detail page in production)
status: not-planned
---

# Phase 03 Context — Bot Config Editor

## Goal

Desde el dashboard Hono, el operador puede editar `targetDateBefore` y los rangos de exclusión de fechas de cada bot directamente — sin tocar la DB ni la API a mano — con una UX limpia y una validación que garantiza que el bot tiene al menos 1 fecha disponible para reagendar antes de aplicar los cambios.

## Design Decisions (from user Q&A 2026-04-08)

| Pregunta | Respuesta |
|----------|-----------|
| Ubicación | Modal/panel desde botón ⚙ en header del bot-detail |
| Editor de rangos | Mini-calendar visual range picker (vanilla JS) — click start → click end → agrega rango a lista |
| Guardar | Botón "guardar" por campo (targetDateBefore independiente, rangos independiente) |
| Validación | Bloquear save si con los nuevos valores el bot queda sin ningún día disponible para reagendar |

## Backend (already exists — zero new endpoints needed)

El backend ya soporta ambas operaciones:

```
GET  /api/bots/:id          → bot.targetDateBefore, bot.excludedDateRanges[], bot.currentConsularDate
PUT  /api/bots/:id          → body { targetDateBefore?, excludedDateRanges?: [{startDate, endDate}][] }
GET  /api/dev/check-dates/:botId  → devuelve días disponibles (consular + cas) en tiempo real
```

**Para la validación previa al save:**
- `GET /api/dev/check-dates/:botId` devuelve días actuales del portal
- El frontend filtra localmente contra los nuevos valores propuestos
- Si `availableDates.filter(d => d < newTargetDateBefore && !inExcludedRanges(d)).length === 0` → bloquear save con mensaje

## Data shape

```typescript
// En lastBot (ya disponible en el dashboard)
bot.targetDateBefore: string | null    // "YYYY-MM-DD" — solo reagendar a fechas < esta
bot.excludedDateRanges: Array<{
  startDate: string;  // "YYYY-MM-DD"
  endDate: string;    // "YYYY-MM-DD" (inclusive)
}>
bot.currentConsularDate: string | null // "YYYY-MM-DD" — fecha actual del bot

// Para validación: GET /api/dev/check-dates/:botId devuelve
{ dates: string[] }  // o similar — días disponibles del portal para este bot
```

## UX Flow

### Abrir modal
1. Botón ⚙ en el header del bot-detail (junto al nombre/estado)
2. Modal/panel se desliza desde la derecha (o centro) con dos secciones:
   - **Sección A**: `Fecha límite` — campo targetDateBefore con mini date-picker inline
   - **Sección B**: `Fechas excluidas` — lista de rangos existentes + mini-calendar para agregar nuevos

### Editar targetDateBefore
1. Campo muestra valor actual o "sin límite"
2. Click → mini date-picker (input type="date" con estilo consistente)
3. Botón `guardar` bajo el campo → dispara validación → si ok, `PUT /api/bots/:id` → cierra/confirma
4. Botón `limpiar` para quitar el límite (set null)

### Editar rangos excluidos
1. Lista de rangos activos con formato `DD MMM — DD MMM YYYY` + botón `✕` para eliminar cada uno
2. Mini-calendar abajo de la lista para seleccionar rango nuevo:
   - Click en día A → queda marcado como "inicio"
   - Click en día B (> A) → rango A→B se resalta → botón `agregar rango` se activa
   - Click `agregar rango` → añade a la lista (visualmente, no guarda aún)
3. Botón `guardar rangos` → dispara validación → si ok, `PUT /api/bots/:id` con lista completa

### Validación (antes de cualquier save)
```
Días disponibles en portal: GET /api/dev/check-dates/:botId
Aplicar filtros propuestos:
  1. date < newTargetDateBefore  (si targetDateBefore es null → no filtra)
  2. date < currentConsularDate  (siempre — nunca a fecha >= actual)
  3. date NOT IN excluded_ranges (todos los rangos de la lista)
Si resultado === 0 → mostrar error:
  "Sin esta configuración el bot no podría reagendar a ninguna fecha disponible.
   Ajusta los rangos o la fecha límite."
   → Botón guardar bloqueado
Si resultado >= 1 → guardar procede normalmente
```

### Error states
- Red/amber badge si la configuración actual ya deja 0 fechas disponibles (bot misconfigured)
- Toast success/error post-save
- Loading state en el botón mientras fetch + validación

## Technical Context — Patterns to follow

**Modal**: sin librerías — div con `position:fixed`, `z-index:1000`, overlay semitransparente. Cerrar con click en overlay o botón `✕`. Patrón existente en el dashboard si ya hay modales.

**Mini-calendar**: vanilla JS, renderiza una tabla `<table>` con días del mes, navegación mes anterior/siguiente, marcado de rango (start/hover/end/in-range). ~80-120 líneas de JS. Sin libraries.

**Animación**: `transition: transform 0.2s` para el slide del panel — consistente con el estilo monospaced/minimal del dashboard.

**Helpers disponibles** (en dashboard.ts):
- `fmtD(dateStr)` — formatea fecha
- `fetchJ(url)` — fetch wrapper
- `TZ` — objeto timezone Bogota

## Constraints

- Zero nuevas dependencias npm
- HTML/JS vanilla puro en `dashboard.ts`
- Mobile-first: modal ocupa 100% del ancho en pantallas < 540px
- No modificar el schema de DB ni crear nuevas tablas
- `PUT /api/bots/:id` ya hace replace completo de `excludedDateRanges` — el frontend manda la lista completa actualizada

## Success Criteria

- [ ] Botón ⚙ visible en header del bot-detail abre modal correctamente
- [ ] targetDateBefore editable: input date + guardar + limpiar funciona (PUT /api/bots/:id)
- [ ] Rangos: lista con ✕ por rango + mini-calendar range picker funcional
- [ ] Guardar rangos actualiza via PUT y refleja en UI sin reload
- [ ] Validación bloquea save si 0 fechas quedarían disponibles con la nueva config
- [ ] `npm test` verde sin regresiones

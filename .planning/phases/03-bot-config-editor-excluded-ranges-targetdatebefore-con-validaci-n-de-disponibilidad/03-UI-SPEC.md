---
phase: 03
slug: bot-config-editor-excluded-ranges-targetdatebefore-con-validaci-n-de-disponibilidad
status: draft
shadcn_initialized: false
preset: none
created: 2026-04-07
---

# Phase 03 — UI Design Contract

> Visual and interaction contract for the Bot Config Editor modal: `targetDateBefore` date input + excluded date ranges via vanilla JS mini-calendar range picker. All work is inside the existing Hono vanilla HTML/JS dashboard at `src/api/dashboard.ts` — no framework, no components, no new CSS files.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none (vanilla HTML/JS in template literals) |
| Preset | not applicable |
| Component library | none — hand-rolled classes inside `dashboard.ts` |
| Icon library | Unicode glyphs only (`⚙`, `×`, `‹`, `›`, `✕`) — no icon font |
| Font | `'JetBrains Mono', monospace` (already loaded via Google Fonts) |

**Hard constraint:** every new element must reuse existing CSS variables and the existing class vocabulary. Do NOT introduce a new color, a new font size not already in the file, or a new base class. Only net-new CSS allowed: config-modal-scoped classes prefixed `.cfg-` (modal + calendar + range list + save buttons).

---

## Spacing Scale

Net-new spacing values introduced by this phase are multiples of 4 only.

| Token | Value | Usage in config modal |
|-------|-------|----------------------|
| xs | 4px | Calendar day cell padding, gap between nav arrows and month label, gap between range badge and remove button |
| sm | 8px | Section internal gaps, calendar grid gap, range list row padding, button padding horizontal |
| md | 12px | Gap between Section A and Section B, modal body padding horizontal on mobile |
| lg | 16px | Modal body padding, gap above "guardar" buttons, section heading margin-bottom |
| xl | 20px | Modal body padding on wider screens (540px+) |

**Exceptions (inherited, not net-new):**
- The gear button in the header reuses the existing inline icon style at the same `font-size:14px` as surrounding header elements — not a new spacing declaration.
- Toast reuses existing `.toast` positioning (`bottom:16px`) — not new.

**Net-new values introduced by this phase: 4, 8, 12, 16, 20 — all multiples of 4.**

---

## Typography

All sizes match values already used in `dashboard.ts`. No new sizes introduced. **Only two net-new font weights are declared: 400 (regular) and 700 (bold).**

| Role | Size | Weight | Line Height | Source |
|------|------|--------|-------------|--------|
| Modal title ("configuracion") | 13px | 700 | 1.2 | matches `.country-name` sizing |
| Section heading ("fecha limite" / "fechas excluidas") | 11px | 700 | 1.2 | matches `.tr-title` from Phase 2 |
| Section description (muted helper text) | 10px | 400 | 1.5 | matches `.tr-desc` from Phase 2 |
| Date input value / display | 11px | 700 | 1.2 | matches `.appt-val` sizing |
| Calendar month label ("abr 2026") | 11px | 700 | 1.2 | new `.cfg-cal-month` |
| Calendar day of week headers ("lu", "ma", ...) | 8px | 400 | 1 | uppercase, `var(--muted)` |
| Calendar day number | 10px | 400 | 1 | normal day cells |
| Calendar day number (today) | 10px | 700 | 1 | bold highlight |
| Range list item ("15 feb — 04 mar 2026") | 10px | 400 | 1.5 | `var(--bright)` |
| Button labels ("guardar", "limpiar", "agregar rango") | 9px | 700 | 1 | uppercase, matches `.tr-btn` sizing |
| Validation error message | 10px | 400 | 1.5 | `var(--red)` |
| Close button (×) | 16px | 400 | 1 | `var(--muted)`, hover `var(--bright)` |
| Gear button (⚙) | 14px | 400 | 1 | `var(--muted)`, hover `var(--accent)` |

**Net-new font weights introduced by this phase: 400 and 700 (two weights total).**

---

## Color

Reuses the existing CSS variable palette from `dashboard.ts:173-176`. No new colors.

| Role | Value | Usage in config modal |
|------|-------|----------------------|
| Dominant (60%) | `var(--bg)` = `#0C0C0E` | Overlay background (with alpha), modal body fill |
| Secondary (30%) | `var(--surface)` = `#161618` | Modal container background, calendar day cell hover, range list row background |
| Accent (10%) | `var(--accent)` = `#A78BFA` | Gear button hover, calendar range-start/end day fill, calendar in-range day tint, "agregar rango" button |
| Destructive | `var(--red)` = `#F87171` | Remove range (✕) button, validation error text, validation error border |

**Accent (`var(--accent)`) reserved exclusively for:**
1. Gear button hover state
2. Calendar day cells: range-start and range-end fill background
3. Calendar day cells: in-range preview tint
4. "agregar rango" button (accent variant)
5. Nothing else inside the config modal

**Semantic color mapping inside the config modal (fixed contract):**

| Semantic | Variable | Where |
|----------|----------|-------|
| Calendar: today indicator | `var(--bright)` = `#E4E4E9` | Bold day number + subtle bottom border |
| Calendar: range-start / range-end | `var(--accent)` with `background:rgba(167,139,250,.25)` | Selected day cells |
| Calendar: in-range preview (hover) | `var(--accent-dim)` = `rgba(167,139,250,0.08)` | Days between start and hovered end |
| Calendar: in-range confirmed | `var(--accent-dim)` = `rgba(167,139,250,0.08)` | Days between start and confirmed end |
| Calendar: already-excluded days | `var(--dim)` = `#3A3A42` + `text-decoration:line-through` | Days in existing excluded ranges |
| Calendar: disabled (past / beyond targetDateBefore) | `var(--dim)` text, `cursor:not-allowed`, `opacity:0.3` | Non-selectable days |
| Calendar: out-of-month filler | `visibility:hidden` | Empty cells, no visual noise |
| Calendar: day hover (normal) | `var(--surface2)` = `#1C1C1F` | Background on hover for selectable days |
| Range list item | `var(--bright)` text on `var(--surface)` background | Each range row |
| Remove (✕) per range | `var(--red)` text, `var(--red)` background on hover at 10% alpha | Small inline button |
| Save button idle | Same as `.btn-g` (green variant) | "guardar" / "guardar rangos" |
| Save button loading | `opacity:0.5; cursor:wait` | While fetching + validating |
| Save button success | Flash `.toast-ok` then revert | Momentary via toast |
| Clear button ("limpiar") | Same as `.btn-r` (red variant) — transparent red | "limpiar" for targetDateBefore |
| Validation error block | `background:rgba(248,113,113,.08); border:1px solid rgba(248,113,113,.2); color:var(--red)` | Inline message below save button |
| Validation success (dates available) | No visible element — save proceeds | Absence of error = success |
| Overlay | `background:rgba(0,0,0,.7)` | Semi-transparent backdrop, matches `showMsgOverlay` |
| Modal border | `border:1px solid var(--border)` = `rgba(255,255,255,0.06)` | Subtle container edge |

**Forbidden:**
- Do not use `var(--green)` for calendar elements — green is reserved for save button only.
- Do not use `var(--cyan)` / `var(--blue)` — reserved by other tabs for chart and CAS semantics.

---

## Copywriting Contract

All copy is Spanish (matches existing dashboard).

| Element | Copy |
|---------|------|
| Gear button tooltip | `configuracion` |
| Modal title | `configuracion` (lowercase, no accent — matches dashboard style) |
| Section A heading | `fecha limite` |
| Section A description | `Solo reagendar a fechas anteriores a esta. Dejar vacio para sin limite.` |
| Section A current value (when set) | `{YYYY-MM-DD}` raw date |
| Section A current value (when null) | `sin limite` (muted, italic) |
| Section A save button | `guardar` |
| Section A clear button | `limpiar` |
| Section B heading | `fechas excluidas` |
| Section B description | `Rangos de fechas que el bot debe ignorar al reagendar.` |
| Section B range format | `DD MMM — DD MMM YYYY` (e.g. `15 feb — 04 mar 2026`) |
| Section B empty state | `sin rangos excluidos` |
| Section B add button | `agregar rango` |
| Section B save button | `guardar rangos` |
| Section B remove button | `✕` (single glyph, no label; `title="eliminar rango"`) |
| Calendar month label | `{mes} {anio}` (e.g. `abr 2026`, lowercase Spanish month) |
| Calendar day-of-week headers | `lu` `ma` `mi` `ju` `vi` `sa` `do` |
| Calendar nav arrows | `‹` (previous month) / `›` (next month) |
| Validation error — zero dates | `Sin esta configuracion el bot no podria reagendar a ninguna fecha disponible. Ajusta los rangos o la fecha limite.` |
| Validation error — fetch failed | `Error al verificar disponibilidad. Reintenta.` |
| Toast — save success (targetDateBefore) | `Fecha limite guardada` |
| Toast — save success (clear targetDateBefore) | `Fecha limite eliminada` |
| Toast — save success (ranges) | `Rangos guardados` |
| Toast — save failure | `Error al guardar. Reintenta.` |
| Toast — remove range (pending, not saved) | No toast — just visual removal from pending list |
| Close modal label | `×` (close glyph, `title="cerrar"`) |
| Overlay dismiss | Click overlay to close (same as `showMsgOverlay` pattern) |
| Primary CTA (phase-level) | `guardar` — this is THE user action of the phase |

**Destructive action inventory:**

| Action | Confirmation | Method |
|--------|-------------|--------|
| Clear targetDateBefore | `confirm('Quitar la fecha limite? El bot buscara cualquier fecha anterior a la cita actual.')` | `PUT /api/bots/:id` with `{ targetDateBefore: null }` |
| Remove single excluded range | No confirmation — removes from pending list only; requires "guardar rangos" to persist | Visual removal, no API call |
| Save ranges (which may remove ranges) | Validation gate only (no confirm dialog — the "guardar rangos" click IS the explicit intent) | `PUT /api/bots/:id` with full `excludedDateRanges` array |

**Month names (Spanish, lowercase):** `ene`, `feb`, `mar`, `abr`, `may`, `jun`, `jul`, `ago`, `sep`, `oct`, `nov`, `dic`.

**Date formatting helper:** Reuse existing `fmtD()` where available. For range display, format as `DD MMM` using the month abbreviations above. Include year only on the end date or when start and end are in different years.

---

## Interaction Contract

### Gear button (entry point)

- **Placement:** Inside the header row at line ~1075, after `<span class="cursor">_</span>`, as an inline `<span>`.
- **HTML:** `<span id="cfgBtn" class="cfg-gear" onclick="openCfgModal()" title="configuracion">&#x2699;</span>`
- **Style:** `font-size:14px; color:var(--muted); cursor:pointer; margin-left:8px; transition:color .15s`
- **Hover:** `color:var(--accent)`
- **Active:** `opacity:0.6`
- **Visibility:** Always visible on bot-detail page. No conditional display.

### Modal overlay and container

- **Trigger:** `openCfgModal()` called from gear button click.
- **Overlay:** `position:fixed; inset:0; z-index:9998; background:rgba(0,0,0,.7); cursor:pointer` — click overlay to close.
- **Container:** `position:fixed; top:0; right:0; bottom:0; width:380px; max-width:100%; z-index:9999; background:var(--surface); border-left:1px solid var(--border); overflow-y:auto; transform:translateX(100%); transition:transform .2s ease-out` — slide-in from right.
- **Open animation:** Set `transform:translateX(0)` after a 10ms `requestAnimationFrame` to trigger the CSS transition.
- **Close:** Click overlay, click `×` button, or press `Escape` key. Reverse animation: `transform:translateX(100%)`, remove from DOM after transition ends (200ms).
- **Mobile (<540px):** `width:100%` — full-width panel. No `border-left`.
- **Scroll:** Modal body has `overflow-y:auto; -webkit-overflow-scrolling:touch`. Each section scrolls with the panel.
- **Body scroll lock:** Set `document.body.style.overflow='hidden'` on open, restore on close.
- **Z-index relationship:** Overlay 9998, modal container 9999, toast remains 100 (renders above modal via later paint order — toast is already `position:fixed`; but if overlap is an issue, toast z-index is lower — this is acceptable since toast is transient).

### Modal layout (top to bottom)

```
┌─────────────────────────────────────┐
│  configuracion                   ×  │  <- .cfg-hdr
│─────────────────────────────────────│
│                                     │
│  FECHA LIMITE                       │  <- .cfg-section
│  Solo reagendar a fechas...         │
│  ┌─────────────┐                    │
│  │ 2026-05-15  │  [limpiar]        │  <- input + clear btn
│  └─────────────┘                    │
│  [guardar]                          │  <- save btn
│  ┌─ error msg ─────────────────┐   │  <- .cfg-err (if validation fails)
│  │ Sin esta config...          │   │
│  └─────────────────────────────┘   │
│                                     │
│─────────────────────────────────────│  <- 1px border separator
│                                     │
│  FECHAS EXCLUIDAS                   │  <- .cfg-section
│  Rangos de fechas que el bot...     │
│                                     │
│  15 feb — 04 mar 2026         ✕    │  <- .cfg-range-item
│  10 may — 20 may 2026         ✕    │
│  (sin rangos excluidos)             │  <- empty state
│                                     │
│       ‹   abr 2026   ›             │  <- .cfg-cal-nav
│  lu ma mi ju vi sa do              │  <- .cfg-cal-hdr
│  ┌──┬──┬──┬──┬──┬──┬──┐           │
│  │  │  │  │ 1│ 2│ 3│ 4│           │  <- .cfg-cal-grid
│  │ 5│ 6│ 7│ 8│ 9│10│11│           │
│  │12│13│14│15│16│17│18│           │
│  │19│20│21│22│23│24│25│           │
│  │26│27│28│29│30│  │  │           │
│  └──┴──┴──┴──┴──┴──┴──┘           │
│                                     │
│  [agregar rango]                    │  <- disabled until range selected
│  [guardar rangos]                   │  <- save all ranges
│  ┌─ error msg ─────────────────┐   │
│  │ Sin esta config...          │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

### Section A: targetDateBefore

- **Display:** Shows current `bot.targetDateBefore` value or `sin limite` (italic, `var(--muted)`).
- **Input:** `<input type="date" class="cfg-date-input">` — native date picker. Styled to match dashboard (dark background, monospace font, border matches `var(--border)`).
- **On change:** Input value updates in place. "guardar" button becomes active.
- **"limpiar" button:** Always visible when a value is set. Click triggers `confirm()` dialog. On confirm, sets input to empty and immediately saves `targetDateBefore: null` via `PUT /api/bots/:id` (no validation needed — removing a limit can only increase available dates).
- **"guardar" button:** Click triggers validation flow (see Validation section below).
- **Button layout:** `[guardar]` left, `[limpiar]` right, same row, gap 8px.

### Section B: Excluded date ranges

#### Range list
- **Container:** `<div class="cfg-range-list">` — vertical stack.
- **Each range:** `<div class="cfg-range-item">` with `display:flex; align-items:center; justify-content:space-between; padding:8px; background:var(--surface2); border:1px solid var(--border); border-radius:4px; margin-bottom:4px`.
- **Range text:** `<span class="cfg-range-text">15 feb — 04 mar 2026</span>` — `font-size:10px; color:var(--bright)`.
- **Remove button:** `<button class="cfg-range-rm" title="eliminar rango">✕</button>` — `font-size:10px; color:var(--red); background:none; border:none; cursor:pointer; padding:4px`.
- **Remove behavior:** Clicking `✕` removes the range from the in-memory list immediately (no API call). The "guardar rangos" button must be clicked to persist.
- **Pending indicator:** When the list has unsaved changes (added or removed ranges), show a small `*` or muted text `(sin guardar)` next to the "fechas excluidas" heading — `font-size:9px; color:var(--amber)`.
- **Empty state:** `<div class="cfg-range-empty">sin rangos excluidos</div>` — `font-size:10px; color:var(--muted); font-style:italic; padding:8px 0`.

#### Mini-calendar range picker

**Structure:** A single-month grid view rendered as a `<div>` grid (not `<table>` — CSS grid is simpler for this layout).

**Navigation:**
- `<div class="cfg-cal-nav">` with `display:flex; align-items:center; justify-content:center; gap:12px; margin-bottom:8px`.
- `‹` and `›` buttons: `<button class="cfg-cal-arrow">` — `font-size:14px; color:var(--muted); background:none; border:none; cursor:pointer; padding:4px 8px`. Hover: `color:var(--bright)`.
- Month label: `<span class="cfg-cal-month">abr 2026</span>` — `font-size:11px; font-weight:700; color:var(--bright); min-width:80px; text-align:center`.

**Day-of-week headers:**
- `<div class="cfg-cal-hdr">` — 7-column CSS grid.
- Each cell: `font-size:8px; color:var(--muted); text-transform:uppercase; text-align:center; padding:4px 0`.

**Day grid:**
- `<div class="cfg-cal-grid">` — `display:grid; grid-template-columns:repeat(7,1fr); gap:1px`.
- Each day cell: `<div class="cfg-day">` — `width:100%; aspect-ratio:1; display:flex; align-items:center; justify-content:center; font-size:10px; border-radius:4px; cursor:pointer; transition:background .1s`.
- Cell minimum effective size: at 380px modal width minus 32px padding = 348px / 7 columns = ~49px per cell. Touch-friendly without exceptions.

**Day cell states (exhaustive, mutually exclusive visual priority top-to-bottom):**

| State | Class | Background | Text Color | Border | Other |
|-------|-------|-----------|------------|--------|-------|
| Out-of-month | `.cfg-day-out` | none | — | — | `visibility:hidden` |
| Disabled (past date, or date >= currentConsularDate) | `.cfg-day-dis` | none | `var(--dim)` | — | `opacity:0.3; cursor:not-allowed; pointer-events:none` |
| Already excluded (in existing saved range) | `.cfg-day-excl` | none | `var(--dim)` | — | `text-decoration:line-through; cursor:default` (still selectable for new overlapping range — but visually indicates existing coverage) |
| Today | `.cfg-day-today` | none | `var(--bright)` | — | `font-weight:700; border-bottom:2px solid var(--accent)` |
| Normal (selectable) | `.cfg-day` | none | `var(--text)` | — | default |
| Hover (normal) | `.cfg-day:hover` | `var(--surface2)` | `var(--bright)` | — | |
| Range start (selected) | `.cfg-day-start` | `rgba(167,139,250,.25)` | `var(--bright)` | `1px solid var(--accent-border)` | `font-weight:700` |
| Range end (selected) | `.cfg-day-end` | `rgba(167,139,250,.25)` | `var(--bright)` | `1px solid var(--accent-border)` | `font-weight:700` |
| In-range preview (hover phase) | `.cfg-day-preview` | `var(--accent-dim)` | `var(--bright)` | — | Applied to days between start and cursor |
| In-range confirmed | `.cfg-day-inrange` | `var(--accent-dim)` | `var(--bright)` | — | Applied after end is clicked |

**Interaction model (state machine):**

```
State 0: IDLE (no range being selected)
  - Click any selectable day → set rangeStart = day, enter State 1
  - Visual: day gets .cfg-day-start

State 1: START_SELECTED (rangeStart set, awaiting end)
  - Mouseover/touchmove on day >= rangeStart → apply .cfg-day-preview to all days in [rangeStart+1, hoveredDay]
  - Mouseout → remove all .cfg-day-preview
  - Click day >= rangeStart → set rangeEnd = day, enter State 2
  - Click day < rangeStart → reset rangeStart to this day (restart selection)
  - Click same day as rangeStart → single-day range (rangeStart = rangeEnd = day), enter State 2

State 2: RANGE_CONFIRMED (both start and end set)
  - Visual: start gets .cfg-day-start, end gets .cfg-day-end, between gets .cfg-day-inrange
  - "agregar rango" button becomes enabled (was disabled)
  - Click "agregar rango" → add {startDate, endDate} to pending list, reset calendar selection, enter State 0
  - Click any other day → reset selection, set new rangeStart, enter State 1

State transitions on month navigation:
  - If rangeStart is set and user navigates to a different month, rangeStart persists
  - The start day is visually marked only when its month is displayed
  - Range preview works across months (hover on month N while start is on month N-1)
```

**Calendar bounds:**
- Minimum month: current month (no navigating to past months).
- Maximum month: no hard limit, but calendar starts at current month on open.
- If `targetDateBefore` is set, days on or after `targetDateBefore` are disabled (`.cfg-day-dis`).
- Days on or after `currentConsularDate` are always disabled — the bot never reschedules to a later date.

#### "agregar rango" button
- `<button class="cfg-btn cfg-btn-accent" disabled>agregar rango</button>`
- Disabled until State 2 (range confirmed). Enabled: `opacity:1; cursor:pointer`.
- On click: appends range to the in-memory list, clears calendar selection, disables self.

#### "guardar rangos" button
- `<button class="cfg-btn cfg-btn-save">guardar rangos</button>`
- Always visible. Click triggers validation flow.

### Validation flow (shared by both sections)

```
User clicks "guardar" or "guardar rangos"
  → Button enters loading state: text changes to "validando...", disabled, opacity:0.5, cursor:wait
  → fetch GET /api/dev/check-dates/:botId
  → On success: filter response dates:
      1. date < proposed targetDateBefore (if null, skip filter)
      2. date < currentConsularDate (always)
      3. date NOT in any proposed excluded range
  → Count remaining dates
  → If count === 0:
      Show .cfg-err below button with validation error copy
      Button reverts to idle state (re-enabled)
      Do NOT call PUT
  → If count >= 1:
      Hide any existing .cfg-err
      Call PUT /api/bots/:id with updated field(s)
      On PUT success: showToast(success msg, true), update lastBot in memory, re-render section
      On PUT failure: showToast(error msg, false), button reverts to idle
  → On fetch failure (GET check-dates):
      Show .cfg-err with fetch-failed copy
      Button reverts to idle
```

**Validation error block:**
- `<div class="cfg-err" style="display:none">` — hidden by default.
- Show/hide via `style.display`.
- Appears directly below the corresponding save button, with `margin-top:8px`.

### Save button states (per section)

| State | Visual | Behavior |
|-------|--------|----------|
| Idle | Green variant (`.btn-g` pattern): `background:rgba(74,222,128,.1); color:var(--green); border:1px solid rgba(74,222,128,.2)` | Clickable |
| Loading | Same colors + `opacity:0.5; cursor:wait` + text "validando..." | Not clickable (`disabled`) |
| Error (validation blocked) | Reverts to idle; error shown below | Clickable to retry |
| Success | Toast appears, button reverts to idle | Section data refreshed |

### Close behavior

- `×` button: `position:absolute; top:12px; right:12px; font-size:16px; color:var(--muted); cursor:pointer; background:none; border:none; padding:4px`. Hover: `color:var(--bright)`.
- Overlay click: closes modal.
- `Escape` key: `document.addEventListener('keydown', fn)` — attached on open, removed on close.
- Unsaved changes: If the in-memory range list differs from the saved list, show `confirm('Hay cambios sin guardar. Cerrar de todos modos?')` before closing. If targetDateBefore input differs from saved value, same confirm.

### State transitions (modal lifecycle)

| From | Trigger | To |
|------|---------|-----|
| Closed | Click gear button | Open (slide-in, populate from `lastBot`) |
| Open | Click ×, overlay, Escape | Closing (unsaved-changes gate, then slide-out) |
| Open | Save success | Stay open (section refreshes in place) |
| Open | Save failure | Stay open (toast + error shown) |

---

## Visual Layout (ASCII sketch — full modal)

```
┌─── configuracion ─────────── × ─┐
│                                  │
│  FECHA LIMITE                    │
│  Solo reagendar a fechas...      │
│                                  │
│  [====2026-05-15====]            │
│                                  │
│  [guardar]  [limpiar]            │
│                                  │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│                                  │
│  FECHAS EXCLUIDAS  (sin guardar) │
│  Rangos de fechas que el bot...  │
│                                  │
│  15 feb — 04 mar 2026       ✕   │
│  10 may — 20 may 2026       ✕   │
│                                  │
│       ‹   abr 2026   ›          │
│  lu ma mi ju vi sa do           │
│     1  2  3  4  5  6            │
│   7  8  9 10 11 12 13           │
│  14 15 16 17 18 19 20           │
│  21 22 23 24 25 26 27           │
│  28 29 30                        │
│                                  │
│  [agregar rango]                 │
│  [guardar rangos]                │
│                                  │
└──────────────────────────────────┘
```

---

## New CSS Surface (exhaustive)

These are the ONLY new classes allowed. Anything else must reuse existing classes. All padding values are multiples of 4.

```css
/* ── Config modal ── */
.cfg-overlay{position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.7);cursor:pointer}
.cfg-panel{position:fixed;top:0;right:0;bottom:0;width:380px;max-width:100%;z-index:9999;
  background:var(--surface);border-left:1px solid var(--border);overflow-y:auto;
  transform:translateX(100%);transition:transform .2s ease-out;
  -webkit-overflow-scrolling:touch;font-family:inherit}
.cfg-panel.open{transform:translateX(0)}
@media(max-width:540px){.cfg-panel{width:100%;border-left:none}}

.cfg-hdr{display:flex;align-items:center;justify-content:space-between;padding:16px;
  border-bottom:1px solid var(--border)}
.cfg-title{font-size:13px;font-weight:700;color:var(--bright);text-transform:uppercase;letter-spacing:.5px}
.cfg-close{font-size:16px;color:var(--muted);cursor:pointer;background:none;border:none;
  padding:4px;font-family:inherit;transition:color .15s}
.cfg-close:hover{color:var(--bright)}

.cfg-section{padding:16px}
.cfg-section+.cfg-section{border-top:1px solid var(--border)}
.cfg-section-title{font-size:11px;font-weight:700;color:var(--bright);text-transform:uppercase;
  letter-spacing:.5px;margin-bottom:4px}
.cfg-section-desc{font-size:10px;color:var(--muted);line-height:1.5;margin-bottom:12px}
.cfg-unsaved{font-size:9px;color:var(--amber);margin-left:8px;font-weight:400;text-transform:none;letter-spacing:0}

/* ── Date input ── */
.cfg-date-input{font-family:inherit;font-size:11px;font-weight:700;color:var(--bright);
  background:var(--bg);border:1px solid var(--border);border-radius:4px;
  padding:8px;width:100%;box-sizing:border-box;outline:none}
.cfg-date-input:focus{border-color:var(--accent-border)}
.cfg-date-null{font-size:11px;color:var(--muted);font-style:italic;padding:8px 0}

/* ── Buttons ── */
.cfg-btn-row{display:flex;gap:8px;margin-top:12px}
.cfg-btn{font-family:inherit;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;
  padding:8px 16px;border-radius:6px;cursor:pointer;-webkit-tap-highlight-color:transparent;
  transition:opacity .15s;min-height:32px;border:none}
.cfg-btn:active{opacity:.6}
.cfg-btn:disabled{opacity:.3;cursor:not-allowed}
.cfg-btn-save{background:rgba(74,222,128,.1);color:var(--green);border:1px solid rgba(74,222,128,.2)}
.cfg-btn-clear{background:rgba(248,113,113,.1);color:var(--red);border:1px solid rgba(248,113,113,.2)}
.cfg-btn-accent{background:rgba(167,139,250,.1);color:var(--accent);border:1px solid rgba(167,139,250,.2)}
.cfg-btn-loading{opacity:.5;cursor:wait}

/* ── Validation error ── */
.cfg-err{font-size:10px;color:var(--red);line-height:1.5;margin-top:8px;padding:8px;
  background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.2);border-radius:4px}

/* ── Range list ── */
.cfg-range-list{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}
.cfg-range-item{display:flex;align-items:center;justify-content:space-between;padding:8px;
  background:var(--surface2);border:1px solid var(--border);border-radius:4px}
.cfg-range-text{font-size:10px;color:var(--bright)}
.cfg-range-rm{font-size:10px;color:var(--red);background:none;border:none;cursor:pointer;
  padding:4px;font-family:inherit;transition:opacity .15s;flex-shrink:0}
.cfg-range-rm:hover{background:rgba(248,113,113,.1);border-radius:3px}
.cfg-range-empty{font-size:10px;color:var(--muted);font-style:italic;padding:8px 0}

/* ── Calendar ── */
.cfg-cal{margin:12px 0}
.cfg-cal-nav{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:8px}
.cfg-cal-arrow{font-size:14px;color:var(--muted);background:none;border:none;cursor:pointer;
  padding:4px 8px;font-family:inherit;transition:color .15s}
.cfg-cal-arrow:hover{color:var(--bright)}
.cfg-cal-arrow:disabled{opacity:.3;cursor:not-allowed}
.cfg-cal-month{font-size:11px;font-weight:700;color:var(--bright);min-width:80px;text-align:center}
.cfg-cal-hdr{display:grid;grid-template-columns:repeat(7,1fr);text-align:center;
  font-size:8px;color:var(--muted);text-transform:uppercase;padding:4px 0;margin-bottom:4px}
.cfg-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:1px}
.cfg-day{display:flex;align-items:center;justify-content:center;aspect-ratio:1;
  font-size:10px;border-radius:4px;cursor:pointer;transition:background .1s;color:var(--text)}
.cfg-day:hover{background:var(--surface2);color:var(--bright)}
.cfg-day-out{visibility:hidden}
.cfg-day-dis{color:var(--dim);opacity:.3;cursor:not-allowed;pointer-events:none}
.cfg-day-excl{color:var(--dim);text-decoration:line-through;cursor:default}
.cfg-day-today{color:var(--bright);font-weight:700;border-bottom:2px solid var(--accent)}
.cfg-day-start,.cfg-day-end{background:rgba(167,139,250,.25);color:var(--bright);
  border:1px solid var(--accent-border);font-weight:700}
.cfg-day-preview,.cfg-day-inrange{background:var(--accent-dim);color:var(--bright)}

/* ── Gear button ── */
.cfg-gear{font-size:14px;color:var(--muted);cursor:pointer;margin-left:8px;
  transition:color .15s;-webkit-tap-highlight-color:transparent}
.cfg-gear:hover{color:var(--accent)}
.cfg-gear:active{opacity:.6}
```

Everything else — `.toast`, `.toast-ok`, `.toast-err`, `showToast()`, `fetchJ()`, `fmtD()`, `escH()`, `confirm()`, `.btn`, `.btn-g`, `.btn-r` — is **reused as-is**. The planner must NOT modify these.

---

## API Contract (UI-observable only)

| Endpoint | Method | Request Body | Response | Purpose |
|----------|--------|-------------|----------|---------|
| `GET /api/bots/:id` | GET | — | `{ ...bot, targetDateBefore, excludedDateRanges, currentConsularDate }` | Source data for modal. Already exists. |
| `PUT /api/bots/:id` | PUT | `{ targetDateBefore?: string \| null }` | `200 { ok: true }` | Save targetDateBefore. Already exists. |
| `PUT /api/bots/:id` | PUT | `{ excludedDateRanges?: Array<{startDate:string, endDate:string}> }` | `200 { ok: true }` | Save ranges (full replace). Already exists. |
| `GET /api/dev/check-dates/:botId` | GET | — | `{ dates: string[] }` or similar | Pre-save validation. Already exists. |

No new backend endpoints. Zero API changes.

---

## Accessibility & Mobile

- Dashboard max-width is 540px (mobile-first). Modal panel at 380px fits comfortably; at <540px goes full-width.
- Calendar day cells have `aspect-ratio:1` on a 7-column grid within ~348px effective width = ~49px per cell — exceeds the 44px WCAG touch target.
- Native `<input type="date">` is keyboard-accessible and screen-reader friendly by default.
- `Escape` key closes modal — standard keyboard pattern.
- Confirm dialogs use native `confirm()` — keyboard-accessible by default.
- Range selection feedback is not color-only: start/end days have a visible border + bold weight in addition to the accent background.
- Already-excluded days use `line-through` text decoration in addition to color dimming.
- Buttons have `min-height:32px` — below 44px WCAG but consistent with the dense ops dashboard. This is an internal ops tool, not public-facing — acknowledged, not fixed in this phase.
- Focus outline: native browser focus ring is preserved (no `outline:none` on buttons or interactive elements except the date input which has a `border-color` focus state).

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none — no component library | not applicable |
| Third-party | none | not applicable |

No external code enters the bundle. All CSS and JS is authored directly inside `src/api/dashboard.ts`. No new `npm` dependencies.

---

## Pre-Population Audit

| Source | Decisions pulled |
|--------|------------------|
| `03-CONTEXT.md` section Design Decisions | Modal via gear button in header, mini-calendar range picker (vanilla JS), per-section save, validation via check-dates endpoint |
| `03-CONTEXT.md` section UX Flow | targetDateBefore input/save/clear, range list with remove, calendar click-start/click-end, "agregar rango" then "guardar rangos", validation logic (filter available dates, block if 0) |
| `03-CONTEXT.md` section Technical Context | No libraries, div with position:fixed, z-index:1000, overlay, transition:transform 0.2s, fmtD/fetchJ/TZ helpers |
| `03-CONTEXT.md` section Constraints | Zero npm deps, vanilla JS in dashboard.ts, mobile 100% width < 540px, PUT replaces full excludedDateRanges |
| `02-UI-SPEC.md` | CSS variable palette, `.tr-` prefix pattern (→ `.cfg-` prefix), font sizes, weights, `.btn` class variants, toast system, spacing scale, typography table format, `.ev-pill`/`.ev-err` patterns |
| `src/api/dashboard.ts:172-176` | Full color palette (CSS variables) |
| `src/api/dashboard.ts:772-781` | `.btn` class, `.btn-g`, `.btn-r` button variant patterns |
| `src/api/dashboard.ts:800-806` | Toast system (`.toast`, `.toast-ok`, `.toast-err`, `showToast()`) |
| `src/api/dashboard.ts:1072-1077` | Header structure for gear button placement |
| `src/api/dashboard.ts:2581-2596` | `showMsgOverlay()` — existing overlay pattern (z-index:9999, rgba(0,0,0,.7)) |
| `src/api/dashboard.ts:1657` | `fetchJ()` helper signature |
| `ROADMAP.md` Phase 3 | Goals and success criteria |
| `critical_context` block | Mini-calendar interaction model, day cell states, modal animation, mobile breakpoint |
| User input (this session) | None — all answers present in upstream artifacts |

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending

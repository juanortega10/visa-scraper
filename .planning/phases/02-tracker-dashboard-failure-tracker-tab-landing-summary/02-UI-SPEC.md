---
phase: 02
slug: tracker-dashboard-failure-tracker-tab-landing-summary
status: draft
shadcn_initialized: false
preset: none
created: 2026-04-07
---

# Phase 02 — UI Design Contract

> Visual and interaction contract for the Tracker Dashboard phase (failure tracker tab + landing summary). All work is inside the existing Hono vanilla HTML/JS dashboard at `src/api/dashboard.ts` — no framework, no components, no new CSS files.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none (vanilla HTML/JS in template literals) |
| Preset | not applicable |
| Component library | none — hand-rolled classes inside `dashboard.ts` |
| Icon library | Unicode glyphs only (`⊘`, `●`, `×`, `▸`, `▾`) — no icon font |
| Font | `'JetBrains Mono', monospace` (already loaded via Google Fonts) |

**Hard constraint:** every new element must reuse existing CSS variables and the existing class vocabulary. Do NOT introduce a new color, a new font size not already in the file, or a new base class. Only net-new CSS allowed: tracker-scoped classes prefixed `.tr-` (tab pane + rows + badges).

---

## Spacing Scale

Matches the existing dashboard scale (all multiples of 2, dominated by 4/6/8 due to the dense monospace layout).

| Token | Value | Usage in tracker |
|-------|-------|------------------|
| xs | 4px | Cell padding (`td`/`th` already 4px 3px), gap between dimension counters |
| sm | 6px | Row gap inside tracker entries, `.tr-row` vertical padding bottom |
| md | 8px | Gap between table rows, margin below table header, tab pane top padding |
| lg | 12px | Section break between "limpiar todo" header and table |
| xl | 16px | Empty state vertical padding |

**Exceptions:**
- The landing pill reuses `.ev-pill` geometry (`padding:1px 6px; font-size:9px`) — do not resize.
- Unblock button min-height is 24px (smaller than the 38px `.btn` used elsewhere) because it lives inside a table row. Use a new compact class `.tr-btn` — do not alter `.btn`.

---

## Typography

All sizes match values already used in `dashboard.ts`. No new sizes introduced.

| Role | Size | Weight | Line Height | Source class(es) |
|------|------|--------|-------------|------------------|
| Tab label ("tracker") | 10px | 700 | 1 | `.tab` (existing) |
| Table header (TH) | 9px uppercase | 400 | 1.2 | `th` (existing) |
| Table cell (TD) | 11px | 400/700 | 1.2 | `td` (existing) |
| Date column value | 11px | 700 | 1.2 | `color:var(--bright)` |
| Dimension counter (number) | 11px | 700 | 1.2 | `color:var(--muted)` when 0, `color:var(--bright)` when >0 |
| Relative timestamp | 10px | 400 | 1.2 | `color:var(--muted)` (matches `.rs-meta`) |
| Status badge | 9px uppercase | 700 | 1 | `.b` pattern (existing) |
| Unblock button | 9px uppercase | 700 | 1 | new `.tr-btn` class (matches `.fh-rs` sizing) |
| Empty state ("sin bloqueos activos") | 13px | 400 | 1.5 | `.empty-msg` (existing) |
| Landing pill ("⊘ N fechas bloqueadas") | 9px | 600 | 1 | `.ev-pill` shape, new `.ev-block` color variant |
| Section description under tab header | 10px | 400 | 1.5 | `color:var(--muted)` |

**Rule:** Numeric cells (Total, dimensions) are right-aligned monospace — visually obvious since the whole dashboard is monospace; use `text-align:right` on those `<td>` only.

---

## Color

Reuses the existing CSS variable palette from `dashboard.ts:173-176`. No new colors.

| Role | Value | Usage in tracker |
|------|-------|------------------|
| Dominant (60%) | `var(--bg)` = `#0C0C0E` | Tab pane background, page background |
| Secondary (30%) | `var(--surface)` = `#161618` | Table rows, empty-state card backing |
| Accent (10%) | `var(--accent)` = `#A78BFA` | Tab label when active only |
| Destructive | `var(--red)` = `#F87171` | Blocked state badge, unblock button border/text |

**Accent (`var(--accent)`) reserved exclusively for:**
1. The "tracker" tab label when `.on`
2. Nothing else inside the tracker tab pane

**Semantic color mapping inside the tracker tab (fixed contract — the checker must see these exact mappings):**

| Semantic | Variable | Where |
|----------|----------|-------|
| Bloqueada (cooldown active) | `var(--red)` | Status badge background `rgba(248,113,113,.1)`, badge text, glyph `●` |
| En observación (count < 5, window alive) | `var(--amber)` = `#FCD34D` | Status badge background `rgba(252,211,77,.1)`, badge text |
| Ventana casi expirada (lastFailureAt > 50min old) | `var(--dim)` = `#3A3A42` | Status badge text only, no background tint |
| Última falla timestamp | `var(--muted)` = `#5A5A65` | Plain relative text |
| Dimension counter = 0 | `var(--dim)` | De-emphasized so the row reads at a glance |
| Dimension counter > 0 | `var(--bright)` = `#E4E4E9` | Draws the eye to which dimension is failing |
| Total counter | `var(--bright)` (always) | Primary metric of the row |
| Table header labels | `var(--muted)` | Standard dashboard convention |
| Fecha column | `var(--bright)` | Primary identifier |

**Landing pill color contract:**
- `⊘ N fechas bloqueadas` uses `background:rgba(248,113,113,.1); color:var(--red); border:1px solid rgba(248,113,113,.2)` — this is exactly `.ev-err` reused. Do not create `.ev-block` unless `.ev-err` cannot be reused for semantic reasons. **Decision: reuse `.ev-err`** — the semantics (red = bad) are consistent enough, and this keeps the CSS footprint at zero for the landing change.

**Forbidden:**
- Do not use `var(--green)` in the tracker tab — the feature is about failures, there is no positive state to surface.
- Do not use `var(--cyan)` / `var(--blue)` — reserved by other tabs for chart and CAS semantics.

---

## Copywriting Contract

All copy is Spanish (matches existing dashboard — e.g. "eventos", "calendario", "cobros", "sin bloqueos activos").

| Element | Copy |
|---------|------|
| Tab label | `tracker` (lowercase, matches other tabs) |
| Tab pane heading | `Failure Tracker` |
| Tab pane description (muted line under heading) | `Fechas bloqueadas por fallas repetidas en la ventana de 1h. El bot evita estas fechas hasta que el cooldown expire o CAS vuelva a estar disponible.` |
| Table column headers | `fecha` / `total` / `consularNoTimes` / `casNoDays` / `casNoTimes` / `última falla` / `estado` / `acción` |
| Status badge — blocked | `● bloqueada {1h 23m}` (red) — the `{duration}` is time remaining until `blockedUntil` |
| Status badge — observation | `● observación` (amber) |
| Status badge — fading | `● expirando` (dim) — shown when `lastFailureAt` is older than 50min and not blocked |
| Unblock button (per row, blocked entries only) | `desbloquear` |
| Clear-all button (table header, shown when ≥1 entry) | `limpiar todo` |
| Empty state heading | `sin bloqueos activos` |
| Empty state body | `El bot no tiene fechas en cooldown. Las entradas aparecen cuando una fecha falla 5 veces en 1h.` |
| Landing pill | `⊘ {N} fechas bloqueadas` (singular: `⊘ 1 fecha bloqueada`) |
| Primary CTA (phase-level) | `desbloquear` — this is THE user action of the phase |
| Toast — unblock success | `Fecha desbloqueada` |
| Toast — unblock failure | `Error: no se pudo desbloquear. Reintenta.` |
| Toast — clear-all success | `Tracker limpiado` |
| Toast — clear-all failure | `Error: no se pudo limpiar el tracker.` |
| Confirm dialog — clear all | `¿Limpiar TODAS las entradas del tracker? El bot volverá a probar todas las fechas en el próximo poll.` |
| Confirm dialog — unblock single | `¿Desbloquear {YYYY-MM-DD}? El bot volverá a intentar esta fecha en el próximo poll.` |

**Destructive action inventory:**

| Action | Confirmation | Method |
|--------|-------------|--------|
| Unblock single date | `confirm()` native dialog with date interpolated | `DELETE /api/bots/:id/tracker/:date` |
| Clear entire tracker | `confirm()` native dialog, capitalized "TODAS" for emphasis | `DELETE /api/bots/:id/tracker` (or `POST .../tracker/clear` — planner decides) |

**Duration formatting:** Use existing `fmtDur(ms)` helper (line ~3140) for time remaining. Output matches: `<60s → Ns`, `<60min → Nmin`, `≥60min → NhMm`. Sample outputs: `45min`, `1h 12m`, `23s`.

**Relative time:** Use existing `timeAgo(iso)` helper (line ~336). Output: `Nm`, `Nh`, `Nd`.

**Date display:** Raw `YYYY-MM-DD` in the "fecha" column. Do NOT use `fmtD()` — operators need to copy/paste the exact key.

---

## Interaction Contract

### Landing page
- **Trigger:** `trackerSummary.blockedCount > 0` on a bot card.
- **Placement:** Inside `.bot-events` container (same row as other `ev-pill` elements), last position.
- **Class:** `<span class="ev-pill ev-err">⊘ N fechas bloqueadas</span>` (reuses existing class).
- **Click:** The entire `.bot-card` is already an `<a href="/dashboard/bot/:id">` — the pill inherits the navigation. Do NOT add a separate handler. The user lands on the monitor tab (tab 0); they manually click "tracker" to drill in. Rationale: adding a deep-link `?tab=5` requires touching `switchTab()` to read query params — scope creep.
- **Singular vs plural:** `1 fecha bloqueada` / `N fechas bloqueadas`.
- **Hide condition:** `blockedCount === 0` or `trackerSummary == null`.

### Tab 5 "tracker"
- **Activation:** `switchTab(5)` must call a new `renderTracker()` function, following the pattern of existing tabs (e.g. `if(n===5) renderTracker()`).
- **Data source:** `lastBot.casCache.dateFailureTracking` — no extra fetch. The existing 30s refresh cycle picks up changes automatically.
- **Render order:** Sort entries by `blockedUntil DESC` (blocked first), then `totalCount DESC`, then `fecha ASC`.
- **Empty state:** If `lastBot.casCache?.dateFailureTracking == null` OR `Object.keys(tracking).length === 0`, show only the `.empty-msg` block — no table, no clear-all button.
- **Row hover:** Reuse `.fh-row:hover` pattern — subtle `border-color:var(--accent-border); background:var(--accent-dim)` is NOT applied (the row is not clickable; only the button is).
- **Unblock button state:** Only rendered for rows where `entry.blockedUntil && new Date(entry.blockedUntil) > Date.now()`. For non-blocked rows, the "acción" cell contains `—` (em dash, `var(--dim)`).
- **Unblock button flow:** `click → confirm() → fetchJ(DELETE) → toast → renderTracker()` (re-render from `lastBot` after also refetching via `loadBot()`). On failure: red toast, no optimistic removal.
- **Clear-all button:** Positioned at the top-right of the table header row, small, `.tr-btn` styled, red variant. Only shown when at least one entry exists.
- **Auto-refresh:** Piggyback on the existing bot-detail refresh cycle (already in place) — no new setInterval.

### State transitions
| From | Trigger | To |
|------|---------|-----|
| empty | first failure reaches tracker | table with 1 observation row |
| observation | totalCount reaches 5 | blocked row (red badge + countdown) |
| blocked | `blockedUntil` passes OR user clicks desbloquear | removed from table |
| blocked | user clicks limpiar todo | table → empty state |

---

## Visual Layout (ASCII sketch)

```
┌─ Failure Tracker ───────────────────────────┐
│ Fechas bloqueadas por fallas repetidas...   │
│                                              │
│                              [limpiar todo] │
│ fecha       tot  cnt cd  ct  última  estado │
│ 2026-05-10   5    3  2   0   23m    ●bloq… │
│                                     [desbl] │
│ 2026-05-15   2    1  1   0    5m    ●obs   │
│                                         —   │
└──────────────────────────────────────────────┘
```
(Column names abbreviated in sketch; real headers use full technical names.)

---

## New CSS Surface (exhaustive)

These are the ONLY new classes allowed. Anything else must reuse existing classes.

```css
/* ── Tracker tab ── */
.tr-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px}
.tr-title{font-size:11px;font-weight:700;color:var(--bright);text-transform:uppercase;letter-spacing:.5px}
.tr-desc{font-size:10px;color:var(--muted);line-height:1.5;margin-bottom:12px}
.tr-tbl{width:100%;border-collapse:collapse;font-size:11px}
.tr-tbl th{text-align:left;color:var(--muted);font-weight:400;font-size:9px;text-transform:uppercase;letter-spacing:.5px;padding:4px 3px;border-bottom:1px solid var(--border)}
.tr-tbl td{padding:6px 3px;border-bottom:1px solid var(--border);white-space:nowrap;vertical-align:middle}
.tr-tbl .num{text-align:right;font-weight:700}
.tr-tbl .num-0{color:var(--dim);font-weight:400}
.tr-tbl .num-pos{color:var(--bright)}
.tr-date{color:var(--bright);font-weight:700}
.tr-ago{color:var(--muted);font-size:10px}
.tr-badge{font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap}
.tr-badge-block{background:rgba(248,113,113,.1);color:var(--red);border:1px solid rgba(248,113,113,.2)}
.tr-badge-obs{background:rgba(252,211,77,.1);color:var(--amber);border:1px solid rgba(252,211,77,.2)}
.tr-badge-fade{color:var(--dim);border:1px solid var(--border)}
.tr-btn{font-family:inherit;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;
  padding:3px 8px;border-radius:3px;cursor:pointer;-webkit-tap-highlight-color:transparent;
  background:rgba(248,113,113,.08);color:var(--red);border:1px solid rgba(248,113,113,.2);min-height:24px}
.tr-btn:active{opacity:.6}
.tr-btn:disabled{opacity:.3;cursor:not-allowed}
.tr-none{color:var(--dim);text-align:center}
```

Everything else — `.empty-msg`, `.tabs`, `.tab`, `.tab-c`, `.ev-pill`, `.ev-err`, `fmtDur()`, `timeAgo()`, `fetchJ()`, `switchTab()` — is **reused as-is**. The planner must NOT modify these.

---

## API Contract (UI-observable only)

| Endpoint | Shape | Purpose |
|----------|-------|---------|
| `GET /api/bots/:id` | `.casCache.dateFailureTracking: Record<string, DateFailureEntry> \| null` | Source of truth for tab 5. Already exists in Phase 1. |
| `GET /api/bots/landing` (or whatever powers the landing cards) | add `trackerSummary: { blockedCount: number; totalEntries: number }` per bot | Drives the landing pill. |
| `DELETE /api/bots/:id/tracker/:date` | `200 { ok: true }` / `404 { error }` | Unblock single date. |
| `DELETE /api/bots/:id/tracker` | `200 { ok: true, cleared: number }` | Clear all entries. |

Planner decides whether `DELETE /api/bots/:id/tracker` or `POST /api/bots/:id/tracker/clear` is cleaner — the UI only calls `fetchJ(url, {method:'DELETE'})` or equivalent. The copy ("limpiar todo") is agnostic.

---

## Accessibility & Mobile

- Dashboard max-width is 540px (mobile-first). Tracker table must fit: 8 columns at `font-size:11px` in monospace is ~48 characters — tight but viable. If it overflows, wrap the table in `<div style="overflow-x:auto">` — NO column hiding, operators need all dimensions visible.
- Buttons have `min-height:24px` — below the 44px WCAG touch target, but consistent with the rest of the dense ops dashboard (e.g. `.fh-rs`, `.ev-pill`). This is an internal ops tool, not public-facing — the constraint is acknowledged, not fixed in this phase.
- Confirm dialogs use native `confirm()` — keyboard-accessible by default.
- Color semantics must not be the only signal: the badge glyph `●` + text label (`bloqueada`/`observación`/`expirando`) ensures colorblind operators can still read state.

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
| `CONTEXT.md` § Design Decisions | Landing pill + tab 5 placement, read+unblock actions, empty state copy, technical dimension names, button-per-date action, table columns |
| `CONTEXT.md` § UI Spec | Exact column layout, state color (red/amber/gray), "limpiar todo" header button, reuse of existing helpers (`timeAgo`, `fmtD`, `fetchJ`, `switchTab`), Tab index 5 |
| `CONTEXT.md` § Data Shape | `DateFailureEntry` structure, "blocked" predicate, "tiempo restante" calculation |
| `CONTEXT.md` § Technical Context | Vanilla JS in template literals, no component library, `lastBot.casCache.dateFailureTracking` available without extra fetch |
| `src/api/dashboard.ts:173-176` | Full color palette (CSS variables) |
| `src/api/dashboard.ts:708-740` | Tab system, badge system, table styles |
| `src/api/dashboard.ts:317,336,3140` | `fmtD`, `timeAgo`, `fmtDur` helper signatures |
| `src/api/dashboard.ts:1172-1181` | Existing tab markup pattern — template for tab 5 |
| `REQUIREMENTS.md` (Phase 2 success criteria via ROADMAP) | Landing shows blocked summary, tab shows table with correct state, unblock reloads table, empty state correct |
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

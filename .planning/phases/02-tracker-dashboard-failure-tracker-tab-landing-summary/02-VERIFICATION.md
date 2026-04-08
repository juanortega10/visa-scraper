---
phase: 02-tracker-dashboard-failure-tracker-tab-landing-summary
verified: 2026-04-08T10:07:00Z
status: passed
score: 5/5 must-haves verified
re_verification: false
---

# Phase 2: Tracker Dashboard Verification Report

**Phase Goal:** Expose `dateFailureTracking` from the cross-poll failure tracker (Phase 1) in the Hono dashboard — bot-detail tab 5 with full table + manual unblock, and landing-page pill showing blocked date count.
**Verified:** 2026-04-08T10:07:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `GET /api/bots/:id` exposes `casCache.dateFailureTracking` | VERIFIED | `bots.ts:921` — `dateFailureTracking: cache.dateFailureTracking ?? null` inside casCache IIFE |
| 2 | `GET /api/bots/landing` includes `trackerSummary` per bot | VERIFIED | `bots.ts:322-338` — `botsWithOrig` computes `blockedCount` + `totalEntries` from `casCacheJson.dateFailureTracking` and returns `trackerSummary: { blockedCount, totalEntries }` |
| 3 | `DELETE /api/bots/:id/tracker/:date` removes one entry | VERIFIED | `bots.ts:780-798` — uses `jsonb_set(... - ${date})` to remove single key; 404 on unknown date |
| 4 | `DELETE /api/bots/:id/tracker` clears all entries | VERIFIED | `bots.ts:801-817` — uses `jsonb_set(... '{}'::jsonb)` to wipe tracking; returns `{ ok, cleared }` |
| 5 | Bot-detail page has tab 5 "tracker" with `renderTracker()` wired to `switchTab(5)` | VERIFIED | `dashboard.ts:1029` tab button; `dashboard.ts:1218` `id="t5"` pane; `dashboard.ts:1349` `if(n===5) renderTracker()`; `dashboard.ts:1352` `function renderTracker()` |
| 6 | Landing page shows `⊘ N fechas bloqueadas` pill when `blockedCount > 0` | VERIFIED | `dashboard.ts:431-434` — conditional `if(b.trackerSummary&&b.trackerSummary.blockedCount>0)` renders `ev-pill ev-err` with `\u2298` glyph and correct singular/plural |

**Score:** 6/6 truths verified (5 from spec + singular/plural pill)

---

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `src/api/bots.ts` | VERIFIED | Contains `dateFailureTracking` (line 921), `trackerSummary` (line 336), DELETE routes at lines 780 and 801 |
| `src/api/bots-me.test.ts` | VERIFIED | `describe('tracker endpoints')` block at line 394; 26 tests all passing |
| `src/api/dashboard.ts` | VERIFIED | `renderTracker()` (line 1352), `function unblockTrackerDate()` (line 1409), `function clearTracker()` (line 1419), tab button (line 1029), pane `#t5` (line 1218), landing pill (line 431-434) |

---

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| `bots.ts GET /:id casCache builder` | `cache.dateFailureTracking` | `dateFailureTracking: cache.dateFailureTracking ?? null` at line 921 | WIRED |
| `bots.ts GET /landing aggregator` | `bots.casCacheJson.dateFailureTracking` | `casCacheJson: bots.casCacheJson` selected (line 242); `trackerSummary` computed in `botsWithOrig.map()` (lines 323-337) | WIRED |
| `bots.ts DELETE /:id/tracker[/:date]` | `bots.casCacheJson` | `jsonb_set` via `sql` template literal (lines 790-793, 809-813) | WIRED |
| `switchTab(5) in dashboard.ts` | `renderTracker()` | `if(n===5) renderTracker()` at line 1349 | WIRED |
| `renderTracker()` | `lastBot.casCache.dateFailureTracking` | `var tracking=(lastBot&&lastBot.casCache&&lastBot.casCache.dateFailureTracking)||null` at line 1356 | WIRED |
| Tracker action buttons | `DELETE /api/bots/:id/tracker[/:date]` | `fetch('/api/bots/'+lastBot.id+'/tracker/'+date, {method:'DELETE'})` (line 1412) and `fetch('/api/bots/'+lastBot.id+'/tracker', {method:'DELETE'})` (line 1422) | WIRED |
| Landing `renderLanding()` | `b.trackerSummary.blockedCount` | `if(b.trackerSummary&&b.trackerSummary.blockedCount>0)` at line 431 | WIRED |

---

### Test Coverage

| Requirement | Tests | Status |
|-------------|-------|--------|
| DASH-API-01: GET /:id exposes dateFailureTracking | 2 tests (present + null case) | SATISFIED |
| DASH-API-02: GET /landing includes trackerSummary | 2 tests (with entries + null cache) | SATISFIED |
| DASH-API-03: DELETE /:id/tracker/:date removes entry | 2 tests (success + 404 unknown date) | SATISFIED |
| DASH-API-04: DELETE /:id/tracker clears all | 2 tests (success + 404 unknown bot) | SATISFIED |
| DASH-UI-01 to 05: Tab 5 tracker UI | No automated tests (UI-only; human verification required per plan) | N/A — by design |
| DASH-LANDING-01: Landing pill | No automated tests (UI-only) | N/A — by design |

**Full test suite: 206 tests, all passing. No regressions.**

---

### Route Ordering

The DELETE tracker routes are registered at lines 780 and 801, before the generic `DELETE /:id` at line 1175. This ensures Hono correctly routes `/tracker` and `/tracker/:date` paths before matching the catchall `/:id` pattern.

---

### Anti-Patterns Found

None. No TODOs, placeholders, empty returns, or stub handlers found in the modified files.

---

### Human Verification Required

The following items were designated as human-only checkpoints in the plans and cannot be verified programmatically:

**1. Bot-detail Tracker Tab Visual Rendering**
- **Test:** Run `npm run dev`, open `/dashboard/bot/6`, click "tracker" tab.
- **Expected:** Empty state "sin bloqueos activos" when no tracker data; table with correct columns and badge colors when seeded.
- **Why human:** DOM rendering, CSS badge colors (red/amber), font sizes, and sorting order require visual inspection.

**2. Desbloquear + Limpiar Todo Round-Trip**
- **Test:** Seed a blocked entry via psql, click "desbloquear", confirm dialog appears, accept — toast "Fecha desbloqueada" appears, table re-renders.
- **Expected:** Entry disappears; "limpiar todo" then clears all; DB confirms `dateFailureTracking: {}`.
- **Why human:** `confirm()` dialogs, toast behavior, and live API round-trips require browser interaction.

**3. Landing Pill Display**
- **Test:** Open `/dashboard/` with a seeded blocked entry on bot 6.
- **Expected:** Red pill `⊘ 1 fecha bloqueada` appears in the bot-events row; disappears when entries cleared.
- **Why human:** Visual pill placement, color, and singular/plural rendering require browser inspection.

---

## Summary

All five phase goals are achieved and wired end-to-end:

1. **API exposes dateFailureTracking** — `GET /api/bots/:id` returns `casCache.dateFailureTracking` (object or null). Verified at `bots.ts:921`.

2. **API exposes trackerSummary** — `GET /api/bots/landing` returns `trackerSummary: { blockedCount, totalEntries }` per bot. `casCacheJson` is selected in the query and stripped from the wire response. Verified at `bots.ts:242, 323-338`.

3. **DELETE endpoints exist and are wired** — Both `DELETE /:id/tracker/:date` (single-key remove via jsonb `-` operator) and `DELETE /:id/tracker` (clear-all via `'{}'::jsonb`) are registered before the generic `/:id` route and use correct `jsonb_set` patterns. Verified at `bots.ts:780-817`.

4. **Dashboard tab 5 "tracker" with renderTracker()** — Tab button, pane `#t5`, `switchTab(5)` branch, and the complete `renderTracker()` function (table render, empty state, badge logic, sorting) all present. `unblockTrackerDate()` and `clearTracker()` call the correct DELETE endpoints. Verified at `dashboard.ts:1029, 1218, 1349, 1352, 1409, 1419`.

5. **Landing pill** — `renderLanding()` renders `⊘ N fechas bloqueadas` (singular: `fecha`, plural: `fechas`) using `.ev-pill.ev-err` CSS classes when `trackerSummary.blockedCount > 0`. Verified at `dashboard.ts:431-434`.

---

_Verified: 2026-04-08T10:07:00Z_
_Verifier: Claude (gsd-verifier)_

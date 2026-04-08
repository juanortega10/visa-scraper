---
phase: 03-bot-config-editor-excluded-ranges-targetdatebefore-con-validaci-n-de-disponibilidad
verified: 2026-04-08T22:10:00Z
status: human_needed
score: 14/14 must-haves verified
re_verification: false
human_verification:
  - test: "Modal visual and interaction flow"
    expected: "Gear icon visible in bot-detail header; clicking it opens slide-in panel from right; overlay click, X button, and Escape all close the panel; unsaved-changes confirmation dialog appears when closing with pending changes"
    why_human: "CSS animation, z-index stacking, and DOM interaction cannot be verified programmatically"
  - test: "targetDateBefore section UX"
    expected: "Bot with targetDateBefore shows the date in a date input with guardar + limpiar buttons. Bot with null shows 'sin limite' text and an 'establecer fecha limite' link that reveals the input. Clicking guardar calls available-dates, filters, and either saves (toast 'Fecha limite guardada') or shows the validation error. Clicking limpiar shows confirm dialog then clears."
    why_human: "Sequential DOM state transitions and toast rendering require visual inspection"
  - test: "Excluded ranges mini-calendar range picker"
    expected: "Section B shows current ranges with x remove buttons. Clicking a calendar day sets the start (highlighted), clicking a second day confirms the range (highlighted between). Hover preview shows between start and hovered day. 'agregar rango' button enables only in state 2. Clicking it adds the range to the pending list. 'guardar rangos' validates and saves."
    why_human: "Calendar rendering, hover preview, and 3-state click interaction require visual verification"
  - test: "Cross-section validation"
    expected: "Type a new targetDateBefore in Section A without saving it, then click 'guardar rangos' in Section B — validation must use the typed (unsaved) target value, blocking save if 0 dates would remain under that combination"
    why_human: "Cross-section pending-state interaction requires manual testing of the exact scenario"
  - test: "Mobile responsiveness"
    expected: "At viewport width < 540px the panel goes full-width with no left border"
    why_human: "Requires browser viewport resize"
---

# Phase 03: Bot Config Editor Verification Report

**Phase Goal:** El operador puede editar `targetDateBefore` y los rangos de exclusion de fechas de cada bot directamente desde el dashboard, sin tocar la DB ni la API a mano. Un modal abre un editor con mini-calendar range picker. Antes de guardar, el sistema valida que la nueva configuracion deja al menos 1 fecha disponible para reagendar — si no, bloquea el save con un mensaje explicativo.

**Verified:** 2026-04-08T22:10:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| #  | Truth | Status | Evidence |
|----|-------|--------|----------|
| 1  | Modal accessible via gear icon in bot-detail header | VERIFIED | `src/api/dashboard.ts:1145` — cfgBtn span with `onclick="openCfgModal()"` is inside `.hdr-title` after the cursor span |
| 2  | Modal opens as slide-in panel from right with overlay | VERIFIED | `openCfgModal()` at line 2592: creates `.cfg-overlay` + `.cfg-panel`, appends both, uses `requestAnimationFrame` double-RAF to add `.open` class triggering CSS `transform:translateX(0)` transition |
| 3  | Modal closes via overlay click, X button, or Escape | VERIFIED | Overlay `onclick=closeCfgModal` (l.2599), X button `onclick="closeCfgModal()"` (l.2607), `cfgEscHandler` added via `addEventListener` (l.2624) and removed on close (l.2651) |
| 4  | All 32+ .cfg- CSS classes from UI-SPEC present | VERIFIED | 39 unique `.cfg-*` class names found in `dashboard.ts`; all required classes confirmed present (cfg-overlay, cfg-panel, cfg-gear, cfg-hdr, cfg-title, cfg-close, cfg-section, cfg-section-title, cfg-section-desc, cfg-unsaved, cfg-date-input, cfg-date-null, cfg-btn-row, cfg-btn, cfg-btn-save, cfg-btn-clear, cfg-btn-accent, cfg-btn-loading, cfg-err, cfg-range-list, cfg-range-item, cfg-range-text, cfg-range-rm, cfg-range-empty, cfg-cal, cfg-cal-nav, cfg-cal-arrow, cfg-cal-month, cfg-cal-hdr, cfg-cal-grid, cfg-day, cfg-day-out, cfg-day-dis, cfg-day-excl, cfg-day-today, cfg-day-start, cfg-day-end, cfg-day-preview, cfg-day-inrange) |
| 5  | GET /api/bots/:id/available-dates returns dates array from latest ok poll_log | VERIFIED | `src/api/bots.ts:820-844` — full implementation: queries `poll_logs` WHERE `botId=id AND status='ok' AND allDates IS NOT NULL` ORDER BY `createdAt DESC` LIMIT 1; returns `{dates, pollAge, stale}`; returns `{dates:[], stale:true}` when no row found |
| 6  | targetDateBefore section shows current value or 'sin limite' | VERIFIED | `renderCfgTargetSection()` at l.2656: renders input with value when `cfgSavedTarget` truthy, else renders `.cfg-date-null` div with 'sin limite' text plus hidden input |
| 7  | guardar triggers available-dates validation before saving | VERIFIED | `cfgSaveTarget()` at l.2699: calls `fetchJ(API+'/bots/'+BID+'/available-dates')`, filters via `cfgFilterDates`, blocks if filtered.length===0, then issues `fetch PUT` |
| 8  | limpiar clears targetDateBefore with confirm dialog | VERIFIED | `cfgClearTarget()` at l.2733: `confirm(...)` guard, then raw `fetch PUT` with `{targetDateBefore:null}` |
| 9  | lastBot updated in memory after save (no page reload) | VERIFIED | `cfgSaveTarget` sets `lastBot.targetDateBefore=newVal` + `cfgSavedTarget=newVal` then calls `renderCfgTargetSection()` (l.2718-2721); `cfgClearTarget` same pattern (l.2738-2741); `cfgSaveRanges` sets `lastBot.excludedDateRanges` + `cfgSavedRanges` (l.2904-2906) |
| 10 | Excluded ranges list shows current ranges with remove buttons | VERIFIED | `renderCfgRangesSection()` at l.2754: iterates `cfgPendingRanges`, renders `.cfg-range-item` divs with `.cfg-range-rm` buttons calling `cfgRemoveRange(i)`; renders `.cfg-range-empty` div when list empty |
| 11 | Mini-calendar renders with Spanish headers and month navigation | VERIFIED | `renderCfgCalendar()` at l.2778: day headers `lu,ma,mi,ju,vi,sa,do`; month names via Spanish array; prev/next arrow buttons calling `cfgPrevMonth()`/`cfgNextMonth()`; Monday-first grid via `(firstDay.getDay()+6)%7` offset |
| 12 | Calendar 3-state click interaction: start -> end -> confirm | VERIFIED | `cfgDayClick()` at l.2841: state 0 sets start+state 1; state 1 + click>=start sets end+state 2 (or restarts if <start); state 2 resets to new start; `cfgAddRange` button disabled unless state===2 (l.2854-2855) |
| 13 | Guardar rangos validates with cross-section pending target | VERIFIED | `cfgSaveRanges()` at l.2885: reads `var inp=document.getElementById('cfgDateInput'); var proposedTarget=(inp&&inp.value)?inp.value:cfgSavedTarget` (l.2891-2892) before calling `cfgFilterDates`; uses pending input value not just saved state |
| 14 | npm test passes with no regressions | VERIFIED | 206/206 tests passing (10 test files); confirmed by test run during verification |

**Score:** 14/14 truths verified (automated checks)

---

### Required Artifacts

| Artifact | Provides | Status | Evidence |
|----------|----------|--------|----------|
| `src/api/bots.ts` | GET /api/bots/:id/available-dates endpoint | VERIFIED | Route at line 820; substantive 25-line implementation with DB query, null guard, pollAge calculation; route placed before `/:id` catch-all at line 846 |
| `src/api/dashboard.ts` | All cfg CSS classes + gear button + modal scaffold + Section A + Section B + calendar | VERIFIED | 39 unique `.cfg-*` classes; gear button at l.1145; `openCfgModal`/`closeCfgModal`/`cfgEscHandler` at l.2592-2654; `renderCfgTargetSection`/`cfgSaveTarget`/`cfgClearTarget`/`cfgFilterDates` at l.2656-2745; `renderCfgRangesSection`/`renderCfgCalendar`/`cfgDayClick`/`cfgAddRange`/`cfgRemoveRange`/`cfgSaveRanges` at l.2749-2915 |

---

### Key Link Verification

| From | To | Via | Status | Evidence |
|------|----|-----|--------|----------|
| `dashboard.ts openCfgModal` | `openCfgModal()` function | `gear button onclick` | WIRED | l.1145 HTML has `onclick="openCfgModal()"` |
| `dashboard.ts openCfgModal` | `renderCfgTargetSection()` | direct call | WIRED | l.2625 — actual call (not comment) |
| `dashboard.ts openCfgModal` | `renderCfgRangesSection()` | direct call | WIRED | l.2627 — actual call (not comment) |
| `dashboard.ts cfgSaveTarget` | `/api/bots/:id/available-dates` | fetchJ GET | WIRED | l.2707 `fetchJ(API+'/bots/'+BID+'/available-dates')` |
| `dashboard.ts cfgSaveTarget` | PUT /api/bots/:id | raw fetch | WIRED | l.2712 raw fetch with `{method:'PUT', body:{targetDateBefore}}` |
| `dashboard.ts cfgSaveRanges` | `/api/bots/:id/available-dates` | fetchJ GET | WIRED | l.2890 `fetchJ(API+'/bots/'+BID+'/available-dates')` |
| `dashboard.ts cfgSaveRanges` | PUT /api/bots/:id | raw fetch | WIRED | l.2900 raw fetch with `{excludedDateRanges:cfgPendingRanges}` |
| `dashboard.ts cfgSaveRanges` | `cfgDateInput` pending value | DOM read | WIRED | l.2891-2892 reads `inp.value` fallback to `cfgSavedTarget` for cross-section validation |
| `dashboard.ts renderCfgCalendar` | `cfgPendingRanges` | excluded day class | WIRED | l.2808-2812 checks each day against all `cfgPendingRanges` entries to apply `cfg-day-excl` |

---

### Requirements Coverage

The ROADMAP.md lists the following CFG-* requirement IDs for Phase 3. REQUIREMENTS.md does not contain CFG-* entries (it covers Phase 1 TRACKER-* requirements only — Phase 3 requirements are defined inline in ROADMAP.md). Coverage is assessed from code evidence.

| Requirement | Source Plan | Description (from ROADMAP scope) | Status | Evidence |
|-------------|-------------|----------------------------------|--------|----------|
| CFG-MODAL-01 | 03-01 | Modal accessible from bot-detail | SATISFIED | Gear button at dashboard.ts:1145 |
| CFG-MODAL-02 | 03-01 | Slide-in panel with overlay, open/close behavior | SATISFIED | openCfgModal/closeCfgModal at l.2592-2654 |
| CFG-CSS-01 | 03-01 | All .cfg- CSS classes from UI-SPEC present | SATISFIED | 39 unique cfg classes verified |
| CFG-AVAIL-01 | 03-01 | GET /api/bots/:id/available-dates endpoint | SATISFIED | bots.ts:820-844 — substantive DB query |
| CFG-TARGET-01 | 03-02 | targetDateBefore editable in modal | SATISFIED | renderCfgTargetSection at l.2656 |
| CFG-TARGET-02 | 03-02 | Validation before save (available-dates filter) | SATISFIED | cfgSaveTarget l.2707-2721 |
| CFG-TARGET-03 | 03-02 | Clear to null with confirm dialog | SATISFIED | cfgClearTarget at l.2733 |
| CFG-VALID-01 | 03-02 | Block save when 0 dates remain | SATISFIED | l.2709-2713 in cfgSaveTarget |
| CFG-RANGE-01 | 03-03 | Excluded ranges list with remove buttons | SATISFIED | renderCfgRangesSection at l.2754 |
| CFG-RANGE-02 | 03-03 | Add ranges via calendar picker | SATISFIED | cfgAddRange at l.2873; wired via cfgDayClick state machine |
| CFG-RANGE-03 | 03-03 | Save ranges with validation | SATISFIED | cfgSaveRanges at l.2885 |
| CFG-CAL-01 | 03-03 | Mini-calendar with Spanish headers, month nav, day class priority | SATISFIED | renderCfgCalendar at l.2778 |
| CFG-VALID-02 | 03-03 | Cross-section validation (pending target + new ranges) | SATISFIED | cfgSaveRanges reads `cfgDateInput` pending value at l.2891-2892 |
| CFG-TEST-01 | 03-03 | npm test green with no regressions | SATISFIED | 206/206 tests passing |

All 14 requirement IDs claimed by plans are accounted for. No orphaned requirements detected.

---

### Anti-Patterns Found

No blockers or warnings found:
- No TODO/FIXME/PLACEHOLDER comments in cfg modal code
- No empty implementations or stub returns
- No console.log-only handlers
- No `return null` in non-trivial paths
- Available-dates endpoint returns real DB data, not static arrays
- All save handlers issue actual PUT requests with response handling

---

### Human Verification Required

The following items require manual testing in a browser against a running dev server (`npm run dev`):

**1. Modal open/close visual behavior**

Test: Load bot-detail page, confirm gear icon (cog symbol) appears in the header after the bot number. Click it. Confirm panel slides in from right with overlay. Click overlay to close. Reopen, press Escape. Reopen, click X button.

Expected: Panel slides in with animation (~200ms), overlay darkens background. All three close paths dismiss the panel. Body scroll is restored after close.

Why human: CSS `transform` animation, `z-index` stacking, and `overflow:hidden` on body require visual inspection.

**2. targetDateBefore section rendering and save**

Test: Open modal on a bot that has `targetDateBefore` set. Verify the date input is pre-filled and both guardar + limpiar buttons appear. Change the date, click guardar. Verify loading state on button, then toast "Fecha limite guardada". Open modal on a bot with null targetDateBefore. Verify "sin limite" text and "establecer fecha limite" link. Click the link, verify input appears. Click limpiar and verify confirm dialog.

Expected: Section A fully interactive, toast messages appear, re-render without page reload.

Why human: DOM conditional rendering, button state transitions, and toast visibility require visual inspection.

**3. Excluded ranges calendar and state machine**

Test: Open Section B. Verify existing ranges appear with x buttons. Click a calendar day (any non-disabled day). Verify it highlights as start. Move mouse to a later day — verify hover preview. Click the later day — verify range highlights between start and end. Click "agregar rango" — verify range appears in list with correct Spanish date format. Navigate months with arrows. Verify past months disabled (prev arrow disabled on current month). Click "guardar rangos" and verify toast.

Expected: 3-state calendar interaction working end-to-end; month names in Spanish; day-of-week headers lu/ma/mi/ju/vi/sa/do.

Why human: Calendar grid rendering, hover preview, and range highlight transitions require visual verification.

**4. Cross-section validation**

Test: Type a narrow targetDateBefore in Section A (e.g., 5 days from now) without saving. Then in Section B add ranges that together with that target would exclude all available dates. Click "guardar rangos". Verify the error message appears and save is blocked — and that the error reflects the pending (unsaved) Section A target.

Expected: Error "Sin esta configuracion el bot no podria reagendar a ninguna fecha disponible." appears in Section B. Save is not issued.

Why human: This specific cross-section interaction requires both sections to be populated with specific values and the validation to run end-to-end.

**5. Mobile layout**

Test: Resize browser to width < 540px (or use DevTools mobile emulation). Open the modal.

Expected: Panel takes full width with no left border (matches `@media(max-width:540px){.cfg-panel{width:100%;border-left:none}}`).

Why human: Responsive breakpoint requires browser viewport resize.

---

## Gaps Summary

No gaps found. All 14 automated truths verified. All artifacts are substantive (not stubs), all key links are wired, and the test suite is green at 206/206. The phase is pending human visual verification of the interactive UI behavior — a gate that was expected (Plan 03 Task 3 is `checkpoint:human-verify`).

---

_Verified: 2026-04-08T22:10:00Z_
_Verifier: Claude (gsd-verifier)_

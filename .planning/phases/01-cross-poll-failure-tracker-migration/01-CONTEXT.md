# Phase 1: Cross-Poll Failure Tracker Migration - Context

**Gathered:** 2026-04-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Persistent cross-poll failure counter stored in `bots.casCacheJson.dateFailureTracking` (jsonb). Tracks failures per candidate date with dimension breakdown (consular/cas × noTimes/noDays), sliding 1h window, 2h block at threshold (5 fails). Replaces the existing `dateCooldowns` mechanism that lives in Trigger.dev task payload and gets lost on chain restarts.

**In scope:**
- Schema type extension (`CasCacheData.dateFailureTracking`)
- Pure tracker module (`src/services/date-failure-tracker.ts`)
- Wiring in `reschedule-logic.ts` (3 increment sites) with delta returned via `RescheduleResult`
- Orchestration in `poll-visa.ts:864-937` (prune, filter, persist, merge into blockedConsularDates)
- CAS escape hatch in `prefetch-cas.ts`
- Clear-on-success + currentConsularDate guards
- Full deletion of dead `dateCooldowns` code
- Pure-module + integration tests

**Out of scope** (see REQUIREMENTS.md):
- Exponential backoff, decay counters, per-bot tunables → Phase 2 if needed
- Dashboard/API endpoints exposing tracker state
- Touching `repeatedlyFailingDates` per-call (quick-task 260403-gpj) or `falsePositiveDates`
- Coexistence with `dateCooldowns` (it gets deleted, not kept in parallel)

</domain>

<decisions>
## Implementation Decisions

### Scope & Architecture (locked in initial research discussion)
- **Migrate + eliminate** `dateCooldowns`. Do NOT coexist. Delete all references.
- Pattern: `RescheduleResult` delta channel (same as existing `falsePositiveDates`, `repeatedlyFailingDates`). `executeReschedule` stays read-only on input, returns delta.
- Orchestration (read/prune/filter/persist) lives in `poll-visa.ts:864-937`.
- Zero new dependencies. Tracker is a ~30-line pure module with injected `now` for testability.
- Fixed-window algorithm (not sliding log/counter) — bias toward under-blocking matches Core Value.
- `jsonb_set` writes per key (same pattern as `blockedConsularDates` at `poll-visa.ts:933`). Single-writer-per-bot invariant (`activeRunId` + `cancelPreviousRun`) makes concurrent writes a non-concern.

### Threshold & TTL (locked in initial research discussion)
- Count **`no_times`**, **`no_cas_days`**, **`no_cas_times`** only. Do NOT count `verification_failed`, `session_expired`, `post_error`, `fetch_error`, `post_failed` (they have dedicated handling).
- Threshold: **5 failures within a 1h sliding window** → set `blockedUntil = now + 2h`.
- Breakdown by dimension: `consularNoTimes`, `consularNoDays`, `casNoTimes`, `casNoDays`. All sum equally into `totalCount` in v1. Breakdown persisted for future policy differentiation.
- **Reset on successful reschedule**: mirror `updateDateCooldowns:1699` behavior but scoped to the single date that was booked (not all entries).
- **Reset on portal disappearance** (TRACK-04) — **REFINED**: see "Flapping date handling" below.

### Flapping date handling (locked in this discussion)
- When a date disappears from `days.json` in a poll, **DO NOT delete its entry immediately**. Preserve the counter so flapping dates (visible→invisible→visible) accumulate properly. Mandatory because CLAUDE.md "Cancellation Insights" notes 43% of dates have ≤2min lifetime and 54% have ≤3min — the portal is a flapping environment.
- **TRACK-04 reset rule (refined)**: Delete an entry only when ALL THREE conditions hold:
  1. The date is not in `allDays` (disappeared from portal), AND
  2. The sliding window expired (`now - windowStartedAt > 1h`), AND
  3. The entry is NOT actively blocked (`!blockedUntil || blockedUntil <= now`).
- An entry with `blockedUntil` in the future is ALWAYS preserved regardless of window age or portal absence. Losing the block on a still-failing date would defeat the feature.
- An entry whose window expired but `blockedUntil` is still active → keep the block, ignore the stale window.

### Cap & pruning (locked in this discussion)
- Hard cap: **100 entries** per bot's `dateFailureTracking`.
- Eviction policy when cap exceeded: drop entries with the lowest `totalCount` first; tie-break by oldest `lastFailureAt`. Do NOT evict entries with an active `blockedUntil`.
- Pruning runs in `poll-visa.ts` just before the `jsonb_set` write. Not in `prefetch-cas` (keeps all logic in the hot path, no cross-task coordination).
- Rationale: 100 × ~200 bytes = ~20 KB, well below any egress concern. Protects against bloat if the flapping-preserve logic has a bug.

### Logging & observability (locked in this discussion)
- Three structured log events via `logger.info` / `logger.warn` (mirrors CAS blocker style at `poll-visa.ts:915,920,930`):
  1. **`tracker.increment`** — `{ botId, date, dimension, totalCount, windowStartedAt }` — emitted when a fail increments the tracker.
  2. **`tracker.blocked`** — `{ botId, date, until, breakdown, totalCount }` — emitted when `blockedUntil` is first set on an entry.
  3. **`tracker.cleared`** — `{ botId, date, reason: 'success' | 'cas_available' | 'pruned' | 'window_expired' | 'portal_disappeared' | 'current_consular_safety' }` — emitted when an entry is removed.
- Metric: add **`poll_logs.extra.trackerSize`** field (integer count of entries in `dateFailureTracking` after this poll's persist). Enables bloat detection via existing poll_logs query API.
- Do NOT log the full tracker state on every poll (too verbose for Trigger.dev cloud). Only log deltas and state-change events.

### currentConsularDate safety (locked in this discussion)
- **Never increment the tracker for a candidate date equal to `bot.currentConsularDate`**. If code reaches a failure path with `candidate.date === bot.currentConsularDate`, skip the tracker increment entirely. Defensive against: portal propagation lag (see CONCERNS.md "portal_reversion" and the recent-reschedule guard at `poll-visa.ts:705-719`), race conditions, and paths that weren't supposed to reach failure on the current date.
- **Defensive purge in poll-visa**: during the prune/filter step at `poll-visa.ts:864-937`, if any entry in `prunedTracker` has its date equal to `bot.currentConsularDate`, delete that entry and log `tracker.cleared` with `reason: 'current_consular_safety'` + a `logger.warn`. This is a safety net — it shouldn't fire in steady state, but protects Core Value if upstream clearing logic has a gap.

### Rollout & deploy (locked in this discussion)
- **No shadow mode.** Deploy the full feature directly. Rationale: unit + integration tests cover semantics; rollback is trivial (git revert + redeploy); shadow mode adds code and complexity that must be cleaned up afterwards.
- **Deploy order: RPi first, then cloud.** `npm run deploy:rpi` → RPi runs bot 6 in dev mode (residential IP) → observe `journalctl -u visa-trigger` logs → then `mcp__trigger__deploy environment=prod` for cloud pollers.
- **No manual smoke test on specific bots.** Rely on automated tests + log inspection post-deploy. User will watch `journalctl` after the RPi deploy.
- **Rollback procedure**: standard `git revert <commit>` + `npm run deploy:rpi` + `mcp__trigger__deploy environment=prod`. Deleted `dateCooldowns` code restores with the revert. No DB manual cleanup needed (`dateFailureTracking` field becomes vestigial, ignored by reverted code, and will be overwritten on next prefetch-cas / poll cycle).
- **Do NOT use `git reset --hard` or force-push** as rollback. Always a new commit (user rule from CLAUDE.md).

### Claude's Discretion
- Exact helper function signatures inside `date-failure-tracker.ts` (names, parameter order) — free to refine during implementation as long as behavior matches the locked semantics.
- Whether to use a separate top-level `jsonb_set` call for `dateFailureTracking` vs a nested `jsonb_set(jsonb_set(..., 'blockedConsularDates', ...), 'dateFailureTracking', ...)` — prefer the nested single-statement form for atomicity (from PITFALLS.md §3) but falling back to two sequential calls is acceptable given single-writer-per-bot invariant.
- Exact test layout (single file vs split between unit + integration) — as long as all 9 TEST-* requirements are covered and `vi.useFakeTimers()` is used where time-dependent.
- Whether the `CasCacheData.dateFailureTracking` field is added as a brand-new interface `DateFailureEntry` in `schema.ts` vs inlined — style preference, pick whichever reads cleaner.
- Exact logger level (info vs debug) for the three tracker events, as long as `tracker.blocked` is at `info` minimum.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project & milestone context
- `.planning/PROJECT.md` — Core Value, requirements (TRACK-01..08), scope boundaries, key decisions table
- `.planning/REQUIREMENTS.md` — All 35 v1 requirements with traceability
- `.planning/ROADMAP.md` — Phase 1 goal and success criteria
- `.planning/STATE.md` — Current project state

### Research outputs (required reading)
- `.planning/research/SUMMARY.md` — Headline finding + key decisions locked
- `.planning/research/STACK.md` — Algorithm choice (fixed window), pure-module shape, jsonb_set pattern, testing approach
- `.planning/research/FEATURES.md` — Library patterns (opossum/cockatiel) that do NOT apply, anti-features
- `.planning/research/ARCHITECTURE.md` — Exact file:line change plan, data flow diagram, RescheduleResult delta channel pattern, build order
- `.planning/research/PITFALLS.md` — **Critical discovery** (existing `dateCooldowns`), 9 pitfalls, interaction matrix against 6 existing blocking layers, must-write test cases

### Codebase context
- `.planning/codebase/ARCHITECTURE.md` — Overall system architecture
- `.planning/codebase/STRUCTURE.md` — Directory layout
- `.planning/codebase/CONCERNS.md` — Known fragile areas, tech debt, layered blocking mechanisms (already flagged as overlapping retry tracking tech debt)
- `.planning/codebase/TESTING.md` — Vitest patterns already in use
- `.planning/codebase/CONVENTIONS.md` — Error handling, logging, import patterns

### Source files to read before implementing (from ARCHITECTURE.md)
- `src/db/schema.ts:38-82` — `CasCacheData` interface to extend
- `src/services/reschedule-logic.ts:51-65` — `RescheduleResult` interface
- `src/services/reschedule-logic.ts:217-221` — per-call `dateFailureCount` init (parallel structure)
- `src/services/reschedule-logic.ts:378,593,617` — the 3 tracked increment sites
- `src/services/reschedule-logic.ts:440,669,882,901` — the 4 NOT-tracked increment sites (verify we don't wire these)
- `src/services/reschedule-logic.ts:912-915` — `repeatedlyFailingDates` aggregation pattern to mirror
- `src/trigger/poll-visa.ts:30` — `DateCooldownEntry` (to delete)
- `src/trigger/poll-visa.ts:37` — `PollPayload.dateCooldowns` (to delete)
- `src/trigger/poll-visa.ts:88` — `updatedCooldowns` variable (to delete)
- `src/trigger/poll-visa.ts:705-719` — recent reschedule check (relevant to currentConsularDate safety)
- `src/trigger/poll-visa.ts:864-937` — orchestration block (prune, lazy load, executeReschedule, persist blocks)
- `src/trigger/poll-visa.ts:933` — reference `jsonb_set` pattern to mirror
- `src/trigger/poll-visa.ts:1529` — `dateCooldowns` threading at self-trigger (to delete)
- `src/trigger/poll-visa.ts:1689-1735` — `updateDateCooldowns`, `getActiveCooldowns`, `DATE_COOLDOWN_*` constants (all to delete)
- `src/trigger/prefetch-cas.ts` — full file (escape hatch site)
- `src/services/__tests__/reschedule-cas-cache.test.ts` — existing test patterns to mirror
- `src/services/__tests__/reschedule-stability-fixes.test.ts` — existing `vi.useFakeTimers()` patterns

### Project conventions
- `CLAUDE.md` — stack, preferences (UTC-5 Bogotá reporting), critical rules (reschedule invariants), gotchas (timezone, `npx tsx -e`, jq quoting)
- `.planning/quick/260403-gpj-add-1h-cooldown-for-repeatedly-failing-r/260403-gpj-SUMMARY.md` — prior work on `repeatedlyFailingDates` per-call tracker (parallel structure to the new cross-poll tracker — DO NOT touch this, they are complementary)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`jsonb_set` pattern at `poll-visa.ts:933`** — exactly the write shape needed for `dateFailureTracking`. Copy it verbatim for the new field.
- **`blockedConsularDates` filter logic at `poll-visa.ts:868-881`** — exactly the read/filter pattern. The new tracker filter merges into the same `blockedDateSet`.
- **`RescheduleResult.falsePositiveDates` / `repeatedlyFailingDates` channel** in `reschedule-logic.ts:62-64` — proven pattern for passing state deltas from `executeReschedule` back to `poll-visa.ts`. Mirror it.
- **`dateFailureCount` per-call Map at `reschedule-logic.ts:217-221`** — parallel structure for the cross-poll tracker (two Maps side by side in the same scope, incremented at the same sites, returned as two different fields).
- **Existing test patterns in `reschedule-cas-cache.test.ts`** — mocking strategy for `VisaClient`, `vi.useFakeTimers()`, how to assert on `RescheduleResult` fields. New tracker tests can be added in the same file.
- **`logger.info('CAS blocker: ...', { botId, dates, until })` pattern** at `poll-visa.ts:915,920,930` — mirror for tracker log events.

### Established Patterns
- **Lazy load `casCacheJson`** at `poll-visa.ts:864-866` — a dedicated SELECT that only runs when reschedule is needed. The new tracker adds NO additional query — it rides along with this existing lazy load.
- **Fire-and-forget `pending.push(...)`** for DB writes in `poll-visa.ts` — the tracker write follows the same pattern.
- **Pure functions with injected `now`** — the codebase already uses this pattern in `scheduling.ts`. Tracker module should be the same style (no `Date.now()` inside pure functions).
- **ISO strings with `Z` suffix** for all timestamps (codebase convention; CLAUDE.md documents the timezone gotcha).
- **Custom error classes** (`InvalidCredentialsError`, `SessionExpiredError`) are the convention — but the tracker doesn't need new error types; pure functions return values.

### Integration Points
- **`src/services/reschedule-logic.ts:218-221`** — add `trackerDelta` Map next to existing `dateFailureCount` Map and `falsePositiveDates` Set.
- **`src/services/reschedule-logic.ts:378, 593, 617`** — the 3 increment sites where `bumpTracker(date, dimension)` is called alongside existing `dateFailureCount.set(...)`.
- **`src/services/reschedule-logic.ts` return sites (lines 390, 582, 957, 992, 1013)** — add `dateFailureTrackingDelta` and `newlyBlockedDates` fields.
- **`src/trigger/poll-visa.ts:864-937`** — the orchestration block. The new prune-read-filter-persist lifecycle slots in here.
- **`src/trigger/prefetch-cas.ts`** — the escape hatch. When prefetch finds fresh CAS for a blocked date, call `clearOnCasAvailable` + `jsonb_set`.
- **`src/db/schema.ts` `CasCacheData` interface** — add `dateFailureTracking?: Record<string, DateFailureEntry>` optional field for backwards compat.
- **`src/trigger/poll-visa.ts:30, 37, 88, 1529, 1689-1735`** — ALL must be deleted (dead `dateCooldowns` code).

</code_context>

<specifics>
## Specific Ideas

- **"Observar journalctl después del deploy RPi"** — user explicitly said no manual smoke test, but will watch logs after `npm run deploy:rpi`. The structured `tracker.*` log events are the primary observability channel for that watch.
- **"Revert commit + redeploy es suficiente"** — rollback is low-stakes because the dead code is restored by the revert and the jsonb field becomes vestigial.
- **Mirror `updateDateCooldowns:1699` semantics** for clear-on-success, but scope to the single booked date, not `return {}`. User was explicit about this scoping.
- **Cap at 100, not 50 or unbounded** — user picked the middle ground for safety margin without being overly conservative.
- **`poll_logs.extra.trackerSize`** as the designated bloat metric — not a new table, not a new endpoint, just ride on the existing poll_logs.extra jsonb.

</specifics>

<deferred>
## Deferred Ideas

Ideas that surfaced but belong in future phases:

- **Exponential backoff for block duration** (15m → 30m → 1h → 2h) instead of flat 2h at threshold — mapped to REFINE-01 in REQUIREMENTS.md v2.
- **Decay counter** (−1 per poll absent) instead of all-or-nothing preserve-or-delete — mapped to REFINE-02.
- **Per-bot tunable thresholds and TTL** — mapped to REFINE-03.
- **Soft penalty for CAS failures** (noCas* counts 0.5x because CAS flips fast) — mapped to REFINE-04.
- **Dashboard endpoint** `GET /api/bots/:id/failure-tracking` exposing current tracker state — mapped to OBSERV-01.
- **Alerts when tracker blocks a date another bot successfully books** — cross-bot anomaly detection, mapped to OBSERV-03.
- **Consolidating `falsePositiveDates` / `no_cas_days` 30m block / `repeatedlyFailingDates` per-call cooldown** into a single unified blocking layer — would collapse 5 layers further into 2-3. Meaningful refactor, not needed for v1 feature parity. Track as tech debt in CONCERNS.md.
- **Shadow mode / feature flag infrastructure** — if future milestones need safer rollout, consider a generic feature-flag column on `bots` or a `runtime_config` key-value store.

</deferred>

---

*Phase: 01-cross-poll-failure-tracker-migration*
*Context gathered: 2026-04-07*

# PITFALLS — Cross-Poll Failure Tracking

**Confidence:** HIGH — every claim grounded in specific file:line references.

## ⚠️ CRITICAL DISCOVERY: `dateCooldowns` already exists

**Before any TRACK-* code, read `src/trigger/poll-visa.ts:1689-1735`.** The codebase ALREADY has a mechanism called `dateCooldowns` that implements ~80% of the proposed feature. The PROJECT.md "Active" section and the original ask are both unaware of it.

### What `dateCooldowns` already does (poll-visa.ts:1689-1735)

```typescript
const DATE_COOLDOWN_THRESHOLD = 5;   // ← same as proposed
const DATE_COOLDOWN_MINUTES = 10;    // ← proposed: 120 (2h)

function updateDateCooldowns(existing, result, currentDates) {
  if (result.success) return {};                    // ← reset on success ✓
  if (currentDates.some(d => !(d in existing))) return {};  // ← "new date → reset all"

  for (const attempt of result.attempts ?? []) {
    if (attempt.failReason === 'no_times' || 'no_cas_days' || 'no_cas_times') {
      // ← same 3 fail reasons as user requested ✓
      // increment per-date count, block for 10 min at threshold
    }
  }
  // prune disappeared dates  ← TRACK-04 already implemented ✓
  for (const date of Object.keys(updated))
    if (!currentDates.includes(date)) delete updated[date];
}
```

### Where it's stored — and why it's broken

**NOT in the DB.** It lives in the Trigger.dev **task payload** (`PollPayload.dateCooldowns`, line 37), passed from poll to poll via the self-trigger chain (line 1529).

**This means `dateCooldowns` is lost whenever:**
- The `login-visa` task runs (starts a fresh chain with empty payload)
- A poll chain dies and `ensure-chain` resurrects it (Tuesday 8:50-8:59 Bogota)
- Any cron-triggered run that doesn't inherit from a previous self-chain
- A new version of the task deploys and cancels delayed runs
- TCP backoff causes a longer delay that times out the chain

In other words: the tracker the user has been seeing fail is **this mechanism losing state**, not a missing feature. The user's report of "29/6 fails repeatedly across polls without blocking" is consistent with `dateCooldowns` getting reset by a chain restart every few polls.

### Mapping user's request ↔ existing `dateCooldowns`

| User asked for | Already in `dateCooldowns`? | Change needed |
|---|---|---|
| Count `no_times` / `no_cas_days` / `no_cas_times` | ✅ Line 1708 | None |
| Threshold 5 | ✅ Line 1690 | None |
| Reset on success | ✅ Line 1699 | None |
| Reset on date disappearance from portal | ✅ Line 1719-1721 | None |
| Persistent across polls | ⚠️ Task payload only (lost on chain restart) | **Move to `casCacheJson` jsonb** |
| Cooldown 2h (not 10min) | ❌ Currently 10 min | **Change DATE_COOLDOWN_MINUTES to 120** |
| 1h sliding window | ❌ Uses "any new date → reset all" | **Switch to timestamp-based window OR keep existing semantics** |
| Breakdown by dimension (consular × cas × times × days) | ❌ Flat counter | **Add `byDimension` field** (future policy enablement) |

**The real milestone is two small things, not a new tracker:**

1. **Persist `dateCooldowns` in DB** (`bots.casCacheJson.dateCooldowns` instead of task payload) so it survives chain restarts.
2. **Lengthen the cooldown** from 10min to 2h and adjust reset semantics to use a time window (or keep the aggressive "any new date" reset — worth discussing).

Optionally: add `byDimension` breakdown for future policy differentiation.

**Scope collapse:** The PROJECT.md TRACK-01..06 requirements can be fulfilled by ~30 lines of surgical changes to the existing `updateDateCooldowns` function and its persistence layer, not by building a parallel tracking system.

---

## Pitfall 1: Building a parallel tracker while `dateCooldowns` already exists

**What goes wrong:** The roadmap ships TRACK-01..06 as a greenfield `dateFailureTracking` object without touching `updateDateCooldowns`. You end up with **two competing trackers**, divergent thresholds and TTLs, and confusion about which one "won" a block. Debugging production requires understanding both.

**Why it happens:** `dateCooldowns` is invisible from a casual search — it's in the task payload, not a DB column. `grep blockedConsularDates` doesn't find it. PROJECT.md doesn't mention it; CLAUDE.md doesn't mention it; the prior quick task (260403-gpj) didn't mention it.

**Prevention:**
1. **Decision before TRACK-01:** Migrate `dateCooldowns` into the new `dateFailureTracking` shape and delete the old. Do NOT build a parallel mechanism.
2. Collapse the two into one function `recordFailure(date, reason) → newState`.
3. Document in the plan that `dateCooldowns` is being replaced, not duplicated.

**Test this:** Grep the codebase post-implementation for any remaining reference to `dateCooldowns`, `DATE_COOLDOWN_THRESHOLD`, `DATE_COOLDOWN_MINUTES`, `updateDateCooldowns`, `getActiveCooldowns`, `DateCooldownEntry`. Expect zero matches outside of git history.

**Phase to address:** **Phase 0** (scope decision) before plan-phase.

---

## Pitfall 2: Reset-on-disappearance lets a flapping date escape forever

**What goes wrong:** A date in the portal flips visible/invisible every poll (real pattern — CLAUDE.md "Cancellation Insights": median 2-min lifetime, 43% disappear in ≤2min). Each disappearance resets its counter. The date never accumulates 5 fails, never gets blocked, and the bot burns polls on it for hours.

**Why it happens:** TRACK-04 was designed for the clean case (date abandoned permanently). Production is the dirty case. The reschedule loop is tuned to catch flashing dates — those are exactly the ones we want to block when they fail repeatedly.

**Prevention:**
- Option A: Reset only after N **consecutive** absences, not first.
- Option B: Decay counter (−1 per absent poll) instead of delete.
- Option C: Reset only after absence ≥30 min using a timestamp.
- **Recommended:** Option C — preserves TRACK-04's "clean abandonment" semantics while surviving flaps.

**Warning signs:**
- `dateFailureTracking[date].totalCount` oscillates 0→1→0→1 in logs.
- A date shows up in `reschedule_logs` with outcome `no_cas_days` 20+ times in 1h while tracker shows count ≤1.
- Never enters `blockedUntil` state despite obvious repeated failures.

**Phase to address:** TRACK-04 design. Write the oscillating-date test BEFORE the code.

---

## Pitfall 3: Concurrent jsonb writes to `casCacheJson` lose updates

**What goes wrong:** Two poll chains (`chainId='dev'` RPi + `chainId='cloud'` Trigger.dev, possible when `pollEnvironments: ['dev','prod']`) write to the same `bots.casCacheJson` row at the same time. Chain A writes `{blockedConsularDates: ...}`, chain B writes `{dateFailureTracking: ...}` simultaneously. `jsonb_set` is atomic **per key** — but `prefetch-cas` also writes `casCacheJson.entries` every 30 min independently. If two poll-visa runs each call `db.execute(jsonb_set(..., 'blockedConsularDates'))` and `db.execute(jsonb_set(..., 'dateFailureTracking'))` in separate statements, the **second call overwrites the first call's mutation** because jsonb_set patches a snapshot.

**Why it happens:**
- `pending.push()` makes writes fire-and-forget — no read-modify-write transaction.
- Each `jsonb_set` reads fresh state from DB, but multiple statements within the same poll can race with another poll's statements.

**Prevention:**
1. **Single `jsonb_set` call per poll** that sets BOTH `blockedConsularDates` AND `dateFailureTracking`:
   ```sql
   UPDATE bots SET cas_cache_json = jsonb_set(
     jsonb_set(COALESCE(cas_cache_json, '{}'), '{blockedConsularDates}', $1::jsonb),
     '{dateFailureTracking}', $2::jsonb
   ) WHERE id = $3
   ```
2. Fallback if the migration is too invasive: an advisory lock (`pg_advisory_xact_lock(botId)`) around the read-compute-write.

**Test this:** Fire two concurrent `executeReschedule` runs on the same bot in an integration test, assert both keys survived.

**Warning signs:**
- `dateFailureTracking` empty in DB despite logs showing it was written.
- `prefetch-cas` runs then a poll "loses" CAS entries from the same row.

**Phase to address:** The phase that adds the new write (wiring poll-visa).

---

## Pitfall 4: Threshold starves a legitimately bookable better date

**What goes wrong:** Date `2026-06-23` appears every 5 minutes for 1 hour. CAS is briefly unavailable each time. After 5 failures, tracker blocks it for 2h. On the 6th poll CAS becomes available, but the bot skips the date. User's `currentConsularDate` stays at Nov 30 instead of moving to Jun 23. **Direct violation of PROJECT.md Core Value** ("Nunca perder una fecha bookeable mejor que la actual").

**Why it happens:** CAS landscape flips in <2min. Tracker assumes "failure = non-bookeable" but failure can mean "non-bookeable right now."

**Prevention:**
- **Escape hatch:** When `prefetch-cas` refreshes and finds a blocked date now has slots, clear its tracker entry.
- **Soft penalty:** Only `no_times` (consular, stable) increments at full weight. `no_cas_*` increments weighted 0.5 (reaches threshold in 10 fails instead of 5).
- **Exponential backoff:** 15m → 30m → 1h → 2h instead of immediate 2h.
- PROJECT.md constraint is explicit: "Preferir bloquear de menos a bloquear de más."

**Warning signs:**
- `bookable_events` shows a date with outcome=success for another bot on the same facility while our bot has it in `blockedUntil`.
- User report: "bot didn't take an obviously better date."
- 2h blocks consistently expire and the same date immediately rebooks.

**Phase to address:** Threshold/TTL design phase. **Highest-stakes pitfall.**

---

## Pitfall 5: Counter coverage drift between `dateFailureCount` (per-call) and `dateFailureTracking` (cross-poll)

**What goes wrong:** `dateFailureCount` (existing per-call tracker) is incremented at multiple sites in `reschedule-logic.ts` (from quick-task 260403-gpj). The new cross-poll tracker must mirror those sites. Someone adds a 9th increment in 6 months, forgets to mirror. The two silently diverge.

**Prevention:**
1. **Single helper function** `recordFailure(date, reason, dimension)` that mutates BOTH maps. Adding a new failure type = one call, not two.
2. Better: **delete `dateFailureCount` / `repeatedlyFailingDates`** (the per-call version) when shipping the cross-poll version. Two trackers serving similar purposes is the actual debt.
3. Snapshot test: assert that for every `failedAttempts.push(...)` call, the new tracker is updated.

**Phase to address:** Implementation phase — make this structural, not vigilant.

---

## Pitfall 6: Timezone / clock skew in window arithmetic

**What goes wrong:** The 1-hour window uses `failures.filter(f => f.timestamp > Date.now() - 3600000)`. Timestamps stored as ISO strings. If anywhere in new code we compare a string-without-Z to `Date.now()`, we have a **5-hour bug** in production but tests pass (test machine is UTC) because CLAUDE.md warns: `new Date('2026-...')` sin TZ = local (+5h en Bogota).

Also: RPi worker clock may drift slightly vs cloud worker clock. At 1h granularity this is fine, but the codebase has documented timezone gotchas (see `persistDateSightings` line 1774 — hand-rolls Bogota timezone math).

**Prevention:**
- **ALWAYS** store via `.toISOString()` (with `Z` suffix).
- **ALWAYS** compare via `new Date(s).getTime()`.
- Single-writer-per-bot invariant makes cross-writer skew a non-issue — see STACK.md §5.
- **Test under `process.env.TZ = 'America/Bogota'`** to catch the 5h shift locally.

**Warning signs:**
- Tests pass on dev machine but RPi blocks/unblocks 5h off schedule.
- `windowStartedAt: '2026-04-06T15:00:00'` (no Z).
- Failure at 16:10 Bogota purged in a 21:00 UTC window query.

**Phase to address:** Implementation + test phases.

---

## Pitfall 7: Unbounded growth of tracker on bots with many failing dates

**What goes wrong:** Bot with `targetDateBefore: 2026-12-31` polling es-co. Hundreds of dates appear over weeks. Each gets entries in `dateFailureTracking`. Reset on disappearance is buggy or doesn't fire because the date keeps reappearing. `casCacheJson` grows 50 KB → 500 KB. The **lazy-load optimization** at `poll-visa.ts:864-865` becomes the bottleneck it was meant to solve. Neon egress costs jump.

**Prevention:**
- Hard cap: prune oldest if entries > 200.
- Hard cap on serialized size: `if (JSON.stringify(tracker).length > 50_000)` drop oldest.
- Schedule pruning in `prefetch-cas` (runs every 30 min).
- Add `poll_logs.extra.trackerSize` metric to detect bloat early.

**Warning signs:**
- `bots.casCacheJson` row size increases monotonically.
- Lazy load query gets slow.
- Neon egress alerts.

**Phase to address:** Data shape phase + reset/prune phase.

---

## Pitfall 8: Tracker blocks a date the bot just successfully booked (portal propagation race)

**What goes wrong:** Reschedule succeeds for `2026-06-23`. Result is `success=true`. Existing `updateDateCooldowns:1699` clears all cooldowns on success — good. **But the new tracker needs the same clearing logic.** Next poll, `2026-06-23` reappears in `days.json` (portal propagation lag, see CONCERNS.md "portal_reversion"). Tracker has 4 prior failures for `2026-06-23` from earlier polls. Poll fails (same date, no improvement). Counter ticks to 5 → blockedUntil set. **A date the bot just booked is now blocklisted for 2h.**

**Prevention:**
- On `result.success === true`, clear the entry for that date in the tracker. Mirror `updateDateCooldowns:1699` exactly.
- Better: clear any date equal to `bot.currentConsularDate` (just-booked, or recently booked).
- Also: don't increment if `isAtLeastNDaysEarlier(candidate.date, bot.currentConsularDate) === false` (date is no longer a strict improvement — failure is meaningless).

**Warning signs:**
- Bot books a date, then immediately blocks it.
- `reschedule_logs` shows success at T=0; tracker `blockedUntil` is set at T=2min for the same date.

**Phase to address:** Success-path integration. Write the "success clears tracker" test.

---

## Pitfall 9: Test flakiness from time-dependent windows

**What goes wrong:** Tests use real `Date.now()`. CI is slow. The 1-hour window test takes 1.2s. Boundary conditions (T+59:59 vs T+60:01) flip sporadically. Test fails 1 in 50 runs, gets marked "flaky," gets retried away. Real bug ships.

**Prevention:**
- **Pure tracker functions with injected `now` parameter** (see STACK.md) — no `Date.now()` inside the hot path. Tests pass explicit times.
- For integration tests that need `Date.now()`, use `vi.useFakeTimers()` + `vi.setSystemTime()` in `beforeEach`.
- Use `vi.advanceTimersByTime(ms)` — never `await sleep(...)`.

**Phase to address:** Test phase.

---

## Interaction Matrix: New tracker × each existing layer

| Layer | If both trigger for same date | Risk |
|---|---|---|
| `falsePositiveDates` (2h block) | New tracker increments on `verification_failed`, then its own block. Double-block but harmless TTL-wise (2h ≥ 2h). | LOW |
| `repeatedlyFailingDates` (per-call, 1h) | Same events counted twice. New tracker is strict superset. Redundant — consolidate. | MEDIUM (debt) |
| `no_cas_days` (30m block) | Both fire. 2h new-tracker > 30m no_cas. Block extended. **Defeats 30m design intent** (CAS flips fast). | HIGH (see Pitfall 4) |
| `dateCooldowns` (payload, 10m, threshold 5) | **Direct duplication.** Same triggers. Different storage + TTL + reset semantics. **MOST DANGEROUS** — they appear similar but reset divergently. | **CRITICAL (Pitfall 1)** |
| `exhaustedDates` (per-call) | Harmless. New tracker increments, exhaustedDates causes `break`. | LOW |
| `transientFailCount` (per-call <2) | Transient shouldn't count. Verify increment sites don't fire on transient paths. | MEDIUM |
| Recent reschedule check (2-min skip at poll-visa:705-719) | Recent reschedule causes consular sync skip BUT reschedule is still attempted if better date appears. Tracker counts this even though bot just rebooked. | HIGH (Pitfall 8) |
| `race_condition_stale_data` guard (reschedule-logic.ts:148-174) | Early return before loop → no increments. Good. But also no successes to clear. Stale entries persist. | LOW |

---

## Must-write test cases (ranked by bug-catching ROI)

All tests use `vi.useFakeTimers()` + `vi.setSystemTime(NOW)` in `beforeEach`.

```typescript
// Pitfall 8 — highest ROI (catches a real production bug no other test catches)
it('clears tracker entry on successful reschedule for that date', async () => {
  // Seed tracker with 4 prior fails for 2026-06-23
  // Run successful reschedule → 2026-06-23
  // Assert tracker[2026-06-23] undefined
});

// Pitfall 4 — catastrophic miss
it('does NOT block a date that becomes bookable while in tracker', async () => {
  // Seed tracker blocked for 2026-06-23
  // prefetch-cas finds CAS slots → tracker cleared
  // Next poll: 2026-06-23 IS attempted
});

// Pitfall 2 — flapping date escape
it('does NOT reset counter on single-poll absence', async () => {
  // Poll 1: date X appears, fails → count=1
  // Poll 2: date X absent → count still ≥1
  // Poll 3: date X reappears, fails → count=2
});

// Pitfall 6 — timezone
it('window comparison does not shift 5h under Bogota TZ', async () => {
  process.env.TZ = 'America/Bogota';
  // Insert at T=0, assert in-window at T+59min, out-of-window at T+61min
});

// Pitfall 3 — concurrent writes
it('writes blockedConsularDates AND dateFailureTracking in single SQL statement', async () => {
  // Spy on db.execute, assert single statement
});

// Pitfall 5 — counter drift
it('every failedAttempts.push() site increments the tracker', async () => {
  // Mock client produces every failure type; assert tracker.size
});

// Pitfall 7 — bloat
it('prunes oldest entries when tracker exceeds 200 dates', async () => {
  // Seed 250 dates, trigger update, assert size ≤ 200
});

// Core milestone goal
it('accumulates across two separate executeReschedule calls', async () => {
  // Call 1: 2 fails for date X → count=2, not blocked
  // Persist casCacheJson, simulate next poll
  // Call 2: 3 more fails → count=5, blocked
});
```

**Cheapest catches:** Pitfall 8 (success-clears) and Pitfall 6 (Bogota TZ). ~10 lines each, catch real production bugs.

---

## "Looks Done But Isn't" Checklist

- [ ] **Pitfall 1:** `dateCooldowns` is replaced, not duplicated. Grep returns zero matches post-implementation.
- [ ] **Pitfall 2:** Flapping date test passes.
- [ ] **Pitfall 3:** Single jsonb_set statement covers both keys.
- [ ] **Pitfall 4:** CAS becomes available → tracker clears.
- [ ] **Pitfall 5:** Single `recordFailure()` helper; no parallel increment sites.
- [ ] **Pitfall 6:** Test under `TZ=America/Bogota` passes.
- [ ] **Pitfall 7:** Hard cap on tracker entries.
- [ ] **Pitfall 8:** Success path clears tracker.
- [ ] **Pitfall 9:** All new tests use fake timers.
- [ ] **`npm test` passes** (mandate from CLAUDE.md).
- [ ] **TS type extended** with optional field for backwards compat.
- [ ] **Race with `prefetch-cas`:** both writes survive concurrent execution.

---

## Single most important recommendation

**Before writing any TRACK-* code, decide what to do with `dateCooldowns` (`poll-visa.ts:1689-1735`).** It already implements the cross-poll counter the milestone is requesting, just with different parameters (5 fails / 10m block) stored in the wrong place (task payload, not DB).

**The right answer is almost certainly:**
1. Migrate `dateCooldowns` semantics into `dateFailureTracking`
2. Delete `dateCooldowns` / `updateDateCooldowns` / `getActiveCooldowns` / `DateCooldownEntry`
3. Remove `dateCooldowns` from `PollPayload`
4. Stop threading cooldowns through the self-trigger chain at line 1529

That collapses 6 blocking layers down to 5 instead of growing to 7.

**Recommended phase structure after this decision:**
- **Phase 1** — Replace `dateCooldowns` with persistent `dateFailureTracking` in `casCacheJson.dateFailureTracking`. Preserve existing semantics (threshold 5, reset-on-success, prune-on-disappearance) but change cooldown to 2h and storage to jsonb. Add `byDimension` breakdown.
- **Phase 2** (optional) — Add the escape hatches (Pitfall 4 CAS-cleared reset, Pitfall 2 flapping-date handling) if the simple migration doesn't fix the observed pattern.

## Sources

- `src/trigger/poll-visa.ts:30,37,88,1529,1689-1735` — the hidden `dateCooldowns` mechanism
- `src/services/reschedule-logic.ts:217-221,378,440,593,617,669,882,901,912-1013` — existing per-call trackers and increment sites
- `src/db/schema.ts:44-82` — `CasCacheData` structure
- `src/services/__tests__/reschedule-cas-cache.test.ts` — existing test patterns
- `.planning/codebase/CONCERNS.md` — portal_reversion, ghost slots, overlapping retry tracking tech debt
- `.planning/PROJECT.md:30-46,60-68` — milestone scope and "prefer under-blocking" constraint
- `CLAUDE.md` — timezone gotchas, cancellation insights (2-min median date lifetime)

# Research Summary — Cross-Poll Failure Tracking

## Headline

**The feature already exists — mostly.** `src/trigger/poll-visa.ts:1689-1735` implements `dateCooldowns` with the same 3 fail reasons, same threshold 5, same reset-on-success, same prune-on-disappearance. The only problems are:

1. **Storage:** lives in Trigger.dev task payload (`PollPayload.dateCooldowns`, line 37). Lost on every chain restart (`login-visa`, `ensure-chain`, deploy, TCP backoff).
2. **TTL:** 10 minutes (too short for the observed pattern).
3. **Reset rule:** line 1704 resets ALL cooldowns whenever ANY new date appears — in a portal with constant flux, this fires on nearly every poll and prevents the counter from ever reaching threshold.

**The real milestone is surgical, not greenfield:** migrate `dateCooldowns` from task payload to `bots.casCacheJson.dateFailureTracking`, lengthen TTL to 2h, replace the aggressive reset with a 1h sliding window, add a `byDimension` breakdown for future policy, and add a CAS-available escape hatch. Net ~50-80 lines across 3 files.

## Stack — STACK.md

- **Zero new dependencies.** A 30-line pure module is the right "library."
- **Fixed window** beats sliding log/counter — under-blocking bias matches PROJECT.md "prefer to block less."
- **TypeScript shape** lives in `CasCacheData` (`src/db/schema.ts`) as optional field for backwards compat.
- **Pure functions with injected `now`** for unit tests — no fake timers in hot path.
- **Atomic jsonb writes** — reuse existing `jsonb_set('{key}', ...)` pattern at `poll-visa.ts:933`.
- **No clock skew concern** — `activeRunId` + `cancelPreviousRun` enforce single writer per bot.

## Features — FEATURES.md

- **Mature libraries (opossum/cockatiel/Polly) don't help here.** They solve admission control on in-process state, not jsonb-persisted cross-poll counters.
- **Absolute count is correct** (unusual for circuit breakers, right for this scope — one date over a handful of polls).
- **Half-open state is unnecessary** — TTL expiry + prune-on-disappearance provides "give it another chance" without a state machine.
- **Failure-type breakdown** is a future-proofing bet; v1 sums them all.
- **Anti-features:** counting transient errors (`tcp_blocked`, `session_expired`), per-bot tunable thresholds, a tracker-state API endpoint, ratio-based thresholds.

## Architecture — ARCHITECTURE.md

**Integration pattern: `RescheduleResult` delta channel.** Same as `falsePositiveDates` / `repeatedlyFailingDates` already do.

- `executeReschedule` receives tracker snapshot (read-only), computes increments, returns delta.
- `poll-visa.ts:864-937` owns the lifecycle: prune expired + disappeared → pass to executeReschedule → persist delta via `jsonb_set`.
- **Reset on disappearance belongs in poll-visa** because that's where `allDays` exists. `executeReschedule` only sees post-filter `preFetchedDays`.
- **Critical:** persist tracker delta OUTSIDE the `!result.success` guard — increments happen on earlier candidates before a later success.
- Exact change points documented at file:line in ARCHITECTURE.md.

## Pitfalls — PITFALLS.md

**9 pitfalls identified. Critical ones:**

| # | Pitfall | Prevention |
|---|---|---|
| **1** | Building parallel tracker while `dateCooldowns` exists | **Migrate + delete**, don't duplicate |
| **4** | Threshold starves a legit bookable date | **CAS-available escape hatch** in prefetch-cas |
| **8** | Block a date just successfully booked (portal propagation) | **Clear tracker on success** (mirror `updateDateCooldowns:1699`) |
| 2 | Flapping date escapes tracker via repeated resets | Use time window, not poll-count reset |
| 3 | Concurrent jsonb writes lose updates | **Single `jsonb_set` call** with nested subexpressions |
| 5 | Counter drift between per-call and cross-poll trackers | Single `recordFailure()` helper / delete the per-call one |
| 6 | Timezone 5h shift in Bogota TZ | Always `.toISOString()` with `Z`, test under `TZ=America/Bogota` |
| 7 | Unbounded tracker growth on bots with many dates | Hard cap entries; prune in prefetch-cas |
| 9 | Test flakiness from time-dependent windows | Inject `now`, use fake timers in integration tests |

## Recommended phase structure

**Phase 1 — Migrate + persist** (the entire milestone, per user's decisions)
1. Extend `CasCacheData` in `src/db/schema.ts` with `dateFailureTracking?: Record<string, DateFailureEntry>`.
2. Create `src/services/date-failure-tracker.ts` — pure functions: `recordFailure`, `isBlocked`, `pruneDisappeared`, `clearOnSuccess`, `clearOnCasAvailable`.
3. Extend `RescheduleResult` in `reschedule-logic.ts` with `dateFailureTrackingDelta` + `newlyBlockedDates`.
4. Wire increments at the 3 tracked sites (line 378 `no_times`, 593 `no_cas_days`, 617 `no_cas_times`).
5. Orchestration in `poll-visa.ts:864-937`: prune expired + disappeared → pass tracker → persist delta (both on success and failure) → merge newlyBlockedDates into `updatedBlocked` for 2h.
6. **CAS escape hatch** in `prefetch-cas.ts`: when refreshing CAS data, if a previously-blocked date has new availability, clear its tracker entry via `jsonb_set`.
7. **Delete dead code:** `DateCooldownEntry` (line 30), `payload.dateCooldowns` (line 37), `updatedCooldowns` (line 88), the threading at line 1529, `updateDateCooldowns` (line 1693), `getActiveCooldowns` (line 1726), `DATE_COOLDOWN_THRESHOLD`/`DATE_COOLDOWN_MINUTES` constants.
8. Tests: pure-module tests in new file, integration tests in `reschedule-cas-cache.test.ts` (cross-call accumulation, success clears, flapping date, Bogota TZ, CAS escape).
9. Manual smoke test on bot 6 (has live `no_times` history).
10. Deploy RPi + cloud.

## User decisions (locked)

| Decision | Value |
|---|---|
| Scope | **Migrate + eliminate** `dateCooldowns` (not coexist) |
| Reset rule | **1h sliding window**, drop "any new date → reset all" |
| Breakdown by dimension | **Yes in v1** (`consular/cas × times/days`) |
| CAS escape hatch | **Yes in v1** |
| Fail reasons counted | `no_times`, `no_cas_days`, `no_cas_times` (NOT post/verification/session) |
| Threshold + cooldown | 5 fails / 1h window → 2h block |
| Storage | `bots.casCacheJson.dateFailureTracking` (jsonb) |
| Reset on portal disappearance | Yes (preserve from existing `dateCooldowns`) |
| Reset on successful reschedule | Yes (mirror `updateDateCooldowns:1699`) |

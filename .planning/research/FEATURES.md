# Feature Landscape: `dateFailureTracking` (cross-call sliding-window failure tracker)

**Domain:** Per-key failure tracking for a polling/retry system with persistent storage
**Researched:** 2026-04-06
**Scope:** Features for TRACK-01..TRACK-06 only. NOT a generic polling-bot survey.

## Framing

The unit tracked is a **consular date** (string `YYYY-MM-DD`). The "calls" are independent
`executeReschedule()` invocations across many polls. Failures are categorized by **dimension**:
`{ consular | cas } × { noTimes | noDays }`. Storage is `bots.casCacheJson.dateFailureTracking`
(jsonb), no new tables. Threshold: **5 fails in 1h → block 2h**, reset when date disappears
from `days.json`.

This document maps mature library patterns onto that scope and calls out which patterns are
**load-bearing** for v1, which are **nice-to-have**, and which are **anti-features** that would
add complexity without addressing the real failure mode (poll waste on `5/11 09:00 → 6/7 no_times`
type sequences described in PROJECT.md).

## How mature libraries model this

### Opossum (Node.js, ~14k stars) — bucketed rolling window
- `Status` instance keeps a **fixed-size circular array of buckets**, one bucket per slice of
  `rollingCountTimeout / rollingCountBuckets` seconds (default 10s / 10 buckets = 1s slices).
- Every event (`fire`, `success`, `failure`, `timeout`, `reject`) increments counters in the
  **current** bucket. Old buckets fall off the end as the window advances.
- The trip decision uses an **error percentage over the window**, not an absolute count:
  `errorThresholdPercentage` against the sum of buckets.
- States: **closed → open → half-open → closed/open**. `resetTimeout` controls when it
  half-opens. Half-open admits one trial request.
- **One circuit per resource**, not per key. To track per-URL, you compose multiple breakers
  (a Map<key, CircuitBreaker>) — opossum does not do per-key sharding for you.

### Cockatiel — `SamplingBreaker` and `ConsecutiveBreaker`
- `SamplingBreaker({ threshold, duration, minimumRps })` — same idea: % failures within a
  rolling duration window. Designed to require a minimum traffic rate before tripping (avoids
  tripping a cold circuit on the first failure).
- `ConsecutiveBreaker(N)` — much simpler: trip after N consecutive failures, ignoring time
  entirely.
- Cockatiel composes with `retry`, `timeout`, `bulkhead`, `fallback`. Per-key tracking is the
  caller's responsibility (same as opossum).

### p-retry / async-retry — no per-key state at all
- These libraries are **stateless across calls**. They retry within a single invocation with
  exponential backoff and stop. They have no concept of "this key has failed in past
  invocations" — that's outside their scope. The visa-scraper's existing per-call
  `dateFailureCount` is conceptually equivalent to p-retry: useful within a call, blind
  across calls.

### Polly (.NET, model for cockatiel) — `AdvancedCircuitBreaker`
- `failureThreshold` (ratio) + `samplingDuration` (TimeSpan) + `minimumThroughput` +
  `durationOfBreak`. Same shape as opossum/cockatiel.
- Polly explicitly recommends **CircuitBreaker per dependency**, with a registry/factory
  for keying — i.e., the per-key concern is pushed to the host application.

### bottleneck — rate limiter, not failure tracker
- Per-key concurrency/rate limits via `Bottleneck.Group`. Tracks pending and queued counts
  per key with idle TTL eviction (`timeout` option auto-deletes idle Limiters). The eviction
  pattern is directly relevant to **TRACK-04**'s reset-on-disappearance behavior (see below).

### Common pattern across all of them
1. **Fixed-size bucketed window**, not unbounded list of timestamps.
2. **One failure-tracker instance per "key"**, with the host app managing the Map and
   eviction.
3. **State machine: closed/open/half-open**, with timed `resetTimeout` for half-open trial.
4. **Trip decision uses ratio + minimum throughput**, not absolute count, to avoid
   false trips on low traffic.
5. **Categorization (failure type breakdown) is rare** — most libraries collapse all errors
   into one counter and let the caller use `errorFilter` to decide what counts.

## Mapping to v1 needs

| Library pattern | Map to TRACK-0X | Verdict |
|---|---|---|
| Bucketed rolling window (opossum) | TRACK-03 sliding 1h window | **Adopt simplified** (one bucket per failure event with timestamp, not fixed buckets — keys are sparse) |
| Per-key registry/Map (opossum, cockatiel, Polly) | `dateFailureTracking: Record<date, Entry>` | **Adopt directly** |
| Idle-TTL eviction (Bottleneck) | TRACK-04 reset on disappearance from days.json | **Adopt** — but trigger is "absent from poll", not idle timeout |
| Open / half-open / closed states | TRACK-03 blockedUntil | **Skip half-open** — reset comes from disappearance, not from timed trial |
| Ratio + minimum throughput (SamplingBreaker) | — | **Skip** — absolute count is correct here; the resource is one date, not a high-RPS endpoint |
| ErrorFilter (opossum) deciding what counts | "Don't count post_failed/verification_failed" | **Adopt** — already in PROJECT.md Out of Scope |
| Failure-type breakdown | TRACK-01 consular×cas×noTimes×noDays dimensions | **Adopt** — uncommon in libs but justified by future-proofing decision in PROJECT.md |

## Table Stakes

Features the v1 tracker **must** have. Missing any of these = the feature does not deliver
on the milestone goal.

| # | Feature | Why required | Reference |
|---|---|---|---|
| TS-1 | **Per-date increment with timestamp** | Sliding window needs `failedAt` timestamps to expire old fails. Without timestamps, "5 in last hour" cannot be computed. | All libs use bucketed timestamps |
| TS-2 | **Threshold check (≥5 in 1h → blockedUntil)** | Core trip logic. | opossum `errorThresholdPercentage`, cockatiel `SamplingBreaker` |
| TS-3 | **`blockedUntil` enforced as a filter on `daysForReschedule`** | The block must actually skip the date in `poll-visa.ts:875-877` style filter. Storing the field without filtering is dead code. | opossum open-state rejection |
| TS-4 | **Sliding window expiry** (drop fails older than 1h before threshold check) | A naive `count++` would never reset and would block dates that fail occasionally over many days. | All sliding-window breakers |
| TS-5 | **Reset on disappearance from `days.json`** (TRACK-04) | Mantiene el tracker pequeño + da segunda oportunidad cuando la fecha vuelve. | Bottleneck idle-eviction |
| TS-6 | **Failure-reason filter — only `no_times` / `no_cas_days` / `no_cas_times`** | PROJECT.md Out of Scope: post_failed/verification_failed have dedicated handling and would contaminate the signal. | opossum `errorFilter` |
| TS-7 | **Coexistence with existing blocks** (TRACK-05) | Must not overwrite a longer `falsePositiveDates` 2h block with a shorter one. The existing `blockedConsularDates` write at `poll-visa.ts:925-927` already implements the "don't shorten" rule — the new tracker must follow the same convention. | poll-visa.ts:925-927 |
| TS-8 | **Persist to `casCacheJson` in the same `pending` write** | No new query per poll (Constraint in PROJECT.md). Must piggyback on the existing jsonb update path. | poll-visa.ts:932-935 |

## Differentiators

Features that improve observability or future flexibility. Worth including if cheap; not
required for the milestone to ship.

| # | Feature | Value | Cost | Recommendation |
|---|---|---|---|---|
| D-1 | **Dimension breakdown** (consular×cas × noTimes×noDays) | Future-proof for "noDays counts more than noTimes" policies. PROJECT.md decision is to persist the breakdown but treat all as equal in v1. | +4 fields per entry | **Include** — already a key decision |
| D-2 | **Auto-cleanup max-entries cap** (e.g. evict oldest if entries > 50) | Bounds jsonb size if disappearance reset doesn't fire (e.g. portal returns same broken date forever). | ~5 lines | **Include** — defensive, cheap |
| D-3 | **Structured log on increment + threshold trip** | Debugging: lets us answer "why was 5/11 blocked?" from logs without DB inspection. The existing CAS blocker logs (`poll-visa.ts:915,920,930`) set the precedent. | ~3 log statements | **Include** — matches existing style |
| D-4 | **`firstFailedAt` / `lastFailedAt` / `tripCount`** metadata per entry | Observability: lets a future endpoint surface "this date has tripped 3 times today". | ~3 fields | **Include** — almost free, useful for dashboards later |
| D-5 | **Reason histogram per entry** (`{ no_times: 4, no_cas_days: 1 }`) | Lets a debug log explain *what kind* of failure dominated. Implied by D-1 dimension breakdown — same data, different shape. | 0 (subsumed by D-1) | **Subsume into D-1** |
| D-6 | **Configurable threshold/window/block per bot** | Lets es-pe (9s polling) use a tighter window than es-co. | New bot columns | **Defer** — single hardcoded `(5, 1h, 2h)` is fine for v1 |
| D-7 | **Tracker-state endpoint** (`GET /api/bots/:id/date-failures`) | Surface for debug/manual inspection. | New route | **Defer** — logs sufficient per PROJECT.md Out of Scope |

## Anti-Features

Things v1 must **not** do. Each has a real cost (complexity, regression risk, or signal
contamination) and no benefit relative to the failure mode this milestone targets.

| # | Anti-feature | Why avoid | What to do instead |
|---|---|---|---|
| AF-1 | **Permanent block / "exhausted forever" set** for cross-call failures | A consular date that fails today may genuinely open up tomorrow (cancellation bursts, MEMORY.md). A permanent block would silently lock out real opportunities. The existing `exhaustedDates` per-call Set is OK because it's per-call. | TTL-bound `blockedUntil` + reset-on-disappearance |
| AF-2 | **Half-open trial state** (admit one probe poll after `blockedUntil`) | Adds a state machine to a feature that doesn't need one. Reset already happens via TRACK-04 (disappearance) and the natural expiry of `blockedUntil`. Half-open would also race with the existing `blockedConsularDates` filter which is plain TTL. | Plain TTL expiry: `blockedUntil > now` filters, otherwise admits |
| AF-3 | **Counting `post_failed` / `verification_failed` / `false_positive_verification`** | These have dedicated handling (`falsePositiveDates` 2h block, slot-specific retry). Counting them would double-count and trigger this 2h block on top of the falsePositive 2h block, with no signal gain. PROJECT.md explicitly excludes this. | Filter `failReason` to the three "no availability" reasons only |
| AF-4 | **Counting transient errors** (`tcp_blocked`, `session_expired`, `cache_miss`) | These say nothing about the date — they say something about the network/session. Counting them would block dates during a TCP block episode and unblock once the network recovers, which is exactly backwards. The existing `transientFailCount` already handles these per-call. | Hard filter list: only `no_times`, `no_cas_days`, `no_cas_times` |
| AF-5 | **Ratio-based threshold** (% failures vs total polls) | opossum/cockatiel use ratios because they protect high-RPS endpoints from cascading failure. The unit here is one date over a few polls — a ratio is meaningless. Absolute count is correct. | `count >= 5` |
| AF-6 | **Unbounded timestamp array per entry** | "Sliding window of last hour" tempts a `failedAt: number[]` array. Over weeks this grows unbounded if the entry never resets. Use a `count + windowStart` rolling-bucket pattern, OR cap the array length, OR prune timestamps older than the window on every increment. | Increment-time pruning: drop timestamps older than `now - 1h` before pushing the new one |
| AF-7 | **New DB table or schema migration** | PROJECT.md Constraint: lives in `casCacheJson`. A separate table would couple this milestone to a migration and rollback risk. | Extend `CasCacheData` type only |
| AF-8 | **Blocking dates that are still strictly better than current** without an escape hatch | PROJECT.md: "preferir bloquear de menos a bloquear de más por precaución". A bug in the tracker could lock out the only better date the bot will ever see. | Defensive: `blockedUntil` is advisory in the filter; if `daysForReschedule` becomes empty after filtering, log a warning but **do not** un-filter (the next poll resets via TRACK-04 anyway). Optional safety: if the only date being filtered is **>30 days earlier** than `currentConsularDate`, log loud. |
| AF-9 | **Refactoring `blockedConsularDates` / `falsePositiveDates` / `repeatedlyFailingDates` into a unified tracker** | CONCERNS.md "Reschedule-logic.ts has overlapping retry tracking" identifies this as tech debt — but unifying it is **out of scope** for this milestone (PROJECT.md). The new tracker lives **alongside**, not on top of, the existing ones. | Add `dateFailureTracking` as a parallel object. Unification is a future milestone. |
| AF-10 | **Dashboard / metrics UI for the tracker** | PROJECT.md Out of Scope. Logs cover v1 debugging needs. | Defer |

## Feature Dependencies

```
TS-1 (timestamped increment)
  ├─ TS-4 (window expiry)  ──┐
  └─ TS-2 (threshold ≥5/1h) ─┴─ TS-3 (filter daysForReschedule)
                                  │
                                  └─ TS-7 (don't shorten existing blocks)

TS-5 (reset on disappearance)  ── independent, runs on every poll
TS-6 (reason filter)            ── independent, gates TS-1
TS-8 (persist via pending)      ── ties output of TS-2/TS-3 to existing write path

D-1 (dimension breakdown)      ── extends TS-1 entry shape
D-2 (max-entries cap)          ── safety net for TS-5 failure mode
D-3, D-4 (logging/metadata)    ── orthogonal, observability
```

The critical chain for v1 is TS-1 → TS-4 → TS-2 → TS-3 → TS-7 → TS-8 plus the parallel
TS-5 and TS-6. Everything else is optional polish.

## Recommended v1 entry shape

Single suggested shape that satisfies all table stakes + included differentiators.
This is for the FEATURES dimension; the architecture document will pin the exact field names.

```ts
type DateFailureEntry = {
  // TS-1: rolling window of failure timestamps (pruned on every increment, see AF-6)
  failedAt: string[];                    // ISO timestamps within last 1h, max ~10 entries

  // D-1: dimension breakdown (persisted, not used for v1 trip decision)
  byDimension: {
    consularNoTimes: number;
    consularNoDays: number;              // reserved; consular noDays is rare
    casNoTimes: number;
    casNoDays: number;
  };

  // D-4: observability metadata
  firstFailedAt: string;
  lastFailedAt: string;
  tripCount: number;                     // how many times THIS entry has tripped (across resets)

  // TS-2 result: when the threshold trips
  blockedUntil?: string;                 // ISO; absent = not currently blocked
};

type DateFailureTracking = Record<string /* YYYY-MM-DD */, DateFailureEntry>;
```

Lives in `bots.casCacheJson.dateFailureTracking`, persisted via the same `pending`
jsonb_set pattern used at `poll-visa.ts:932-935`.

## Sources

- [opossum (nodeshift)](https://github.com/nodeshift/opossum) — bucketed rolling-window stats; `rollingCountTimeout` / `rollingCountBuckets` model. **HIGH** confidence (verified library docs).
- [cockatiel (connor4312)](https://github.com/connor4312/cockatiel) — `SamplingBreaker` (ratio + duration + minimumRps) and `ConsecutiveBreaker` (N consecutive). **HIGH** confidence.
- [opossum docs](https://nodeshift.dev/opossum/) — Status/window/bucket semantics, errorFilter pattern. **HIGH**.
- [cockatiel CircuitBreakerPolicy.ts](https://github.com/connor4312/cockatiel/blob/master/src/CircuitBreakerPolicy.ts) — half-open state machine reference. **HIGH**.
- [Polly AdvancedCircuitBreaker (resilience4j docs equivalent)](https://resilience4j.readme.io/docs/circuitbreaker) — failure-rate-threshold + sliding-window-size pattern referenced by Polly/cockatiel. **MEDIUM** (resilience4j is JVM but the model is identical and documented clearly).
- [Red Hat blog: Fail fast with opossum](https://developers.redhat.com/blog/2021/04/15/fail-fast-with-opossum-circuit-breaker-in-node-js) — confirms one-circuit-per-resource pattern; per-key is host responsibility. **MEDIUM**.
- Internal: `/Users/juanortega/visa-scraper/.planning/PROJECT.md` (TRACK-01..06, Out of Scope, Key Decisions) — **HIGH**.
- Internal: `/Users/juanortega/visa-scraper/src/trigger/poll-visa.ts:868-937` (existing `blockedConsularDates` write pattern with don't-shorten rule) — **HIGH**.
- Internal: `/Users/juanortega/visa-scraper/src/services/reschedule-logic.ts:217-221` (existing per-call `dateFailureCount`) — **HIGH**.
- Internal: `/Users/juanortega/visa-scraper/.planning/codebase/CONCERNS.md` (Reschedule-logic overlapping retry tracking — context for AF-9) — **HIGH**.

**Overall confidence:** HIGH. The library patterns are well-documented and consistent across
opossum/cockatiel/Polly; the mapping to this milestone is constrained by PROJECT.md decisions
that have already been made.

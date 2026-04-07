# ARCHITECTURE — Cross-Poll Failure Tracker Integration

**Confidence:** HIGH (all claims verified against source files at exact line numbers)

## Recommendation (TL;DR)

**Use the `RescheduleResult` channel — same pattern as `falsePositiveDates` and `repeatedlyFailingDates`. Do NOT mutate `casCacheJson` inside `executeReschedule`. Do NOT introduce a new service layer.**

Orchestration (read tracker → filter candidate dates → persist tracker delta → reset disappeared dates) lives in `poll-visa.ts:864-937`, in the same block that already does this for `blockedConsularDates`. `executeReschedule` stays pure-ish: receives prior tracker snapshot (read-only), computes increments, returns delta as a new `RescheduleResult` field.

## Rejected alternatives

**Option A — Mutate `casCacheJson` inside `executeReschedule`**
- `executeReschedule` currently treats `casCacheJson` as **read-only** (`reschedule-logic.ts:43`, destructured line 75). Making it mutable breaks the contract that DB writes are caller-owned (`pending: Promise<unknown>[]` queue + `jsonb_set` SQL in `poll-visa.ts:932-934`).
- Forces `executeReschedule` to know `nowMs`/expiry semantics that today live entirely in poll-visa.
- Test isolation suffers — existing test patterns assert return values, not side-effects.

**Option B — New service layer (`failure-tracker.ts`)**
- Premature abstraction. Tracker has exactly **two consumers** (reschedule-logic increments, poll-visa reads/persists/resets). Service module adds indirection without hiding complexity.
- Fragments the "lazy load casCacheJson" optimization at `poll-visa.ts:864-866`.
- PROJECT.md Out of Scope: "No políticas distintas por dimensión... v1 todos suman por igual."

**Option C — RescheduleResult delta channel (CHOSEN)**
- Mirrors **already-validated pattern** at `reschedule-logic.ts:62-64` (`falsePositiveDates`, `repeatedlyFailingDates`) consumed at `poll-visa.ts:908-909`. Zero new patterns.
- `executeReschedule` stays pure: input tracker is read-only; output is delta.
- Caller owns lifecycle in the same block that already exists.
- **Reset on disappearance naturally belongs in poll-visa** — that's where `allDays` exists (`poll-visa.ts:875`). `executeReschedule` only sees `preFetchedDays` (post-filter); it physically can't do the reset correctly.

## Data flow

```
poll-visa.ts:864  ── lazy SELECT casCacheJson ──────────────┐
                                                            ▼
poll-visa.ts:867  read cacheData.dateFailureTracking (snapshot)
                          │
                          ├─► 1. EXPIRE: drop entries with windowStartedAt > 1h ago
                          │
                          ├─► 2. RESET: drop entries whose date is NOT in allDays
                          │           (TRACK-04 — allDays available here, NOT in executeReschedule)
                          │
                          ├─► 3. FILTER: build blockedDateSet from entries with blockedUntil > now
                          │           daysForReschedule = allDays - blocked
                          ▼
poll-visa.ts:884  executeReschedule({
                    ...,
                    casCacheJson: {
                      ...cacheData,
                      dateFailureTracking: prunedTracker   // read-only snapshot
                    }
                  })
                          │
                          ▼
reschedule-logic.ts:218   per-call init: dateFailureCount Map (existing — untouched)
                          per-call init: trackerDelta Map<date, DateFailureEntry> (NEW, seeded from input)
                          │
                          ├─ at 3 dateFailureCount.set() sites (378 no_times, 593 no_cas_days, 617 no_cas_times):
                          │   ALSO call bumpTracker(date, dimension)
                          │
                          │  sites NOT tracked: 440/669 verification_failed (falsePositiveDates handles),
                          │                     882 session_expired, 901 fetch_error/post_error (out of scope)
                          ▼
reschedule-logic.ts:912   final aggregation (next to existing repeatedlyFailingDates build):
                          compute newlyBlockedDates: entries in trackerDelta whose totalCount ≥ 5
                          AND not in falsePositiveDates
                          ▼
return RescheduleResult {
  ...,
  falsePositiveDates,               // existing
  repeatedlyFailingDates,           // existing per-call (1h, threshold 3)
  dateFailureTrackingDelta,         // NEW: full merged tracker state
  newlyBlockedDates                 // NEW: dates that crossed 5-fail threshold → block 2h
}
                          │
                          ▼
poll-visa.ts:904-937    persist (EVEN on result.success === true, because increments may
                                 have happened on earlier candidates before a later one succeeded):
                          - existing: blockedConsularDates jsonb_set block (no change)
                          - NEW: for each newlyBlockedDate, write blockUntil2h into
                                 updatedBlocked (dominates rfDates 1h via existing guard :926)
                          - NEW: jsonb_set on '{dateFailureTracking}' with merged tracker
```

## Exact change points (file:line)

### 1. `src/db/schema.ts` — schema type extension

After line 51 inside `CasCacheData`:

```typescript
export interface DateFailureEntry {
  /** ISO 8601 timestamp of first failure in the current 1h window */
  windowStartedAt: string;
  /** Total fail count in the current window */
  totalCount: number;
  /** Breakdown by dimension — kept for future policy differentiation (PROJECT.md decision) */
  byDimension: {
    consularNoTimes?: number;
    consularNoDays?: number;  // reserved, symmetric
    casNoTimes?: number;
    casNoDays?: number;
  };
  /** ISO 8601 of last increment */
  lastFailureAt: string;
  /** ISO 8601 — set when totalCount crosses threshold. Dominates shorter blocks. */
  blockedUntil?: string;
}

export interface CasCacheData {
  // ... existing fields unchanged ...
  blockedConsularDates?: Record<string, string>;
  /** Cross-poll per-date failure counters. Pruned when date disappears from days.json. */
  dateFailureTracking?: Record<string, DateFailureEntry>;
}
```

Optional: PROJECT.md constraint "Bots sin `dateFailureTracking` en su casCacheJson funcionan igual que antes."

### 2. `src/services/reschedule-logic.ts` — interface + delta computation

**Lines 51-65** (`RescheduleResult`): add two fields

```typescript
export interface RescheduleResult {
  // ... existing ...
  repeatedlyFailingDates?: string[];
  /** Merged tracker state (input + increments this call). Caller persists via jsonb_set. */
  dateFailureTrackingDelta?: Record<string, DateFailureEntry>;
  /** Dates that crossed the 5-fail threshold this call. Caller blocks for 2h. */
  newlyBlockedDates?: string[];
}
```

**Line 218-220:** add per-call delta tracker seeded from input

```typescript
const dateFailureCount = new Map<string, number>();  // EXISTING
const REPEATEDLY_FAILING_THRESHOLD = 3;               // EXISTING
// NEW: seed from casCacheJson.dateFailureTracking (caller already pruned expired + disappeared)
const trackerDelta = new Map<string, DateFailureEntry>(
  Object.entries(casCacheJson?.dateFailureTracking ?? {})
);
const CROSS_POLL_THRESHOLD = 5;
const CROSS_POLL_BLOCK_MS = 2 * 60 * 60 * 1000;
const CROSS_POLL_WINDOW_MS = 60 * 60 * 1000;
```

**The 3 tracked increment sites** (among the 6 marked from quick-task 260403-gpj):

| Line | Existing failReason | Tracker dimension | Track? |
|------|---|---|---|
| 378 | `no_times` (consular) | `consularNoTimes` | ✅ |
| 593 | `no_cas_days` | `casNoDays` | ✅ |
| 617 | `no_cas_times` | `casNoTimes` | ✅ |
| 440 | `verification_failed` (no CAS) | — | ❌ falsePositive handles |
| 669 | `verification_failed` (CAS) | — | ❌ falsePositive handles |
| 882 | `session_expired` | — | ❌ out of scope |
| 901 | `fetch_error` / `post_error` | — | ❌ out of scope |

At each tracked site, call a local helper:

```typescript
function bumpTracker(date: string, field: keyof DateFailureEntry['byDimension']): void {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const existing = trackerDelta.get(date);

  // No entry OR window expired → fresh start
  if (!existing || (now - new Date(existing.windowStartedAt).getTime()) > CROSS_POLL_WINDOW_MS) {
    trackerDelta.set(date, {
      windowStartedAt: nowIso,
      totalCount: 1,
      byDimension: { [field]: 1 },
      lastFailureAt: nowIso,
    });
    return;
  }

  // Increment existing entry
  const updated: DateFailureEntry = {
    ...existing,
    totalCount: existing.totalCount + 1,
    byDimension: { ...existing.byDimension, [field]: (existing.byDimension[field] ?? 0) + 1 },
    lastFailureAt: nowIso,
  };
  if (updated.totalCount >= CROSS_POLL_THRESHOLD && !updated.blockedUntil) {
    updated.blockedUntil = new Date(now + CROSS_POLL_BLOCK_MS).toISOString();
  }
  trackerDelta.set(date, updated);
}
```

**Final aggregation (around line 912):**

```typescript
const newlyBlockedDates: string[] = [];
for (const [date, entry] of trackerDelta) {
  if (entry.totalCount >= CROSS_POLL_THRESHOLD && !falsePositiveDates.has(date)) {
    newlyBlockedDates.push(date);
  }
}
```

**The 5 terminal return sites** that must add the new fields:

| Return site | Add fields? |
|-------------|-------------|
| 137 (`dryRun`) | No |
| 158 (`bot_not_found`) | No — no increments yet |
| 172 (`race_condition_stale_data`) | No — no increments yet |
| 390-391 (`max_reschedules_reached` branch A) | **Yes** |
| 582-583 (`max_reschedules_reached` branch B) | **Yes** |
| 957 (`portal_reversion`) | **Yes** |
| 992 (post-secured return) | **Yes** |
| 1013 (`all_candidates_failed`) | **Yes** |

Append at each terminal return:
```typescript
dateFailureTrackingDelta: trackerDelta.size > 0 ? Object.fromEntries(trackerDelta) : undefined,
newlyBlockedDates: newlyBlockedDates.length > 0 ? newlyBlockedDates : undefined,
```

### 3. `src/trigger/poll-visa.ts:864-937` — orchestration

**Line 866-867 (after lazy load)** — prune tracker before passing in:

```typescript
const cacheData = cacheRow?.casCacheJson as CasCacheData | null;
const nowMs = Date.now();

// NEW: prune dateFailureTracking
//   (a) drop entries whose date is NOT in allDays (TRACK-04 reset)
//   (b) drop entries whose window expired (>1h since windowStartedAt AND not currently blocked)
const allDayDates = new Set(allDays.map(d => d.date));
const rawTracker = cacheData?.dateFailureTracking ?? {};
const CROSS_POLL_WINDOW_MS = 60 * 60 * 1000;
const prunedTracker: Record<string, DateFailureEntry> = {};
for (const [date, entry] of Object.entries(rawTracker)) {
  if (!allDayDates.has(date)) continue;  // TRACK-04: disappeared from portal
  // Keep if currently blocked (to preserve blockedUntil)
  if (entry.blockedUntil && new Date(entry.blockedUntil).getTime() > nowMs) {
    prunedTracker[date] = entry;
    continue;
  }
  // Keep if window still open
  if (nowMs - new Date(entry.windowStartedAt).getTime() <= CROSS_POLL_WINDOW_MS) {
    prunedTracker[date] = entry;
  }
}
```

**Line 874 (blockedDateSet construction)** — extend to include cross-poll blocks:

```typescript
const blockedDateSet = new Set<string>(Object.keys(activeBlocked));
// NEW: add dates with an active cross-poll block
for (const [date, entry] of Object.entries(prunedTracker)) {
  if (entry.blockedUntil && new Date(entry.blockedUntil).getTime() > nowMs) {
    blockedDateSet.add(date);
  }
}
```

**Line 884** — pass pruned tracker into executeReschedule:

```typescript
const result = await executeReschedule({
  ...,
  casCacheJson: cacheData ? { ...cacheData, dateFailureTracking: prunedTracker } : null,
  ...
});
```

**Line 904-937** — extend block-write to handle newlyBlockedDates + always persist tracker delta:

```typescript
if (!result.success) {
  // ... existing noCasDates/fpDates/rfDates blocks ...

  // NEW: cross-poll newly blocked → 2h
  const newlyBlocked = result.newlyBlockedDates ?? [];
  if (newlyBlocked.length > 0) {
    const blockUntil2h = new Date(nowMs + 2 * 60 * 60 * 1000).toISOString();
    for (const d of newlyBlocked) {
      if (!updatedBlocked[d] || new Date(updatedBlocked[d]!).getTime() < new Date(blockUntil2h).getTime()) {
        updatedBlocked[d] = blockUntil2h;
      }
    }
    logger.info('cross-poll tracker: blocked dates after threshold', {
      botId, dates: newlyBlocked, until: blockUntil2h,
    });
  }
}

// NEW: persist tracker delta (on success AND failure — increments can happen before a later success)
if (result.dateFailureTrackingDelta) {
  pending.push(
    db.execute(sql`UPDATE bots SET cas_cache_json = jsonb_set(COALESCE(cas_cache_json,'{}'), '{dateFailureTracking}', ${JSON.stringify(result.dateFailureTrackingDelta)}::jsonb) WHERE id = ${botId}`)
      .catch(e => logger.warn('dateFailureTracking write failed', { botId, error: String(e) })),
  );
}
```

**Critical:** tracker persist is OUTSIDE the `if (!result.success)` block.

### 4. `src/services/__tests__/reschedule-cas-cache.test.ts` — new test cases

Mirror existing `repeatedlyFailingDates` patterns. New cases:

1. **Increments populate delta** — 3 candidate dates each get `no_times` → delta has 3 entries with `totalCount: 1`, `byDimension.consularNoTimes: 1`, `blockedUntil: undefined`.
2. **Cross-call accumulation** — seed `casCacheJson.dateFailureTracking` with `{ '2026-06-15': { totalCount: 4, ... } }`, run call that increments once → `newlyBlockedDates: ['2026-06-15']`.
3. **Window expiry inside `executeReschedule`** — seed with `windowStartedAt: 2h ago, totalCount: 4` → after one increment, `totalCount: 1` (window restarted), NOT 5.
4. **`session_expired` does NOT bump tracker** — verifies PROJECT.md out-of-scope rule.
5. **`falsePositiveDates` exclusion** — date in falsePositiveDates is NOT in newlyBlockedDates even at threshold.

**Reset on disappearance test** — lives at poll-visa level (executeReschedule doesn't have `allDays`). Add to a poll-visa unit test or create new file.

## Build order

1. **`src/db/schema.ts`** — add `DateFailureEntry` + extend `CasCacheData`. No migration (jsonb).
2. **`src/services/reschedule-logic.ts`** — extend `RescheduleResult`, add `trackerDelta` + `bumpTracker`, wire 3 increment sites, aggregation, 5 terminal return updates.
3. **`src/services/__tests__/reschedule-cas-cache.test.ts`** — write tests 1-5 BEFORE wiring poll-visa (catches semantic bugs in pure function first).
4. **`src/trigger/poll-visa.ts:864-937`** — prune tracker, extend blockedDateSet, pass to executeReschedule, persist delta outside `!success` guard, add newlyBlockedDates to updatedBlocked.
5. **Manual smoke test** — `npm test` then trigger a poll on bot 6 (has live `no_times` history per PROJECT.md).
6. **Deploy** — `npm run deploy:rpi` then `mcp__trigger__deploy environment=prod`.

## Key invariants preserved

- **`isAtLeastNDaysEarlier` is upstream of executeReschedule** — tracker can only block dates that were already strict-improvement candidates. No risk of blocking current date.
- **`blockedConsularDates` shape unchanged** — newlyBlockedDates written into same record via existing dominance guard at `poll-visa.ts:926`.
- **`casCacheJson` remains read-only inside executeReschedule** — input snapshot is shallow-cloned, never mutated.
- **Lazy-load optimization preserved** — single SELECT at line 865, no new DB roundtrips.
- **Backwards compat** — bots without `dateFailureTracking` get `prunedTracker = {}`, no-op until first failure.
- **Single-writer per bot** — `activeRunId` + `cancelPreviousRun` prevent concurrent writes.

## Source references

- `.planning/PROJECT.md` — TRACK-01..06 requirements, scope decisions
- `src/services/reschedule-logic.ts:51-65` — RescheduleResult interface
- `src/services/reschedule-logic.ts:218-220` — per-call dateFailureCount init
- `src/services/reschedule-logic.ts:378,593,617` — the 3 tracked increment sites
- `src/services/reschedule-logic.ts:912-915` — repeatedlyFailingDates aggregation pattern
- `src/trigger/poll-visa.ts:864-937` — orchestration block (lazy load, filter, execute, persist)
- `src/db/schema.ts:38-52` — CasCacheData interface to extend
- `src/services/__tests__/reschedule-cas-cache.test.ts` — test patterns to mirror

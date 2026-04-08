---
phase: quick
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/services/reschedule-logic.ts
  - src/trigger/poll-visa.ts
  - src/services/__tests__/reschedule-cas-cache.test.ts
autonomous: true
requirements: [COOLDOWN-01]
must_haves:
  truths:
    - "Consular dates with 3+ failures of any type within a single executeReschedule call are returned in a new repeatedlyFailingDates field"
    - "poll-visa.ts persists repeatedlyFailingDates to blockedConsularDates with 1h TTL"
    - "Existing falsePositiveDates (2h TTL) and no_cas_days (30m TTL) blocking still works unchanged"
  artifacts:
    - path: "src/services/reschedule-logic.ts"
      provides: "Per-date failure counter and repeatedlyFailingDates return field"
      contains: "repeatedlyFailingDates"
    - path: "src/trigger/poll-visa.ts"
      provides: "1h TTL blocking for repeatedlyFailingDates"
      contains: "repeatedlyFailingDates"
  key_links:
    - from: "src/services/reschedule-logic.ts"
      to: "src/trigger/poll-visa.ts"
      via: "RescheduleResult.repeatedlyFailingDates"
      pattern: "repeatedlyFailingDates"
---

<objective>
Add a per-date failure counter inside `executeReschedule` that tracks failures of ANY type (no_times, no_cas_days, no_cas_times, post_failed, fetch_error, etc.) for each consular date within a single invocation. When a date accumulates 3+ failures, return it in a new `repeatedlyFailingDates` field on `RescheduleResult`. poll-visa.ts then persists these to `blockedConsularDates` with a 1h TTL.

Purpose: Prevent aggressive retry loops on dates that are clearly not working right now, complementing the existing `exhaustedDates` mechanism which waits for ALL times to fail.
Output: Updated reschedule-logic.ts with per-date counter, updated poll-visa.ts to persist 1h blocks, updated tests.
</objective>

<execution_context>
@/Users/juanortega/.claude/get-shit-done/workflows/execute-plan.md
@/Users/juanortega/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/services/reschedule-logic.ts
@src/trigger/poll-visa.ts
@src/services/__tests__/reschedule-cas-cache.test.ts

<interfaces>
From src/services/reschedule-logic.ts:
```typescript
export interface RescheduleResult {
  success: boolean;
  date?: string;
  consularTime?: string;
  casDate?: string;
  casTime?: string;
  reason?: string;
  totalDurationMs?: number;
  attempts?: RescheduleAttempt[];
  falsePositiveDates?: string[];  // existing — 2h TTL
}

export interface RescheduleAttempt {
  date: string;
  consularTime?: string;
  casDate?: string;
  casTime?: string;
  failReason: 'no_times' | 'no_cas_days' | 'no_cas_times' | 'no_cas_times_cached' | 'post_failed' | 'post_error' | 'fetch_error' | 'session_expired' | 'verification_failed';
  failStep?: string;
  error?: string;
  cause?: string;
  durationMs: number;
}
```

Existing internal state in executeReschedule (line ~215-217):
```typescript
const exhaustedDates = new Set<string>();
const falsePositiveDates = new Set<string>();
const transientFailCount = new Map<string, number>();
```

From src/trigger/poll-visa.ts (line ~865-888) — existing blocking logic:
```typescript
// Block consular dates that had no_cas_days for 30 min
// Also block false-positive dates for 2h
if (!result.success) {
  const noCasDates = [...new Set(
    (result.attempts ?? []).filter(a => a.failReason === 'no_cas_days').map(a => a.date),
  )];
  const fpDates = result.falsePositiveDates ?? [];
  // ... writes to blockedConsularDates via jsonb_set
}
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add per-date failure counter in executeReschedule and return repeatedlyFailingDates</name>
  <files>src/services/reschedule-logic.ts, src/services/__tests__/reschedule-cas-cache.test.ts</files>
  <behavior>
    - Test: When a date accumulates 3+ failed attempts (any failReason) within one executeReschedule call, it appears in result.repeatedlyFailingDates
    - Test: When a date has fewer than 3 failures, it does NOT appear in repeatedlyFailingDates
    - Test: Dates already in falsePositiveDates are not duplicated in repeatedlyFailingDates
    - Test: A mix of different failReasons (no_times, no_cas_times, fetch_error) all count toward the same per-date counter
  </behavior>
  <action>
1. In `RescheduleResult` interface (line ~51), add:
   ```typescript
   /** Dates with 3+ failures of any type in this call — caller should block for 1h. */
   repeatedlyFailingDates?: string[];
   ```

2. Inside `executeReschedule`, after the existing `transientFailCount` declaration (line ~217), add a new Map:
   ```typescript
   const dateFailureCount = new Map<string, number>(); // total failures per date (any type)
   const REPEATEDLY_FAILING_THRESHOLD = 3;
   ```

3. Increment `dateFailureCount` every time a `failedAttempts.push(...)` is called for any failReason. There are multiple push sites in the function — each one that pushes a failed attempt with a `date` field should also increment:
   ```typescript
   dateFailureCount.set(candidate.date, (dateFailureCount.get(candidate.date) ?? 0) + 1);
   ```
   
   The key push sites to instrument (search for `failedAttempts.push`):
   - Line ~373: `failReason: 'no_times'`
   - Line ~433: `failReason: 'verification_failed'` (non-CAS path)
   - Line ~503 area: implicit all-times-failed (already adds to exhaustedDates)
   - Line ~658: `failReason: 'verification_failed'` (CAS path)
   - Line ~870: `failReason: 'session_expired'`
   - Line ~881-888: `failReason: 'post_error' | 'fetch_error'`
   
   Note: Do NOT increment for `no_cas_times_cached` since that's a cache issue that gets retried with fresh API data (the existing `transientFailCount` handles that).

4. Build the `repeatedlyFailingDates` set at the end (before return statements). After line ~895 (after the main loop), compute:
   ```typescript
   const repeatedlyFailingDates = new Set<string>();
   for (const [date, count] of dateFailureCount) {
     if (count >= REPEATEDLY_FAILING_THRESHOLD && !falsePositiveDates.has(date)) {
       repeatedlyFailingDates.add(date);
     }
   }
   ```

5. Add `repeatedlyFailingDates` to ALL return statements that already include `falsePositiveDates`. There are ~6 return sites — each should add:
   ```typescript
   repeatedlyFailingDates: repeatedlyFailingDates.size > 0 ? [...repeatedlyFailingDates] : undefined,
   ```

6. Add tests in `src/services/__tests__/reschedule-cas-cache.test.ts` (or a new test file if cleaner) that mock scenarios where the same date fails 3+ times across different time slots and verify `repeatedlyFailingDates` is populated.
  </action>
  <verify>
    <automated>cd /Users/juanortega/visa-scraper && npx vitest run src/services/__tests__/reschedule-cas-cache.test.ts --reporter=verbose 2>&1 | tail -30</automated>
  </verify>
  <done>RescheduleResult.repeatedlyFailingDates is populated when any date has 3+ failures of any type within a single executeReschedule call. All existing tests pass.</done>
</task>

<task type="auto">
  <name>Task 2: Persist repeatedlyFailingDates to blockedConsularDates with 1h TTL in poll-visa.ts</name>
  <files>src/trigger/poll-visa.ts</files>
  <action>
In poll-visa.ts, in the existing blocking logic block (line ~865-888), add handling for `repeatedlyFailingDates` alongside the existing `noCasDates` and `fpDates` handling.

After the `fpDates` block (line ~882), add:
```typescript
const rfDates = result.repeatedlyFailingDates ?? [];
if (rfDates.length > 0) {
  const blockUntil1h = new Date(nowMs + 60 * 60 * 1000).toISOString();
  for (const d of rfDates) {
    // Don't overwrite longer blocks (fp = 2h > rf = 1h)
    if (!updatedBlocked[d] || new Date(updatedBlocked[d]).getTime() < new Date(blockUntil1h).getTime()) {
      updatedBlocked[d] = blockUntil1h;
    }
  }
  logger.info('CAS blocker: blocked dates after repeated failures', { botId, dates: rfDates, until: blockUntil1h });
}
```

Also update the guard condition (line ~872) to include rfDates:
```typescript
if (noCasDates.length > 0 || fpDates.length > 0 || rfDates.length > 0) {
```

This ensures:
- 1h TTL for repeatedly-failing dates (shorter than 2h for false positives, longer than 30m for no_cas_days)
- Longer existing blocks are NOT overwritten (a 2h false-positive block stays 2h)
- The DB write only fires if there's at least one date to block
  </action>
  <verify>
    <automated>cd /Users/juanortega/visa-scraper && npx vitest run --reporter=verbose 2>&1 | tail -20</automated>
  </verify>
  <done>poll-visa.ts persists repeatedlyFailingDates to blockedConsularDates with 1h TTL. Existing no_cas_days (30m) and falsePositiveDates (2h) blocking unchanged. All tests pass.</done>
</task>

</tasks>

<verification>
1. `npm test` passes with no regressions
2. TypeScript compiles: `npx tsc --noEmit`
3. Manual review: grep for `repeatedlyFailingDates` appears in both reschedule-logic.ts and poll-visa.ts
</verification>

<success_criteria>
- Dates with 3+ failures of any type within a single executeReschedule call are returned in `repeatedlyFailingDates`
- poll-visa.ts blocks those dates in `blockedConsularDates` for 1h
- Existing blocking mechanisms (no_cas_days 30m, falsePositiveDates 2h) are untouched
- All tests pass
</success_criteria>

<output>
After completion, create `.planning/quick/260403-gpj-add-1h-cooldown-for-repeatedly-failing-r/260403-gpj-SUMMARY.md`
</output>

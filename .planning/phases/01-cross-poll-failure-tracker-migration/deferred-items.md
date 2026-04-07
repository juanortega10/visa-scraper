# Deferred Items — Phase 01 Cross-Poll Failure Tracker

Out-of-scope issues discovered during execution but NOT fixed (per Rule "scope boundary").

## Pre-existing TypeScript errors (discovered Task 1, 2026-04-07)

`npx tsc --noEmit` reports ~25 errors in files unrelated to this phase:

- `src/services/__tests__/login.test.ts` — `LoginCredentials` shape drift (missing `scheduleId`, `applicantIds`)
- `src/services/__tests__/visa-client-reschedule.test.ts` — `Object is possibly 'undefined'` (strict null checks)
- `src/services/login.ts` — Unused `@ts-expect-error` directives + possibly-undefined indexing
- `src/services/visa-client.ts:58` — `ProxyFetchMeta` missing fields
- `src/trigger/poll-visa.ts:1288,1305,1320` — `string | undefined` not assignable
- `src/trigger/prefetch-cas.test.ts:115` — Tuple iterator issue

None of these touch `src/db/schema.ts`, `dateFailureTracking`, `DateFailureEntry`, or `FailureDimension`. They predate this phase and are unrelated to the tracker migration. Verified via `grep -E "(schema\.ts|dateFailureTracking|DateFailureEntry|FailureDimension)"` against the tsc output → zero matches.

**Decision:** Do NOT fix in this phase. Track here so they don't get re-discovered every plan.

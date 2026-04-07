# Codebase Concerns

**Analysis Date:** 2026-04-06

## Tech Debt

### Legacy scout/subscriber architecture columns in schema

**Issue:** `bots.isScout` and `bots.isSubscriber` columns exist in the database schema but are no longer read or written by the codebase. The scout/subscriber dispatch architecture was removed on 2026-03-05, but the schema columns remain.

- **Files:** `src/db/schema.ts` (lines 74-75), `src/trigger/poll-cron.ts` (line 17), `src/api/bots-me.test.ts` (multiple lines)
- **Impact:** Adds confusion during code review. Schema bloat. Tests mock these fields unnecessarily.
- **Fix approach:** Create a migration to remove `isScout` and `isSubscriber` columns after confirming no external dependencies reference them. Update tests to stop mocking these fields.

### dispatch_logs table no longer written

**Issue:** The `dispatch_logs` table (lines 246-265 in `src/db/schema.ts`) is historical only — no new rows are being written since the scout/subscriber system was removed. The `dispatchLogId` foreign key on `reschedule_logs` (line 221) is now orphaned.

- **Files:** `src/db/schema.ts`, `src/api/logs.ts` (line 502-510 references it for historical queries)
- **Impact:** Stale code paths for querying dispatch_logs still exist. Risk of accidental writes if code is copy-pasted from older patterns.
- **Fix approach:** Mark table as deprecated in a migration. Keep for historical data only. Remove the `dispatchLogId` foreign key from `reschedule_logs` if no longer used, or document why it's kept for hybrid queries.

### Webshare proxy pool persistence via temp files

**Issue:** Webshare proxy URL list is cached to `/tmp/.proxy-pool-state.json` and `/tmp/webshare-proxy-cache.json` with 12h TTL. This works across process forks (Trigger.dev dev mode runs each task in a child process) but has race conditions if multiple processes update simultaneously.

- **Files:** `src/services/proxy-fetch.ts` (lines 45-83, 88-118)
- **Impact:** Under concurrent writes, the cache file could be corrupted. No locking mechanism exists. If Webshare API fails, the stale cache is used fail-open, but age is not validated beyond the hardcoded 12h window.
- **Fix approach:** Add a file lock mechanism (e.g., `proper-lockfile` package) around cache reads/writes. Or migrate to in-memory cache with explicit sync points (if workers are truly ephemeral). Add validation that stale cache is not older than some reasonable threshold (e.g., 24h before warning).

---

## Known Bugs

### Portal propagation delay can overwrite recently booked appointment (FIXED in 2026-04-03)

**Issue (historical):** After a successful reschedule POST, the next poll could read the portal before it propagated the new appointment, overwriting `currentConsularDate` back to the old (worse) date.

- **Files:** `src/trigger/poll-visa.ts` (line 705-719)
- **Trigger:** Rare, but happens under high latency / slow portal sync (~1-2 min propagation delay)
- **Fix deployed:** Added "recent reschedule check" — if a `reschedule_log` exists within last 2 minutes with `success=true`, consular date fields are skipped on next poll. CAS fields still sync independently.
- **Monitoring:** Dashboard badges now only render when `reschedule_logs.newDate === bots.currentConsularDate`.

### Ghost slots (false_positive_verification) caused infinite retry loops (FIXED in 2026-04-03)

**Issue (historical):** `exhaustedDates` was a local `Set` inside `executeReschedule()` and not persisted between polls. Dates failing with `false_positive_verification` (slot taken by another user) were retried every 30s.

- **Files:** `src/services/reschedule-logic.ts`, `src/trigger/poll-visa.ts`
- **Trigger:** Phantom slots that briefly appear then disappear (another bot books them in <10s)
- **Fix deployed:** False-positive dates now written to `casCacheJson.blockedConsularDates` with 2h TTL. Repeatedly-failing dates (3+ failures of any type) blocked for 1h TTL.
- **Testing:** 4 new tests added in `src/services/__tests__/reschedule-cas-cache.test.ts` to verify repeatedlyFailingDates logic.

### Portal reversion not logged when "secure then improve" fails (FIXED in 2026-04-03)

**Issue (historical):** When the second POST (after a successful first POST) caused the portal to revert the just-booked appointment, the event was silent — no `reschedule_log` row created.

- **Files:** `src/services/reschedule-logic.ts` (CAS path, second POST attempt after securing)
- **Trigger:** Rare, requires specific timing: first POST succeeds, verification passes, but second POST causes portal to drop the appointment
- **Fix deployed:** Now writes `success=false, error='portal_reversion'` row to `reschedule_logs`, making reversions visible in history.

---

## Security Considerations

### Session cookie must remain URL-encoded

**Risk:** Cookie `_yatri_session` rotates on every response but the **original stays valid**. The cookie is URL-encoded as received from `Set-Cookie` header. If decoded with `decodeURIComponent()`, the `+`, `/`, `=` characters are corrupted, causing **401 Unauthorized** on subsequent requests even though the session is still valid server-side.

- **Files:** `src/services/login.ts` (line 170 comment documents this), `src/services/visa-client.ts` (cookie storage/retrieval)
- **Current mitigation:** Code keeps cookies raw from `Set-Cookie`, never decodes.
- **Recommendations:** 
  - Add test for cookie persistence across requests to catch any future decoding bugs.
  - Document in login.ts and visa-client.ts with prominent comments.
  - Do NOT use `decodeURIComponent()` on cookie values anywhere.

### Authenticity token is session-bound (Rails CSRF)

**Risk:** The `authenticity_token` is bound to a specific server-side session. If `performLogin()` doesn't properly prime server-side state, POST reschedule returns `302 → /sign_in` even though GETs work fine.

- **Files:** `src/services/login.ts` (lines 150-175), `src/services/reschedule-logic.ts` (lines 199-201, 238-254)
- **Current mitigation:** `refreshTokens()` is called before any POST reschedule using `redirect: 'manual'` (not `'follow'`), which properly primes session state. Also called after every re-login.
- **Recommendations:**
  - Document this in CLAUDE.md (done — lines 165-176)
  - Test cross-schedule token swap to confirm tokens aren't portable (validated 2026-02-15)
  - Never remove the `refreshTokens()` call before POST or after mid-reschedule re-login — this is not a nice-to-have.

### POST reschedule requires direct proxy (no Bright Data)

**Risk:** Bright Data proxy returns **HTTP 402 Payment Required** for all POST requests. Only GET is supported. This would silently fail reschedule attempts if proxy provider is misconfigured.

- **Files:** `src/services/reschedule-logic.ts` (POST is always direct via `client.reschedule()`)
- **Current mitigation:** The visa-client uses `proxyFetch()` which respects the bot's `proxyProvider`, but the reschedule POST is structured to work with any provider. Webshare POST works fine. Direct POST works fine.
- **Recommendations:**
  - Add explicit check in `executeReschedule()` if `bot.proxyProvider === 'brightdata'` — log a warning or fallback to direct for POST.
  - Document in CLAUDE.md (done — line 186).

### Credentials encryption uses AES-256-GCM but keys are not rotated

**Risk:** Encryption key is loaded from `DATABASE_URL` passphrase or environment. No key rotation mechanism exists. If the key is compromised, all historical encrypted credentials can be decrypted.

- **Files:** `src/services/encryption.ts` (full encryption/decryption logic)
- **Impact:** Affects all `visaEmail`, `visaPassword`, and `yatriCookie` in the database.
- **Recommendations:**
  - Implement key versioning: store keyVersion in the encrypted blob so old keys can be phased out.
  - Add a migration command to re-encrypt all credentials with a new key.
  - Audit access to the encryption key (should be secret-only, no hardcoding).

---

## Performance Bottlenecks

### Poll-visa.ts is 1812 lines — complex chaining logic hard to test

**Problem:** `src/trigger/poll-visa.ts` is the codebase's largest file and contains:
- Cron vs self-trigger hybrid logic
- Batch loop with 90s budget
- TCP backoff logic (3-tier: normalDelay → 10m → 30m)
- Inline reschedule integration
- Super-critical and burst phase logic
- Session management (pre-emptive re-login, TTL check)

- **Files:** `src/trigger/poll-visa.ts` (1812 lines)
- **Cause:** Multiple concerns mixed in a single task handler. The file grew incrementally as features were bolted on (reschedule, backoffs, CAS cache, phase logic).
- **Impact:** Hard to test in isolation. Small changes risk breaking chaining logic. Code review is cognitive overload.
- **Improvement path:**
  - Extract the batch loop (lines ~750-1190) into a separate `executePollBatch()` function in `src/services/`.
  - Extract the self-trigger logic (lines ~1171-1220) into `src/services/trigger-chain.ts`.
  - Extract session/login management into a `SessionManager` class.
  - Test the batch loop against mock VisaClient, not the full task.

### Reschedule-logic.ts has overlapping retry tracking (exhaustedDates, transientFailCount, dateFailureCount)

**Problem:** Three separate tracking mechanisms for failed dates:
- `exhaustedDates`: Set of dates with no times available (added once, never leaves)
- `transientFailCount`: Map of dates with <2 transient failures (cache misses, temp network errors)
- `dateFailureCount`: Map of dates with 3+ failures of any type (new in 2026-04-03)

These are not clearly separated in purpose, and callers must understand all three to predict behavior.

- **Files:** `src/services/reschedule-logic.ts` (lines 217-221, 378, 440, etc.)
- **Impact:** Code clarity. If a new failure type is added, must remember to increment `dateFailureCount` AND check `exhaustedDates` filter.
- **Improvement path:**
  - Consolidate into a single `FailureTracker` class with methods:
    - `.markTransientFailure(date, reason)` → increments count, returns true if threshold reached
    - `.markPermanentFailure(date, reason)` → adds to exhausted set
    - `.shouldAttempt(date)` → checks all constraints
  - Hides implementation details from main loop.

### Inline reschedule in poll-visa.ts slows down each poll by ~1-3s

**Problem:** Each poll now attempts to reschedule if dates improve. This adds latency (parallel CAS fetches, POST attempts) to a task that should be minimal for monitoring.

- **Files:** `src/trigger/poll-visa.ts` (lines ~770-1045)
- **Impact:** Increases compute cost and latency. Reduces poll frequency (fewer polls fit in 90s batch).
- **Trade-off:** Reschedule inline vs. on-demand via separate task.
- **Current design rationale (from CLAUDE.md line 64):** Inline reschedule ensures reschedule happens within 2 min of dates appearing (CAS cache is 30min TTL). Separate task would have staleness.
- **Improvement path (future):**
  - Make inline reschedule optional via bot config (`inlineReschedule: boolean` defaulting to `true`).
  - For low-priority bots, disable inline reschedule to save compute.
  - Keep enabled for high-priority (Peru, super-critical).

### CAS cache parallel fetches can stall the batch loop

**Problem:** In `executeReschedule()` CAS path, parallel CAS fetches are attempted for all consular times at once (Promise.all, line 539). If one fetch hangs (TCP block from webshare pool), the entire batch loop stalls waiting for >5min heartbeat timeout.

- **Files:** `src/services/reschedule-logic.ts` (lines 539-544)
- **Trigger:** Webshare proxy pool instability (documented 2026-02-20 in MEMORY.md)
- **Current workaround:** Fallback to stale CAS cache if fresh fetch fails.
- **Improvement path:**
  - Add timeout wrapper around `Promise.all()` for CAS fetches — 5s timeout per fetch, then fallback to stale cache.
  - Log timeout separately to identify proxy instability.
  - Consider sequential CAS fetches (slower but predictable) vs. concurrent (faster but stall risk).

---

## Fragile Areas

### Session age check at 44 min has off-by-one edge case with hard TTL (~88 min)

**Problem:** Session hard TTL is ~1h 28min (88 min). Pre-emptive re-login is triggered at 44 min (half TTL). But if a poll takes 30s and the session is at 43:50, the re-login check passes, but by the time the POST executes, the session may be at 44:30 (close to cutoff). No additional safeguard exists.

- **Files:** `src/trigger/poll-visa.ts` (line 287 comment: "Pre-emptive re-login: refresh session before the ~88min hard TTL")
- **Trigger:** Rare, but under high load with many polls queued.
- **Safe modification:**
  - Consider moving the cutoff to 35 min (2.5x safety margin).
  - Or refresh tokens immediately after successful reschedule POST (to reset the clock).

### TCP block backoff uses sustained count from last 5 polls, but count includes current poll

**Problem:** `sustainedTcpBlockCount` is computed from the latest 5 `poll_logs` rows (line 1093-1100). The backoff tier depends on this count:
- 0-2: normal delay
- 3-4: 10 min backoff
- 5+: 30 min backoff

But the count INCLUDES the current poll (just logged). So if 2 polls were blocked and this is the 3rd, it triggers 10-min backoff immediately. No grace period.

- **Files:** `src/trigger/poll-visa.ts` (lines 1084-1100, 1197-1204)
- **Trigger:** Network hiccup causing 3 consecutive polls to fail (unlikely but possible during embassy outage).
- **Current behavior:** Aggressive backoff is intentional — embassy detected a sustained block, so stop hammering.
- **Safe modification:**
  - Document the inclusive counting in code comment.
  - If false positives are seen (backoffs triggered on single network glitch), change to exclude the current poll from the count.

### Race condition guard in executeReschedule reads currentConsularDate once (line 151)

**Problem:** The race condition guard re-reads `currentConsularDate` from DB to catch cases where another worker already rescheduled to a better date. But it only compares the **single pre-fetched date**, not the entire candidate list. If another worker reschedules to a date that's even better than our pre-fetched date, we don't detect it.

- **Files:** `src/services/reschedule-logic.ts` (lines 148-174)
- **Trigger:** Two workers polling simultaneously, both see the same top 10 dates, worker A books date #1, worker B also picks date #1 but our guard only checks against the stale DB value.
- **Current behavior:** Worker B's POST will fail (slot taken), then retries find alternative dates.
- **Safe modification:**
  - If this becomes a real problem, re-check the full candidate list (`isAtLeastNDaysEarlier(candidate, freshCurrentDate)`) before each POST, not just the first one.
  - Or use a distributed lock (Redis, Postgres advisory lock) to prevent concurrent reschedule attempts on the same schedule.

---

## Scaling Limits

### Single CAS cache per bot (60 min TTL, 21-day window) scales poorly with multi-schedule families

**Problem:** Each bot stores a single `casCacheJson` blob with CAS availability for one consular facility. If a family account has 4 bots pointing to the same facility (different applicants), each bot's cache is independent. No sharing of CAS prefetch data.

- **Files:** `src/db/schema.ts` (line 82), `src/trigger/prefetch-cas.ts` (caches per-bot)
- **Impact:** 4 bots = 4 separate prefetch tasks, 4 cache updates. Redundant API calls to Webshare/embassy.
- **Improvement path (future):**
  - Create a facility-level cache: `facility_cas_cache` table indexed by `(facility_id, locale)`.
  - Prefetch task updates facility cache, all bots read from shared cache with per-bot TTL overrides.
  - Requires schema migration and refactoring of `prefetch-cas.ts` logic.

### Batch loop 90s budget leaves only ~5-7 polls per run

**Problem:** `BATCH_BUDGET_MS = 90s` (line 1132), inter-poll delay ~10s (7s + jitter), gives ~7-8 polls max per batch. Each poll takes ~1-2s without reschedule, ~3-5s with reschedule. Budget is tight.

- **Files:** `src/trigger/poll-visa.ts` (line 1130-1134)
- **Current polling rate:** ~5 polls/min (one poll per 10s, but batch only runs once every 2 min cron + batch overhead).
- **Scaling issue:** If reschedule latency increases (e.g., slow CAS API), polls per batch drops further.
- **Improvement path:**
  - Make batch budget configurable per bot (`targetPollsPerMin` → adjust budget accordingly).
  - Or split reschedule into separate task (loses 2-min latency but unburdened polling).

### Trigger.dev queue `visa-polling-per-bot` lacks explicit concurrency limit

**Problem:** Queue is defined in `src/trigger/queues.ts` but the concurrency limit is not enforced at the queue level. Depends on Trigger.dev plan limits.

- **Files:** `src/trigger/queues.ts`, `src/api/bots.ts` (uses queue string `'visa-polling-per-bot'`)
- **Impact:** Unknown max concurrency. If many bots are polled simultaneously, Trigger.dev may queue them indefinitely.
- **Recommendations:**
  - Define queue with explicit `concurrencyLimit` in queues.ts.
  - Monitor queue depth and latency in dashboard.
  - Set up alerts if queue backlog exceeds threshold.

---

## Dependencies at Risk

### Webshare proxy pool state cached in /tmp — survives process restart but not server restart

**Risk:** Webshare proxy list is cached in `/tmp/webshare-proxy-cache.json` with 12h TTL. If the RPi reboots, the cache is lost. The next poll will re-fetch from Webshare API, but during the window before API response, no proxy list is available.

- **Files:** `src/services/proxy-fetch.ts` (lines 45-83)
- **Current mitigation:** Fail-open behavior — if API fails, use stale cache. If cache is missing, fall back to `direct` provider.
- **Recommendations:**
  - Persist cache to a non-volatile location (e.g., `.webshare-proxy-cache.json` in project root, committed to git — but regenerated daily).
  - Or hard-code a fallback IP list (if Webshare IPs are stable).

### Bright Data proxy known to return 402 on POST — no automatic fallback

**Risk:** If `bot.proxyProvider === 'brightdata'` and reschedule is attempted, the POST will return 402. No automatic fallback to direct or Webshare exists.

- **Files:** `src/services/reschedule-logic.ts` (POST logic doesn't check proxy provider), `src/services/visa-client.ts` (POST uses configured provider)
- **Current mitigation:** CLAUDE.md line 186 documents this. Manual validation required before creating bot with Bright Data + reschedule enabled.
- **Recommendations:**
  - Add a check in `executeReschedule()`: if `proxyProvider === 'brightdata'`, force direct for POST only.
  - Or add a bot config flag `rescheduleProxyProvider` defaulting to `'direct'`.

---

## Missing Critical Features

### No metrics/alerting on poll latency or reschedule success rate

**Problem:** `poll_logs` and `reschedule_logs` tables exist, but no aggregation or alerting on trends. No dashboards for:
- Mean/p95 poll latency per bot
- Reschedule success rate (successful / attempted)
- CAS cache hit rate
- Session expiry rate

- **Impact:** Silent degradation. A bot's reschedule success could drop to 10% without alerting.
- **Recommendations:**
  - Add a periodic aggregation task (e.g., `analyze-poll-metrics` every 1h).
  - Write summary rows to a `bot_metrics` table with hour/day/week granularity.
  - Expose in dashboard with thresholds for alerting.

### No schema versioning or migration warnings

**Problem:** Schema changes are applied directly via `npm run db:push`. No migration safety checks, no version tracking, no ability to roll back if a migration fails.

- **Files:** `src/db/schema.ts`, migrations in `src/db/migrations/`
- **Impact:** Schema mismatches if workers run different versions. Manual rollback required on failure.
- **Recommendations:**
  - Use Drizzle migrations properly (check if already done).
  - Add a startup check in poll-visa.ts: verify schema version matches expected version.
  - Document rollback procedure for broken migrations.

### No manual re-trigger mechanism for stuck/dead chains

**Problem:** If `activeRunId` points to a stuck run (DEQUEUED >1h), there's no easy way to unstick it short of manual MCP commands.

- **Files:** `src/trigger/poll-visa.ts` (activeRunId tracking), `ensure-chain.ts` (runs Tuesdays 8:50-8:59 to resucita chains)
- **Current mitigation:** `ensure-chain` task (line 167) runs weekly to detect and re-trigger dead chains.
- **Recommendations:**
  - Add an endpoint `POST /api/bots/:id/retry-chain` for manual intervention.
  - Or extend `ensure-chain` to run more frequently (e.g., every 4 hours).

---

## Test Coverage Gaps

### Poll-visa task has no unit tests for chaining logic

**What's not tested:** 
- Self-trigger delay calculation (lines 1207-1210)
- Batch loop exit conditions (lines 1104-1147)
- TCP backoff tier selection (lines 1197-1204)
- Super-critical phase transitions

- **Files:** `src/trigger/poll-visa.ts` (no dedicated test file)
- **Risk:** Changes to chaining logic could break production without catching them. The only test is full integration via `npm run test`.
- **Priority:** HIGH — chaining is core to the system.
- **Fix approach:**
  - Extract chaining logic into `src/services/polling-chain.ts` with testable functions.
  - Add tests for `computeSelfTriggerDelay()`, `selectBackoffTier()`, etc.
  - Mock Trigger.dev tasks to test chain continuation.

### Proxy-fetch circuit breaker has no unit tests

**What's not tested:**
- EWMA health scoring (lines 188-220)
- Circuit breaker state transitions (closed → half_open → open)
- IP rotation on failure

- **Files:** `src/services/proxy-fetch.ts` (no test file)
- **Risk:** Subtle bugs in proxy failover logic could cause silent IP pool exhaustion.
- **Priority:** MEDIUM — relies on external proxy service.
- **Fix approach:**
  - Create `src/services/__tests__/proxy-fetch.test.ts`.
  - Mock Webshare API responses and network errors.
  - Test health scoring edge cases (e.g., all IPs have 50% error rate).

### CAS cache temporal filter logic not unit-tested

**What's not tested:**
- CAS date window filter (1-12 days before consular, line 520-527)
- Fallback to API if cache has no suitable dates
- Stale cache usage during TCP blocks

- **Files:** `src/services/reschedule-logic.ts` (cache logic embedded in executeReschedule)
- **Risk:** Off-by-one errors in date range checks could cause missed CAS slots.
- **Priority:** MEDIUM — CAS availability is critical for visas.
- **Fix approach:**
  - Add parametrized tests for date window edge cases.
  - Mock `prefetch-cas` cache entries and verify filter results.

---

*Concerns audit: 2026-04-06*

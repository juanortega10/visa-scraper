# Architecture

**Analysis Date:** 2026-04-06

## Pattern Overview

**Overall:** Event-driven polling + inline rescheduling with self-triggering task chains, multi-tenant architecture for monitoring and rescheduling US visa appointments.

**Key Characteristics:**
- Distributed cron (cloud/RPi dual) with self-healing chains for sub-minute polling
- Pure Node.js fetch-based login (no browser needed, ~970ms skipTokens)
- Inline reschedule within poll-visa task (shared `executeReschedule()` logic)
- Session + CSRF token management with encryption (AES-256-GCM)
- Proxy abstraction layer (direct, Bright Data, Webshare, Firecrawl)
- Trigger.dev v4 for task orchestration with queue-based concurrency control

## Layers

**API Layer:**
- Purpose: REST endpoints for bot management, logs, health checks
- Location: `src/api/`
- Contains: Hono routes (bots.ts, logs.ts, dev.ts, dashboard.ts, block-intelligence.ts)
- Depends on: DB (Drizzle), services (encryption, login validation), Trigger.dev tasks
- Used by: Frontend dashboard, external webhooks, CLI scripts

**Task/Worker Layer (Trigger.dev):**
- Purpose: Async job orchestration — polling, login, reschedule, notifications, prefetch
- Location: `src/trigger/`
- Contains: Core tasks (poll-visa.ts, poll-cron.ts, login-visa.ts, reschedule-visa.ts, prefetch-cas.ts), queues config
- Depends on: Services (visa-client, reschedule-logic, scheduling), DB, notifications
- Used by: Cron schedules, self-triggering chains, API triggers, manual CLI scripts

**Service Layer:**
- Purpose: Business logic — visa fetching, login, rescheduling, scheduling decisions, proxy management
- Location: `src/services/`
- Contains: 
  - `visa-client.ts` — HTTP client for ais.usvisa-info.com (fetch days, times, reschedule)
  - `login.ts` — Pure fetch login (CSRF flow, session tokens, cred validation)
  - `reschedule-logic.ts` — Multi-date retry logic, CAS filtering, POST execution
  - `scheduling.ts` — Polling delays, drop windows, priority calculation, super-critical window detection
  - `proxy-fetch.ts` — Proxy pool manager (Webshare rotation, circuit breaker, IP selection)
  - `notifications.ts` — Email (Resend) + webhook delivery with HMAC signing
  - `html-parsers.ts` — DOM extraction (appointments, facility IDs, token parsing)
  - `encryption.ts` — AES-256-GCM for creds and sessions
- Depends on: DB, external APIs (Resend, Webshare, Trigger.dev logger)
- Used by: Tasks, API endpoints

**Database Layer:**
- Purpose: Persistent state — bots, sessions, logs, exclusions, CAS cache
- Location: `src/db/`
- Contains: Drizzle ORM schema (schema.ts), Neon PostgreSQL client (client.ts)
- Schema tables: bots, sessions, excludedDates, excludedTimes, pollLogs, rescheduleLogs, casPrefetchLogs, authLogs, banEpisodes, notificationLogs
- Depends on: Neon PostgreSQL
- Used by: All tasks, all API endpoints

**Utilities:**
- Purpose: Constants, date helpers, logging
- Location: `src/utils/`
- Contains: locale config, facility IDs, date filtering logic, auth audit logging

**Middleware:**
- Purpose: Request authentication and authorization
- Location: `src/middleware/`
- Contains: API key auth, Clerk JWT validation

## Data Flow

**Primary Poll Flow (Cron-Triggered):**

1. `poll-cron-cloud.ts` (*/2 min, PROD) or `poll-cron-local.ts` (1/2 min, DEV)
   - Query `bots` table for status='active'|'error' with pollEnvironments matching source
   - Cancel orphaned `activeRunId` if stale (EXECUTING >3min)
   - Trigger `poll-visa` task for each eligible bot

2. `poll-visa.ts` (core polling task)
   - Load bot config + session from DB
   - Validate session age — if >44min, refresh tokens via `performLogin()` inline
   - Fetch consular days via `visa-client.getDays(consularFacilityId)`
   - Filter dates: excluded ranges, target cutoffs, `isAtLeastNDaysEarlier()`
   - If improvement found: inline `executeReschedule()` with up to 5 date attempts
   - Log poll result (status, responseTime, dateChanges, topDates, connectionInfo) to `poll_logs`
   - Evaluate rescheduling success, TCP blocks, soft bans, session expiry
   - **Decision: Should chain?** Check `shouldChain` flags:
     - CronTriggered + no sub-minute polling → exit (cron will re-trigger)
     - SubMinutePolling (`interval < 60s` for es-pe) → self-trigger with `getPollingDelay()`
     - SuperCritical window (drop -2min → +8min) → continuous loop, 3s delays
     - Burst phase → 10s delays with sniper alignment
     - Error recovery → chain to retry
   - Self-trigger via `task.trigger()` with queue string `'visa-polling-per-bot'` and concurrencyKey `poll-{botId}`

3. **On Reschedule Success:**
   - Update `bots.currentConsularDate`, `currentConsularTime`, `rescheduleCount`
   - Insert `reschedule_logs` with old/new dates, attempt count, strategy info
   - Trigger `notify-user` task → email to `ownerEmail` (webhook fire-and-forget)
   - If subscriber: also trigger reschedule on linked subscribers

**Login Flow (Session Recovery):**

1. **Preventive (in poll-visa):**
   - Check session age in DB (`lastUsedAt`)
   - If >44min (half of 1h28m TTL): call `performLogin()` inline
   - Updates `sessions` table with new cookie + tokens

2. **Reactive (poll-visa detects 401/302):**
   - Throw `SessionExpiredError`
   - Poll-visa catches → triggers `login-visa` task
   - `login-visa` runs `pureFetchLogin()` from cloud (different IP)
   - Saves session → sets bot status='active' → self-triggers poll-visa chain

3. **Background Retry (poll-cron):**
   - Query bots with status='login_required' + updatedAt >5min old
   - Auto-trigger `login-visa` for stuck bots

**CAS Prefetch Flow (Scheduled):**

1. `prefetch-cas` cron (*/30 min, PROD only)
   - Loop all active bots
   - Call `getConsularDays()` to find valid consular time
   - Generate probe dates [today+5, today+21+10]
   - For each probe: `getCasDays()` → discover CAS dates
   - For each CAS date: `getCasTimes()` → slots and times
   - Filter to [today, today+21]
   - Save to `bots.casCacheJson` (refreshedAt, windowDays, entries with date/slots/times)
   - Publish CAS cache to subscribers

**State Management:**

- **Bot State:** `bots` table — status (created/login_required/active/paused/error/invalid_credentials), appointments, config, activeRunId
- **Session State:** `sessions` table — encrypted cookie, csrf/authenticity tokens, lastUsedAt
- **Poll Audit:** `poll_logs` — every poll records (status, earliest_date, topDates, responseTimeMs, connectionInfo)
- **Reschedule History:** `reschedule_logs` — old/new dates, success flag, error reason, strategy metadata
- **TCP Block Tracking:** `ban_episodes` table — IP bans with phase tracking (transient/sustained), blocks per episode
- **CAS Cache:** `bots.casCacheJson` JSONB — discovered CAS dates + availability per bot

## Key Abstractions

**VisaClient:**
- Purpose: HTTP client for ais.usvisa-info.com with session + CSRF management
- Examples: `src/services/visa-client.ts` (line 48+)
- Pattern: Constructor takes session + config, methods are `getDays()`, `getTimes()`, `getCasDays()`, `getCasTimes()`, `reschedule()`
- Encapsulates: proxy routing, error classification, cookie/token lifecycle

**executeReschedule():**
- Purpose: Retry logic for finding earlier appointment and executing POST
- Examples: `src/services/reschedule-logic.ts` (line 67+)
- Pattern: Takes bot + exclusions + prefetched days, loops up to 5 dates, tries all times per date before advancing
- Returns: success flag, date, attempt logs (fail reasons), falsePositiveDates (slots stolen), repeatedlyFailingDates (3+ failures)

**ProxyFetchMeta:**
- Purpose: Track proxy selection, fallback reasons, pool health
- Examples: `src/services/proxy-fetch.ts` (embedded in fetch metadata)
- Pattern: Each fetch call returns meta with proxyAttemptIp, fallbackReason, websharePoolSize, errorSource
- Used by: poll-visa to detect account/IP bans vs transient errors

**Polling Delay Resolution:**
- Purpose: Compute self-trigger delay accounting for poll overhead + phase context
- Examples: `src/services/scheduling.ts:getPollingDelay()` (line 76+), `getNormalInterval()`, `getEffectiveInterval()`
- Pattern: Base interval from locale/bot config → subtract elapsed time → apply jitter ±5%
- Result: Trigger.dev delay string like `'9s'`, `'10s'`

**Drop Window + Super-Critical Detection:**
- Purpose: Identify when consulates release slots (drop window) and trigger aggressive polling
- Examples: `src/services/scheduling.ts:isInSuperCriticalWindow()` (line 61+), `getCurrentPhase()`
- Pattern: Consulate drop times per locale (es-co: Tue 9:00 Bogota, es-pe: Wed 12:00 Lima)
- Logic: Super-critical = drop ±2min/-8min window, triggers 3s loop; burst = +8min to +60min, 10s delay

## Entry Points

**Cron Tasks:**
- Location: `src/trigger/poll-cron.ts`
- Triggers: `pollCronCloud` (*/2 min PROD), `pollCronLocal` (1/2 min DEV)
- Responsibilities: Query eligible bots, cancel orphaned runs, trigger poll-visa in bulk

**API Server:**
- Location: `src/index.ts`
- Port: 3000 (configurable)
- Responsibilities: REST routes (/api/bots, /api/logs, /api/dev, /dashboard), CORS, auth middleware

**Poll Core:**
- Location: `src/trigger/poll-visa.ts`
- Trigger: Cron or self-trigger from previous run
- Responsibilities: Fetch days, detect improvements, inline reschedule, log results, decide chain continuation

**Login Recovery:**
- Location: `src/trigger/login-visa.ts`
- Trigger: Manual API call or auto-retry from poll-cron (5min stuck threshold)
- Responsibilities: Pure fetch login from cloud, save session, restart poll chain

**CLI Scripts:**
- Location: `scripts/` (60+ files)
- Examples: `activate-bot.ts`, `test-reschedule-e2e.ts`, `monitor.ts`, `login.ts`
- Usage: Ad-hoc bot management, debugging, data analysis (run via `npx tsx script.ts`)

## Error Handling

**Strategy:** Layered with fallback chains (local → cloud login, direct → proxy fallback)

**Patterns:**

1. **Session Expired (401/302):**
   - VisaClient detects redirect to `/users/sign_in` → throws `SessionExpiredError`
   - Poll-visa catches → sets bot status='login_required' → triggers `login-visa` task
   - Login-visa retries from cloud IP (RPi IP may be blocked)

2. **TCP Block Detection:**
   - Poll-visa extracts error message + bytesRead from proxy meta
   - `classifyTcpSubcategory()` → socket_immediate_close|pool_exhausted|connection_reset|dns_fail|connection_timeout|proxy_tunnel_fail
   - `deriveBlockClassification()` → transient|ip_ban|account_ban
   - `sustainedTcpBlockCount` tracks last 5 polls: 0-2 → normal delay, 3-4 → 10m backoff, 5+ → 30m backoff
   - Triggers ban_episodes logging for visibility

3. **Soft Ban (HTTP 200 + `[]`):**
   - Poll-via detects empty dates array + soft ban pattern
   - Sets poll_logs.status='soft_ban'
   - Self-triggers with 10m delay
   - Notifies user (operational alerts)

4. **Proxy Quota/Infra Failures:**
   - `classifyProxyError()` distinguishes proxy_infra (tunnel fail, bandwidth) from embassy_block
   - Proxy_infra → fallback to next provider in pool
   - Quota exhausted → log + throttle 5min

5. **Invalid Credentials:**
   - `pureFetchLogin()` detects "inválida" in response
   - Throws `InvalidCredentialsError`
   - API endpoint catches → sets bot status='invalid_credentials'
   - User must re-validate via dashboard

6. **Account Locked:**
   - Detected after 3 failed login attempts
   - Throws `AccountLockedError` with optional lockedUntil date
   - Sets bot status='login_required' with user notification

## Cross-Cutting Concerns

**Logging:**
- Approach: Trigger.dev `logger.info()` / `.error()` + DB audit tables (authLogs, notificationLogs, pollLogs)
- Structured: botId, runId, timestamp, event type, metadata (dates, response times, error types)
- Audit trail in `authLogs` for login attempts, token validation, discovery

**Validation:**
- Approach: VisaClient.verifyReschedule() confirms appointment actually changed (false positive detection)
- Date filters: filterDates(dates, exclusions, targetBefore) removes blocked ranges
- Time filters: filterTimes(times, exclusions, date) removes blocked hours per date

**Authentication:**
- Approach: API auth via X-API-Key header (middleware) + Clerk JWT for dashboard
- Session management: Encrypted sessions table with 1h28min TTL, preventive re-login at 44min
- CSRF: Dual tokens (csrf-token from meta, authenticity_token from form) — values are different

**Encryption:**
- Approach: AES-256-GCM for credentials + sessions in DB
- Implementation: `src/services/encryption.ts` (encrypt/decrypt)
- Keys: ENCRYPTION_KEY env var (32 bytes)

**Rate Limiting:**
- Approach: Polling interval per locale (9s es-pe, 9s es-co default) + phase-based adjustments
- Super-critical: 3s loops
- Burst: 10s with sniper alignment (avoid synchronized polling)
- Backoff: TCP blocks → 10m/30m, soft ban → 10m

**Notifications:**
- Approach: Trigger `notify-user` task on reschedule_success, session_expired, soft_ban, account_locked
- Channels: Email (Resend, to `notificationEmail` or `ownerEmail`), Webhook (HMAC-signed)
- Fire-and-forget: Async via task queue, doesn't block poll-visa

---

*Architecture analysis: 2026-04-06*

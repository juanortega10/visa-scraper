# Codebase Structure

**Analysis Date:** 2026-04-06

## Directory Layout

```
visa-scraper/
├── src/
│   ├── index.ts                   # API entry point (Hono server on port 3000)
│   ├── api/                       # REST endpoints
│   │   ├── bots.ts                # Bot CRUD, validation, activate/pause
│   │   ├── logs.ts                # Poll logs, reschedule logs, CAS prefetch logs
│   │   ├── dev.ts                 # Development helpers (check-dates, login)
│   │   ├── dashboard.ts           # Dashboard data aggregation
│   │   ├── block-intelligence.ts  # TCP block analysis endpoints
│   │   └── bots-me.test.ts        # API integration tests
│   │
│   ├── trigger/                   # Trigger.dev tasks
│   │   ├── poll-visa.ts           # Core: fetch days, inline reschedule, self-trigger (933 lines)
│   │   ├── poll-cron.ts           # Cron entry points (cloud */2, local 1/2)
│   │   ├── login-visa.ts          # Session recovery from cloud
│   │   ├── reschedule-visa.ts     # Manual reschedule wrapper task
│   │   ├── prefetch-cas.ts        # CAS cache refresh (*/30 min PROD)
│   │   ├── ensure-chain.ts        # Dead chain resurrection (Tue 8:50-59 Bogota)
│   │   ├── notify-user.ts         # Email + webhook delivery
│   │   ├── queues.ts              # Queue definitions (visa-polling, visa-reschedule, visa-login, etc.)
│   │   ├── test-cloud-login.ts    # Verify pureFetchLogin from datacenter
│   │   ├── probe-blocking.ts      # TCP block detection experiments
│   │   ├── test-cas-requests.ts   # CAS endpoint testing
│   │   └── prefetch-cas.test.ts   # CAS prefetch unit tests
│   │
│   ├── services/                  # Business logic
│   │   ├── visa-client.ts         # HTTP client for ais.usvisa-info.com
│   │   ├── login.ts               # Pure fetch login, token refresh, discovery
│   │   ├── reschedule-logic.ts    # Multi-date retry, CAS filtering, POST execution
│   │   ├── scheduling.ts          # Polling delays, drop windows, phase detection
│   │   ├── proxy-fetch.ts         # Proxy pool manager (direct, Webshare, Bright Data, Firecrawl)
│   │   ├── notifications.ts       # Email (Resend) + webhook delivery
│   │   ├── html-parsers.ts        # DOM extraction for appointments, tokens, facility IDs
│   │   ├── encryption.ts          # AES-256-GCM encrypt/decrypt
│   │   └── __tests__/             # Service unit tests
│   │       ├── visa-client.test.ts
│   │       ├── visa-client-reschedule.test.ts
│   │       ├── login.test.ts
│   │       ├── html-parsers.test.ts
│   │       ├── date-helpers.test.ts
│   │       ├── reschedule-cas-cache.test.ts
│   │       └── reschedule-stability-fixes.test.ts
│   │
│   ├── db/                        # Database layer
│   │   ├── schema.ts              # Drizzle ORM schema (bots, sessions, logs tables)
│   │   ├── client.ts              # Neon PostgreSQL client initialization
│   │   └── migrations/            # Drizzle migrations (auto-generated)
│   │
│   ├── middleware/                # Request middleware
│   │   ├── api-auth.ts            # X-API-Key validation
│   │   └── clerk-auth.ts          # Clerk JWT validation for dashboard
│   │
│   └── utils/                     # Utilities
│       ├── constants.ts           # Locales, facility IDs, BROWSER_HEADERS
│       ├── date-helpers.ts        # filterDates, isAtLeastNDaysEarlier, date parsing
│       └── auth-logger.ts         # Audit logging for auth events
│
├── scripts/                       # CLI tools for management and analysis
│   ├── activate-bot.ts            # Set bot active, start poll chain
│   ├── login.ts                   # Manual login test
│   ├── test-reschedule-e2e.ts     # Dry-run or commit reschedule
│   ├── test-fetch.ts              # Test proxy + fetch from all providers
│   ├── monitor.ts                 # Real-time bot monitoring
│   ├── set-bot-*.ts               # Set bot status/provider/active field
│   ├── check-*.ts                 # Debug/inspect bot state (60+ variants)
│   └── block-analysis-*.ts        # TCP block pattern analysis
│
├── .trigger/                      # Trigger.dev local cache
├── .env                           # Secrets (ENCRYPTION_KEY, WEBHOOK_SECRET, CLERK_SECRET_KEY, etc.)
├── .env.example                   # Template for .env
├── package.json                   # Dependencies (Hono, Drizzle, Trigger.dev, Resend, Clerk)
├── tsconfig.json                  # TypeScript config (ESM)
├── drizzle.config.ts              # Drizzle migration config (Neon PostgreSQL)
├── CLAUDE.md                      # Project rules and architecture reference
├── CHANGELOG.md                   # Release history (Keep a Changelog format)
└── README.md                      # (Not present — see CLAUDE.md instead)
```

## Directory Purposes

**src/index.ts:**
- Purpose: Hono API server initialization
- Contains: Route mounting, CORS config, error handler, health endpoint
- Key features: Routes `/dashboard` (unauthenticated), `/api/*` (authenticated), global CORS

**src/api/:**
- Purpose: REST endpoint implementations
- Contains: Bot CRUD (`bots.ts` — 800+ lines with validation), logs querying (`logs.ts`), dev helpers (`dev.ts`), analytics dashboard
- Key files:
  - `bots.ts`: POST /api/bots (create), GET/PUT/DELETE /api/bots/:id, POST /api/bots/:id/activate|pause|resume, POST /api/bots/validate-credentials, POST /api/bots/:id/logs/* endpoints
  - `logs.ts`: Poll log aggregation, reschedule history, CAS prefetch logs
  - `dev.ts`: check-dates, login testing, dry-run tools

**src/trigger/:**
- Purpose: Async task definitions for Trigger.dev
- Contains: 13 task files (core: poll-visa.ts, poll-cron.ts, login-visa.ts; support: reschedule-visa.ts, prefetch-cas.ts, notify-user.ts, ensure-chain.ts)
- Key characteristics:
  - Tasks use queue string in trigger options: `queue: 'visa-polling-per-bot'`
  - Concurrency controlled via concurrencyKey (poll-{botId}, reschedule-{botId})
  - Self-triggering chains use `task.trigger()` with `delay: '9s'` format
  - Environment split: dev=RPi, PRODUCTION=cloud

**src/services/:**
- Purpose: Reusable business logic
- Contains: 8 core services + 7 test files
- Pattern: Each service is a module with exported functions + classes (VisaClient, ProxyPoolManager)
- Dependencies: Services import from db/, utils/, other services
- NO cross-service circular imports

**src/db/:**
- Purpose: Data persistence layer
- Contains: Drizzle ORM schema with 13 tables
- Key tables:
  - `bots` (id serial, visaEmail/Password encrypted, scheduleId, status, currentConsularDate/Time, currentCasDate/Time, activeRunId, casCacheJson JSONB, targetDateBefore, maxReschedules, rescheduleCount, pollEnvironments, cloudEnabled, etc.)
  - `sessions` (botId FK, yatriCookie encrypted, csrfToken, authenticityToken, lastUsedAt)
  - `pollLogs` (botId FK, status, earliest_date, topDates JSONB, responseTimeMs, dateChanges, connectionInfo JSONB)
  - `rescheduleLogs` (botId FK, oldConsularDate, newConsularDate, oldCasDate, newCasDate, success, error, strategy)
  - `excludedDates`, `excludedTimes` (date/time range exclusions per bot)
  - `casPrefetchLogs` (audit trail)
  - `authLogs` (login attempts, token validation, discovery events)
  - `banEpisodes` (TCP block tracking with phase + block counts)
  - `notificationLogs` (email/webhook delivery audit)

**src/middleware/:**
- Purpose: Request authentication
- Contains: API key auth (X-API-Key header), Clerk JWT validation

**src/utils/:**
- Purpose: Shared constants and helpers
- Contains: Locale configs, facility IDs (Bogota Consular=25, Bogota ASC=26, Lima=115), BROWSER_HEADERS, date filtering, audit logging

**scripts/:**
- Purpose: CLI tools for bot management and debugging
- Contains: 60+ scripts for:
  - Activation/deactivation (`activate-bot.ts`, `set-bot-status.ts`)
  - Testing (`test-reschedule-e2e.ts`, `test-fetch.ts`)
  - Monitoring (`monitor.ts`)
  - Analysis (`block-analysis-*.ts`, `capacity-analysis.ts`, `check-*.ts`)
- Pattern: Each script is standalone, uses DB client + services directly
- Usage: `npx tsx scripts/script-name.ts [args]`

## Key File Locations

**Entry Points:**

- `src/index.ts` — HTTP server, routes registration
- `src/trigger/poll-cron.ts` — Scheduled cron tasks (cloud/dev dual)
- `scripts/` — CLI tools (run via `npx tsx`)

**Configuration:**

- `.env` — Secrets (ENCRYPTION_KEY, CLERK_SECRET_KEY, WEBHOOK_SECRET, RESEND_API_KEY, WEBSHARE_API_KEY, DATABASE_URL, TRIGGER_SECRET_KEY)
- `drizzle.config.ts` — Drizzle migration config
- `package.json` — Dependencies and npm scripts
- `CLAUDE.md` — Project rules, gotchas, architecture reference

**Core Logic:**

- `src/trigger/poll-visa.ts` — Main polling loop (933 lines, all poll logic)
- `src/services/reschedule-logic.ts` — Rescheduling retry logic
- `src/services/login.ts` — Session management
- `src/services/visa-client.ts` — Visa API HTTP client
- `src/services/scheduling.ts` — Polling interval + phase logic
- `src/services/proxy-fetch.ts` — Proxy selection + circuit breaker

**Testing:**

- `src/services/__tests__/*.test.ts` — Unit tests for services (Vitest)
- `src/api/bots-me.test.ts` — API integration test
- `src/trigger/prefetch-cas.test.ts` — CAS prefetch test

## Naming Conventions

**Files:**

- Tasks: `[action]-[resource].ts` — `poll-visa.ts`, `login-visa.ts`, `reschedule-visa.ts`
- Services: `[domain].ts` — `visa-client.ts`, `login.ts`, `proxy-fetch.ts`
- Tests: `*.test.ts` or `*.spec.ts` — colocated with source in `__tests__/`
- Scripts: `[verb]-[noun].ts` or `[noun]-[analysis].ts` — `activate-bot.ts`, `block-analysis-1.ts`
- API routes: `[resource].ts` — `bots.ts`, `logs.ts`, `dev.ts`

**Functions:**

- Exported task definitions: `camelCase + Task` — `pollVisaTask`, `loginVisaTask`
- Service functions: `camelCase` — `executeReschedule()`, `pureFetchLogin()`, `performLogin()`
- Helpers: `camelCase` — `filterDates()`, `isAtLeastNDaysEarlier()`, `getPollingDelay()`
- HTTP handlers: `(c: Context) => Promise<Response>` — uses Hono convention
- Interfaces: `PascalCase` + suffix — `VisaSession`, `RescheduleResult`, `LoginCredentials`

**Variables:**

- DB entities: `camelCase` — `bot`, `session`, `pollLog`
- Config objects: `UPPER_SNAKE_CASE` for constants — `DEFAULT_POLL_INTERVAL_S`, `BROWSER_HEADERS`, `DROP_SCHEDULES`
- Timestamps: `*At`, `*Ms`, `*Seconds` suffix — `lastUsedAt`, `elapsed Ms`, `delaySeconds`
- Booleans: `is*`, `has*`, `should*`, `can*` — `isCloud`, `hasTokens`, `shouldChain`, `canReschedule`
- Collections: plural — `botIds`, `dateCooldowns`, `rescheduleLogs`

**Types:**

- Task payloads: `[Action]Payload` — `PollPayload`, `LoginPayload`, `ReschedulePayload`
- Result types: `[Action]Result` — `RescheduleResult`, `LoginResult`
- Option types: `[Action]Options` — `PureFetchLoginOptions`
- DB row types: match Drizzle table name — `typeof bots.$inferSelect`
- Enum values: lowercase/snake_case — `status: 'active'|'paused'|'error'`

**Directories:**

- Feature modules: `[feature]/` — `src/trigger/`, `src/services/`, `src/api/`
- Test folders: `__tests__/` (Vitest convention)
- Config folders: `.trigger/`, `.env*`

## Where to Add New Code

**New Feature (e.g., new polling mode):**
- Primary code: `src/trigger/` (new task file if standalone, else extend `poll-visa.ts`)
- Shared logic: `src/services/` (new service module if reusable)
- Tests: `src/services/__tests__/[feature].test.ts` or `src/trigger/[feature].test.ts`
- API endpoint: `src/api/` (add route to existing or new router)
- DB schema: Update `src/db/schema.ts` (create migration via `npm run db:push`)

**New Component/Module:**
- Service: Create `src/services/[name].ts` with exported functions/classes
- Task: Create `src/trigger/[action]-[resource].ts` with task export
- API route: Add to existing router in `src/api/[resource].ts` or create new file
- Middleware: Add to `src/middleware/[concern].ts`
- Utility: Add to `src/utils/[domain].ts` or create new file

**Utilities/Helpers:**
- Shared date helpers: `src/utils/date-helpers.ts`
- Constants: `src/utils/constants.ts` (locales, facility IDs, headers)
- Logging: `src/utils/auth-logger.ts` (for audit trails)
- New cross-cutter: Create `src/utils/[concern].ts`

**Database Changes:**
- Schema modifications: Edit `src/db/schema.ts`
- Run migration: `npm run db:push`
- Queries: Use Drizzle ORM in services/tasks directly (no separate DAL layer)

**Tests:**
- Unit tests for services: `src/services/__tests__/[service].test.ts`
- Integration tests for API: `src/api/[resource].test.ts`
- Task tests: `src/trigger/[task].test.ts`
- Run: `npm test` or `npm run test:watch`

**Scripts:**
- One-off tools: `scripts/[verb]-[noun].ts`
- No shared library — each script imports services/db directly
- Execution: `npx tsx --env-file=.env scripts/[name].ts [args]`

## Special Directories

**src/.trigger/:**
- Purpose: Trigger.dev build cache (auto-managed)
- Generated: Yes
- Committed: No (in .gitignore)
- Contents: Build artifacts from `npm run trigger:dev` or deploys

**.env Files:**
- Purpose: Runtime configuration and secrets
- Generated: No (user-created from .env.example)
- Committed: No (.gitignore)
- Contents: ENCRYPTION_KEY, DATABASE_URL, API keys (CLERK_SECRET_KEY, RESEND_API_KEY, WEBHOOK_SECRET, WEBSHARE_API_KEY, TRIGGER_SECRET_KEY)

**scripts/:**
- Purpose: Ad-hoc CLI tools (not part of main application)
- Generated: No
- Committed: Yes
- Contents: Bot management, debugging, analysis — standalone .ts files

**node_modules/, dist/:**
- Purpose: Dependencies and compiled output
- Generated: Yes
- Committed: No (.gitignore)

**logs/:**
- Purpose: Local log files (development)
- Generated: Yes (from tasks if file logging enabled)
- Committed: No

---

*Structure analysis: 2026-04-06*

# External Integrations

**Analysis Date:** 2026-04-06

## APIs & External Services

**Visa Appointment Scraping:**
- ais.usvisa-info.com - US Embassy visa appointment system
  - SDK/Client: Pure Node.js fetch (see `src/services/visa-client.ts`)
  - Auth: Session-based (`_yatri_session` cookie + CSRF tokens)
  - Endpoints:
    - `GET /schedule/{scheduleId}/appointment/days/{facilityId}.json` - Available dates
    - `GET /schedule/{scheduleId}/appointment/times/{facilityId}.json?date=YYYY-MM-DD` - Time slots
    - `GET /schedule/{scheduleId}/appointment/days/26.json?consulate_id=25&consulate_date=...` - CAS availability
    - `POST /schedule/{scheduleId}/appointment` - Reschedule (form-urlencoded)
    - `GET /groups/{userId}` - Current appointments (HTML parse)
    - `GET /users/sign_in` - Login page (IV or NIV flow)
    - `POST /users/sign_in` - AJAX login (bypasses hCaptcha)

**Email Notifications:**
- Resend (transactional email) - Implementation: `src/services/notifications.ts`
  - Auth: `RESEND_API_KEY` env var
  - Used for: reschedule_success, reschedule_failed, session_expired, poll_errors, CAS availability alerts
  - Email templates: HTML inline (dynamic styles in notification code)
  - Sender: `Agente R <notificaciones@notifications.visagente.com>`

**Consular Availability (Peru):**
- Kapso API - Consular system for Peru (es-pe locale)
  - SDK/Client: Node.js fetch
  - Auth: `KAPSO_API_KEY` header
  - Base URL: `KAPSO_API_BASE_URL` env var
  - Used for: Cross-validation of Peru consular availability

## Data Storage

**Databases:**
- Neon PostgreSQL (serverless, HTTP-based)
  - Connection: `DATABASE_URL` (neon_sql://... or postgresql://...)
  - Client: @neondatabase/serverless (HTTP adapter, required for Trigger.dev cloud workers)
  - ORM: Drizzle with `neon-http` dialect (see `src/db/client.ts`)
  - Lazy initialization via Proxy (avoids crashes during Trigger.dev build phase)

**File Storage:**
- Local filesystem only (no cloud storage integration)
  - Webshare proxy list cached to temp file: `/tmp/webshare-proxy-cache.json`
  - Proxy pool state: `/tmp/.proxy-pool-state.json`
  - TTL: 12 hours

**Caching:**
- None (memory-only within single task execution)
- Webshare IP list refreshed from API every 12h or on first request after expiry

## Authentication & Identity

**Auth Provider:**
- Clerk - User identity management
  - Implementation: JWT-based (see `src/middleware/clerk-auth.ts`)
  - Auth method: Bearer token in Authorization header
  - SDK: @clerk/backend
  - Env vars: `CLERK_SECRET_KEY`, `CLERK_JWT_KEY` (PEM private key)
  - Routes: POST `/api/bots` (require auth), dashboard (cookie-based)

**API Key Auth (alternative):**
- Simple bearer token (for testing/scripts)
  - Env var: `API_KEY`
  - Used when `CLERK_JWT_KEY` not present
  - Implementation: `src/middleware/api-auth.ts`

**Visa Account Credentials:**
- Stored encrypted in database (`bots.visaEmail`, `bots.visaPassword`)
- Encryption: AES-256-GCM
- Never logged or sent to external services (except visa.usvisa-info.com)

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry, Rollbar, or similar)
- Errors logged to stdout/console

**Logs:**
- In-database logging to tables:
  - `poll_logs` - Poll results, dates found, timing, proxy metadata
  - `reschedule_logs` - Reschedule attempts, success/failure, strategy info
  - `auth_logs` - Login attempts, token validation, discovery
  - `notification_logs` - Email/webhook dispatch status
  - `dispatch_logs` - Historical (legacy, no longer written)
  - `cas_prefetch_logs` - CAS cache refresh cycles
- Trigger.dev SDK logger (`logger` from `@trigger.dev/sdk/v3`)
  - Logs visible in Trigger.dev web console
  - Used in: poll-visa, login-visa, reschedule-visa, notify-user tasks

## CI/CD & Deployment

**Hosting:**
- Trigger.dev cloud (production tasks via PROD environment)
- Raspberry Pi (local dev worker, dev polling chain)
- Hono API server (runs on RPi or separate cloud instance)

**CI Pipeline:**
- None configured (manual deployment)
- Pre-deployment: `npm test` (vitest)
- Deployment: `npm run deploy:rpi` (SSH sync to RPi) or Trigger.dev web console

## Environment Configuration

**Required env vars:**
- `DATABASE_URL` - Neon HTTP endpoint (critical)
- `MASTER_ENCRYPTION_KEY` - 64-char hex, for credential encryption (critical)
- `CLERK_SECRET_KEY` - For user identity (if using Clerk)
- `CLERK_JWT_KEY` - PEM private key for JWT verification
- `RESEND_API_KEY` - Email service
- `WEBHOOK_SECRET` - Signing key for outbound webhooks

**Optional (feature-gated):**
- `WEBSHARE_API_KEY` - Enables webshare proxy provider
- `BRIGHT_DATA_PROXY_URL` - Static proxy (GET only, POST unsupported)
- `FIRECRAWL_API_KEY` - Browser-based HTTP client fallback
- `KAPSO_API_KEY`, `KAPSO_API_BASE_URL` - Peru consular validation
- `ADMIN_NOTIFICATION_EMAIL`, `ADMIN_RESCHEDULE_EMAIL` - Admin alerts
- `DASHBOARD_PASSWORD` - Dashboard auth (has hardcoded fallback)

**Secrets location:**
- `.env` file (git-ignored, never committed)
- Production: Trigger.dev environment variables (for cloud tasks)
- RPi systemd unit: env file sourced at startup

## Webhooks & Callbacks

**Incoming:**
- None (bot doesn't accept webhooks)

**Outgoing:**
- User-defined webhook URL (per bot)
  - Endpoint: `bots.webhookUrl` (stored per bot)
  - Event: reschedule_success, reschedule_failed, poll_error
  - Signing: HMAC-SHA256 with `WEBHOOK_SECRET` (header: `X-Signature`)
  - Implementation: `src/services/notifications.ts:sendWebhook()`

## Proxy Providers

**Direct (default):**
- No proxy; direct connection from client IP
- Implementation: `src/services/proxy-fetch.ts:proxyFetch()` with `proxyProvider='direct'`
- Best for: Residential IP (RPi), low latency (300-900ms)

**Webshare:**
- Proxy pool manager (dynamic IP rotation)
  - API: `proxy.webshare.io/api/v2/proxy/list/`
  - Auth: Token header
  - Cache: 12-hour file-based cache (survives process forks)
  - Circuit breaker: Per-IP health tracking, recency penalty (8s backoff after failure)
  - Use case: Sustained polling (though risky for es-co — account-level bans documented)
  - Implementation: `getEffectiveWebshareUrls()`, `ProxyPoolManager` in `proxy-fetch.ts`

**Bright Data:**
- Static HTTP proxy endpoint
  - URL: `BRIGHT_DATA_PROXY_URL` env var
  - Limitation: GET works, POST returns HTTP 402 (Payment Required)
  - Use case: Experiments only, not recommended for production
  - Implementation: `proxyFetch()` routes to static URI

**Firecrawl:**
- Browser-based HTTP client (wraps responses in `rawHtml`)
  - API: `https://api.firecrawl.dev/v1/scrape`
  - Auth: `FIRECRAWL_API_KEY` header
  - Use case: Fallback when direct/proxy blocked
  - Implementation: `firecrawlFetch()` in `proxy-fetch.ts`

## Session Management

**Visa Session (ais.usvisa-info.com):**
- Cookie: `_yatri_session` (rotates on each response but original stays valid)
- Hard TTL: ~88 minutes (server-side, not idle-based)
- CSRF token: Extracted from `<meta name="csrf-token">` on authenticated pages
- Authenticity token: Extracted from `<input name="authenticity_token">` on appointment page
- Storage: Encrypted in `sessions.encrypted_cookie` table
- Pre-emptive refresh: At 44 minutes (half TTL) to avoid mid-poll expiry

**Clerk JWT:**
- Issued by Clerk, verified with `CLERK_JWT_KEY` (PEM)
- Stored in browser cookies (dashboard) or sent as Bearer token (API)
- TTL: Standard Clerk session (~7 days)

## Rate Limiting

**Visa API:**
- Per-IP soft limit: ~300 requests / 5-hour window (before HTTP 200 + empty array)
- Per-IP hard TCP block: Connection refused after sustained hits
- Backoff strategy: Configured in `src/services/scheduling.ts`
  - Normal interval: 10-20s (per locale)
  - Sub-minute polling (es-pe): 9s + self-triggering
  - Burst mode (Feb 10 only): 10s + sniper alignment
  - TCP backoff: 0-2 blocks → normal, 3-4 → 10m, 5+ → 30m

**Resend Email:**
- Standard transactional email limits (per Resend SLA)
- No local rate limiting

## Data Sync & Consistency

**Visa State Sync:**
- Poll-visa fetches current consular + CAS dates from `/groups/{userId}` HTML
- CAS cache: Refreshed every 30 minutes via `prefetch-cas` task
- Cross-schedule validation: CAS dates checked against consular via query params
- Propagation delay guard: 60s between reschedule and next consular fetch (allows server sync)

**User Sync:**
- Clerk user ID stored per bot (`bots.clerkUserId`)
- No real-time sync; user info fetched on demand

---

*Integration audit: 2026-04-06*

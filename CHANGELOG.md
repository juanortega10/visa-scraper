# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

## [2026-04-03] — Reschedule stability fixes

### Added
- **CHANGELOG.md**: This file. Keep a Changelog format, generated from git history.

### Fixed
- **Infinite retry loop on ghost slots**: `exhaustedDates` was a local `Set` inside `executeReschedule()` and not persisted between polls. Dates failing with `false_positive_verification` are now written to `blockedConsularDates` in `casCacheJson` with a 2h TTL, stopping the bot from retrying the same phantom slot every 30s.
- **Portal reversion not logged**: When the "secure then improve" second POST caused the portal to revert a just-booked appointment, the event was silent (no `reschedule_log` row). Now writes a `success=false, error='portal_reversion'` row so reversions are visible in history.
- **Green badge showing stale victory**: The dashboard badge `"→ date"` could show a date that was successfully booked but then portal-reverted. Badge now only renders when `reschedule_logs.newDate === bots.currentConsularDate`.

### Added
- **1h cooldown for repeatedly-failing dates**: `executeReschedule()` now tracks a `dateFailureCount` Map across all attempt types (CAS unavailable, HTTP error, false positive, etc.). Dates accumulating 3+ failures in a single poll are returned as `repeatedlyFailingDates` and written to `blockedConsularDates` with a 1h TTL in `poll-visa.ts`. Prevents aggressive retry loops on any date that is clearly unavailable right now.

---

## [2026-03-22]

### Fixed
- **Discover using wrong applicant IDs**: `discover` was using all group applicantIds instead of only the primary group's. Fixed to use primary group applicantIds only.

---

## [2026-03-21]

### Changed
- **Poll interval tuned to 7s**: Adjusted from 5s (too aggressive) to 7s as a middle ground. Start-to-start timing (elapsed time subtracted from delay) for consistent poll rates.
- **Poll timing switched to start-to-start**: `getPollingDelay()` now subtracts elapsed fetch time from the delay so interval is measured from request start, not response end.
- **Default poll interval reduced**: `DEFAULT_POLL_INTERVAL_S` reduced from 9s to 5s (~80% more polls/min). Later adjusted to 7s.

### Added
- **Ban analytics**: Ban episodes tracking, reschedule analytics, poll rate analysis. `banPhase` tagging on `poll_logs` for precise ban lifecycle analytics.
- **Reschedule analytics fallback**: Falls back to `poll_logs` when `bookable_events` is empty.

### Fixed
- **Analytics bugs**: Negative durations, cross-schedule query errors, timezone handling.
- **Analytics survivorship bias**: Excludes sustained-block polls from rate/session correlations.
- **Cross-schedule comparison**: Pairwise overlap + applicant count correlation.

---

## [2026-03-05]

### Added
- **Inline reschedule in poll-visa**: `executeReschedule()` now runs inline in the poll loop. Sub-minute chaining and TCP backoff with `sustainedTcpBlockCount`.
- **Multi-time reschedule**: Tries all consular times per date before moving to the next date.
- **CAS cache temporal filter**: 1–12 days before consular, fallback to API if cache fails.
- **Gap-based cluster dodge strategy**: Attempt 1 unsecured uses cluster dodge (pick #3 if gap ≤ 30, else #2). Post-secured uses aggressive upgrade.
- **Secure-then-improve**: First successful booking doesn't exit — keeps trying better dates.
- **Webshare proxy pool**: Circuit breaker + recency penalty (8s). `ProxyPoolManager` in `proxy-fetch.ts`.
- **Prefetch CAS task**: `prefetch-cas` task runs every 30min in PROD, caches CAS availability in `bots.casCacheJson`.
- **Dashboard improvements**: API `/api/dashboard` with cancellation summaries, `logs/cancellations` endpoint.

### Changed
- **Universal 10s poll default**: `DEFAULT_POLL_INTERVAL_S = 10`, `LOCALE_POLL_INTERVALS` cleared. All locales use same default.
- **Login: IV→NIV fallback**: `performLogin()` tries IV first, falls back to NIV. Uses `redirect: 'manual'` to prime server-side session state.
- **Notifications filtered**: `notificationEmail` only receives `reschedule_success` and `bot_paused` events.

### Fixed
- **`getCurrentAppointment` reading wrong group**: Was reading wrong group on multi-schedule accounts. Now correctly targets the bot's own schedule group.
- **`refreshTokens()` required before POST**: Without it, POST reschedule returns 302 → sign_in even though GETs work. `executeReschedule()` now calls `refreshTokens()` at start and after every re-login.

### Removed
- **Scout/subscriber architecture**: Removed `isScout`/`isSubscriber` roles, `dispatch.ts`, `subscriber-query.ts`, `dispatch_logs` writes. Columns remain in schema for historical data.

---

## [2026-02-28]

### Added
- Webshare proxy support in configuration.
- Health check endpoints.
- Session management improvements.

### Changed
- Dependencies updated to Trigger.dev v4.4.1.
- Enhanced `.gitignore`.

---

## [2026-02-15]

### Added
- Initial release: multi-tenant visa appointment monitoring bot.
- Pure fetch login (~970ms skipTokens, ~1.7s full) — no Playwright needed.
- Polling via direct/brightdata/firecrawl providers.
- AES-256-GCM credential encryption.
- Hono API, Trigger.dev v4, Neon PostgreSQL + Drizzle ORM.
- `poll-cron` (cloud + RPi), `poll-visa`, `login-visa`, `reschedule-visa`, `ensure-chain`, `notify-user` tasks.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

## [2026-04-08] — CAS days fetch error tracking

### Fixed
- **fetch_error on getCasDays not bumping cross-poll tracker**: When the portal returns 5xx on `getCasDays` for near-future consular dates (e.g. Apr 13-15 where valid CAS window is mostly in the past), the error was classified as `fetch_error` and skipped both the per-call `repeatedlyFailingDates` threshold (each date only fails 1-2× per call, not 3×) and the cross-poll `dateFailureTracking` (bumpTracker was never called). Now calls `bumpTracker(date, 'casNoDays')` when `currentStep === 'parallel_cas_days'` so dates with no valid CAS window get blocked after 5 failures across polls.

## [2026-04-07] — CAS consular context fix

### Fixed
- **CAS times fetched without consular context**: `getCasTimes()` was not passing `consulate_id`, `consulate_date`, `consulate_time` to the portal's `times.json` endpoint. The server returned unfiltered slots that were not actually valid for the target consular date, causing the bot to attempt POST reschedules with invalid consular+CAS pairs — always resulting in `false_positive_verification`. Now passes full consular context, matching the portal's own JS behavior.
- **Prefetch-CAS used arbitrary probe dates**: The CAS prefetch cron generated probe dates every 5 days (arbitrary), ignoring the bot's actual consular availability. Now probes with real consular dates earlier than the bot's current appointment — the dates the bot would actually try to reschedule to. Each CAS cache entry stores `forConsularDate`/`forConsularTime` so the reschedule logic only uses entries valid for the target consular.
- **CAS cache was not consular-context-aware**: `reschedule-logic.ts` used CAS cache entries regardless of which consular date they were fetched for. Now filters cache entries to match the candidate consular date, with backwards-compatible fallback for legacy entries without context.

## [2026-04-05] — Dashboard fleet health improvements

### Added
- **Fleet health filter bar**: chips to filter by All / Activos / Pausados, plus free-text search by phone number (wa:) or email. Filter state persists across 60s auto-refreshes.
- **Paused bots in fleet health**: paused bots now appear in the SALUD section (dimmed at 55% opacity) when the "Todos" or "Pausados" chip is selected.
- **Consular dates in health cards**: each row now shows the current appointment date (`actual`) and — when different — the original date from the first reschedule log.
- **Status badge**: paused bots show a PAUSED badge in their health card row.
- **`originalConsularDate` in landing API**: `/api/bots/landing` now returns `originalConsularDate` (earliest `old_consular_date` from `reschedule_logs`) for each bot.

---

## [2026-04-03] — Reschedule stability fixes

### Fixed
- **Portal propagation delay overwrites booked date**: After a successful reschedule, the next poll could read the portal before it propagated the new appointment and overwrite `currentConsularDate` back to the old (worse) date. The appointment sync block in `poll-visa.ts` now checks for a successful `reschedule_log` in the last 2 minutes before accepting a worse consular date from the portal. If one exists, consular fields are skipped; CAS fields are still synced independently.

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

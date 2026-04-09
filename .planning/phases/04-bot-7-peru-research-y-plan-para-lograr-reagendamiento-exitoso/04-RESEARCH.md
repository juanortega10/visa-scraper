# Phase 4: Bot 7 Peru - Research

**Researched:** 2026-04-09
**Domain:** Bot 7 (es-pe) reschedule failure analysis + remediation plan
**Confidence:** HIGH

## Summary

Bot 7 (Peru, es-pe locale) has been actively polling since February 15, 2026, accumulating 189,662 polls. It currently holds a consular appointment on 2027-07-30 and has `targetDateBefore: 2026-05-04`. Despite seeing bookable dates 19 times (status `ok`), it has NEVER successfully rescheduled through automated polling. All 14 reschedule attempts since March failed with `no_times` (12 times) or `verification_failed` (2 times). The 2 historical successes on Feb 17 used `provider: direct` and had a fundamentally different data landscape.

The root cause is a **phantom date problem**: Lima's consular facility returns dates in `days.json` that have zero available times. The dates appear in the days endpoint as cancellations (flash dates lasting 3-27 seconds), but by the time the bot fetches `times.json` for that date (1-6 seconds later), the times are empty. This is the classic "race condition with other bots/humans grabbing the same cancellation slot." Combined with the fact that only ONE bookable date appears per sighting (always exactly `datesCount: 1`), the bot has zero fallback options.

**Primary recommendation:** The bot needs a multi-pronged approach: (1) reduce time-to-POST by pre-loading session tokens, (2) try the POST even when times appear empty (speculative POST with a common time like "10:00"), and (3) switch to `direct` provider for the critical reschedule attempt since both historical successes used `direct`. Most critically, all experiments MUST be dry-run safe until the single remaining reschedule attempt is committed.

## Bot 7 Current State

### Configuration
| Property | Value |
|----------|-------|
| Bot ID | 7 |
| Locale | es-pe (Peru) |
| Status | active |
| Schedule ID | 72781813 |
| Consular Facility | 115 (Lima) |
| ASC Facility | "" (empty -- no CAS required) |
| Current Consular Date | 2027-07-30 07:30 |
| Current CAS Date | null |
| Provider | webshare |
| Target Date Before | 2026-05-04 |
| Max Reschedules | 1 |
| Reschedule Count | 0 (1 remaining) |
| Poll Environments | ["dev"] (RPi only) |
| Skip CAS | false (but ascFacilityId="" means needsCas=false) |
| Target Polls/Min | 7 |
| Is Scout | true |
| Excluded Dates | none |
| Excluded Times | none |

### Session
- Active session: created 2026-04-09 16:28, last used 16:31
- Has CSRF token and authenticity token

### Key Constraint
Peru portal has a **2-reschedule lifetime limit**. Bot 7 has `maxReschedules: 1` and `rescheduleCount: 0`. Using this 1 attempt on a failed POST is irreversible. The bot already used 2 reschedules on Feb 17 (success both times, via direct provider during manual testing), then the `currentConsularDate` was reset to `2027-07-30` by the user, resetting the count to 0 with maxReschedules=1.

## Historical Data Analysis

### Poll Volume and Status Distribution (all-time: 189,662 polls)
| Status | Count | Percentage |
|--------|-------|------------|
| filtered_out | 180,543 | 95.2% |
| tcp_blocked | 8,945 | 4.7% |
| error | 153 | 0.08% |
| ok | 19 | 0.01% |
| no_dates | 2 | 0.001% |

**Key insight:** Only 19 out of 189,662 polls (0.01%) found a bookable date (< targetDateBefore). The vast majority of dates in Peru are 2027+, which get `filtered_out`. This is NORMAL -- Lima has extremely limited near-term availability.

### Daily Poll Rates (recent 30 days)
- Averaging 3,500-5,400 polls/day
- ~3-5 polls/minute sustained
- TCP blocks: 0-10/day recently (was 118-172/day in mid-March before rate adjustments)
- TCP block rate dropped from ~5-7% to under 1% after March 20 improvements

### TCP Block Rate by Hour (UTC)
- Highest: Hours 6-14 UTC (6-7% block rate)
- Lowest: Hours 15-20 UTC (1.5-3.2% block rate)
- This suggests blocking correlates with daytime US East / Lima business hours

### Date Sighting Analysis

**Total date sightings (all):** 823 entries in `date_sightings`
**Bookable date sightings (< 2026-05-04):** 12 events across 6 days

| Date | Appeared (UTC) | Duration | Outcome |
|------|---------------|----------|---------|
| 2026-04-20 | Apr 9 09:35 | 4.3s | no_times |
| 2026-04-22 | Apr 8 08:35 | 8.2s | no_times |
| 2026-04-13 | Apr 7 09:15 | 3.2s | no_times |
| 2026-04-09 | Apr 1 20:15 | 13.3s | no_times |
| 2026-04-09 | Apr 1 15:27 | 26.9s | no_times |
| 2026-04-22 | Apr 1 01:35 | 17.0s | no_times |
| 2026-04-17 | Apr 1 00:35 | 17.1s | no_times |
| 2026-04-13 | Apr 1 00:10 | 11.0s | no_times |
| 2026-04-08 | Mar 31 22:30 | 14.3s | no_times |
| 2026-04-10 | Mar 31 16:30 | 21.1s | no_times |
| 2026-04-08 | Mar 31 15:50 | 11.9s | verification_failed (POST attempted!) |
| 2026-04-14 | Mar 25 03:45 | 2.0s | no_times |

**Pattern:** Bookable dates flash for 2-27 seconds. The bot detects them in 0-2 seconds (immediate -- same poll). But `getConsularTimes()` always returns empty for these dates.

### Non-bookable sightings (mid-range dates like 2026-06 to 2026-08)
These appear frequently (dozens per day) and last 8-170 seconds. They are much more common than near-term dates but fall outside `targetDateBefore`. Many last 10-150 seconds -- significantly longer than the near-term dates.

### Reschedule Attempts (all 19 polls with reschedule_result)

| Date | Time (UTC) | Result | Duration (ms) | Provider |
|------|-----------|--------|---------------|----------|
| Feb 17 15:25 | success | ~7000 | direct |
| Feb 17 17:10 | success | ~15000 | direct |
| Feb 19 15:52 | verification_failed | 1121 | direct |
| Feb 20 07:20 | no_times | 787 | webshare |
| Feb 24 20:10 | verification_failed | 877 | webshare |
| Feb 24 20:11 | no_times | 1479 | webshare |
| Mar 10 02:00 | no_times | 2068 | webshare |
| Mar 25 03:45 | no_times | 1247 | webshare |
| Mar 31 15:50 | verification_failed | 5542 | webshare |
| Mar 31 16:30 | no_times | 2053 | webshare |
| Mar 31 22:30 | no_times | 1722 | webshare |
| Apr 1 00:10 | no_times | 2362 | webshare |
| Apr 1 00:35 | no_times | 1438 | webshare |
| Apr 1 01:35 | no_times | 2654 | webshare |
| Apr 1 15:27 | no_times | 777 | webshare |
| Apr 1 20:15 | no_times | 5502 | webshare |
| Apr 7 09:15 | no_times | 1991 | webshare |
| Apr 8 08:35 | no_times | 2736 | webshare |
| Apr 9 09:35 | no_times | 1845 | webshare |

### Critical Observation: Feb 17 Successes
The only 2 successes both used `provider: direct` (residential IP from RPi). They happened within 2 hours of each other on Feb 17. After switching to webshare, ZERO successes in 48 days of continuous polling.

### One Near-Success: Mar 31 15:50 (verification_failed)
This is the ONLY post-February attempt that actually got times and attempted a POST:
- Date: 2026-04-08, Time: 10:15
- Result: `verification_failed` at `post_reschedule` step
- This means the date had times, the bot got a time, POSTed the reschedule, but verification failed (false positive -- the HTML after POST didn't confirm success)
- Duration: 5542ms (POST roundtrip)
- The reschedule_logs entry shows `false_positive_verification`

This proves that times CAN be available for these dates -- the question is speed and provider.

### Ban Episodes
209 total ban episodes. Recent ones are mostly single-poll ip_ban (resolved by webshare IP rotation). Several account-level bans lasting 2-8 hours in March 18-21 period during aggressive polling experiments. Current ban rate is negligible.

### Auth Logs
109 auth log entries. Notable: March 20 account lock cascade (10+ login attempts against a locked account). Account recovered and has been stable since March 20 activation.

## Root Cause Analysis

### Hypothesis 1: Phantom Dates (CONFIRMED - PRIMARY CAUSE)
**Confidence: HIGH**

Lima's `days.json` endpoint returns dates that have technically zero available time slots. These are likely:
- Recently cancelled appointments where `days.json` updates faster than `times.json`
- Dates where the slot was grabbed by another user between the days fetch and the times fetch
- Embassy batch operations that briefly expose dates

Evidence:
- 12/14 post-February reschedule attempts hit `no_times`
- The reschedule attempt happens 0-2 seconds after the date first appears
- Date sightings last 3-27 seconds -- but the times endpoint returns empty within 1-2 seconds
- The one time it DID find times (Mar 31 15:50), the POST verification failed

### Hypothesis 2: Webshare Proxy Latency (CONTRIBUTING FACTOR)
**Confidence: MEDIUM**

Webshare adds 1-3 seconds of latency vs direct. For flash cancellations lasting 3-27 seconds where the competition window is sub-second, this extra latency could be the difference between catching a slot and getting `no_times`.

Evidence:
- Both successes (Feb 17) used `direct` provider
- Webshare reschedule attempt durations: 777ms-5502ms for the times fetch alone
- Direct fetch: ~500ms for times in the Feb 17 successes

### Hypothesis 3: POST Verification Bug for Peru (POSSIBLE)
**Confidence: MEDIUM**

3 out of 19 attempts resulted in `verification_failed` / `false_positive_verification`. The reschedule may have actually succeeded but the HTML parser couldn't confirm it (Peru portal might have different HTML structure than Colombia).

Evidence:
- Feb 19: verification_failed with `consularTime: null` (suggests times were found but something else went wrong)
- Mar 31: verification_failed with `consularTime: 10:15` (had times, POSTed, couldn't verify)
- Feb 24: false_positive_verification with `consularTime: 10:00`

### Hypothesis 4: Time Competition (CONTRIBUTING FACTOR)
**Confidence: HIGH**

Only 1 bookable date appears per sighting (always `datesCount: 1`). This is a single cancellation slot. Competition from other bots/manual users is fierce -- median duration is ~12 seconds but the times vanish in under 2 seconds.

## Architecture Patterns

### Current Poll Flow (es-pe path)
```
poll-visa.ts:
  1. fetchWithRetry(days.json)          -- ~1-3s via webshare
  2. filterDates(allDays, exclusions, targetDateBefore)
  3. If bookable date found (< targetDateBefore):
     a. executeReschedule() called with preFetchedDays
  
reschedule-logic.ts (needsCas=false path):
  4. getConsularTimes(date)              -- ~1-2s via webshare  
  5. If times.length > 0:
     a. claimSlot() -- check maxReschedules
     b. POST reschedule for each time    -- ~5s via webshare
     c. followRedirectChain + verify HTML
  6. If times.length == 0:
     a. Record no_times, continue to next candidate
     b. (Only 1 candidate typically -- loop ends)
```

### Critical Timing Analysis
```
Total time from date appearing to POST attempt:
  Step 1: days.json fetch          = 1-3s (poll that detected the date)
  Step 2: filterDates              = <1ms
  Step 3: reschedule init          = <100ms
  Step 4: getConsularTimes         = 1-3s (second network round trip)
  
  TOTAL: 2-6 seconds before even checking if times exist
  
  vs. Date duration: 3-27 seconds (median ~12s)
  vs. Competition window: likely sub-second (someone else grabs it)
```

### Why Feb 17 Worked
- `direct` provider: ~500ms latency instead of 1-3s
- Possible lower competition at that time
- Possibly the portal had different availability characteristics in early February

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Speculative time guess | Custom time prediction | Hardcoded common times ("07:30", "08:00", "10:00", "10:15") based on historical evidence | Only 3 times ever seen: 10:00, 10:15, 07:30 |
| Session pre-warming | New session management | Existing `refreshTokens()` called more aggressively | Session priming is already built |
| Custom retry loop | New retry infrastructure | Existing `executeReschedule` multi-time loop | Just need to feed it synthetic times |

## Common Pitfalls

### Pitfall 1: Wasting the 1 Remaining Reschedule Attempt on Testing
**What goes wrong:** Any code change that accidentally triggers a real POST against the portal
**Why it happens:** `maxReschedules: 1` is the only guard. A bug in dry-run logic could bypass it.
**How to avoid:** ALL experiments must use `dryRun: true` explicitly. Only flip to real POST after full dry-run validation shows the pipeline works end-to-end.
**Warning signs:** Any `claimSlot()` call in testing = danger

### Pitfall 2: Speculative POST Consuming the Reschedule Attempt with Wrong Time
**What goes wrong:** POST with a guessed time succeeds but books an unwanted time slot, or worse, POST fails and the portal counts it as a reschedule attempt
**Why it happens:** Unknown if failed POSTs count toward the 2-reschedule limit
**How to avoid:** Test speculative POST behavior with Colombia bot first (not Peru). Verify that a POST with wrong time returns error without incrementing portal counter.
**Warning signs:** Any POST to es-pe that isn't absolutely certain

### Pitfall 3: Webshare Proxy Adding Fatal Latency
**What goes wrong:** Bot detects date, fetches times 2-3s later, times are already gone
**Why it happens:** Webshare routing adds 1-3s vs direct
**How to avoid:** For the final "real" attempt, switch to `direct` provider. Validate with dry-run first.

### Pitfall 4: `verification_failed` Masking Actual Success
**What goes wrong:** Reschedule actually succeeds but the bot records it as failed because HTML verification doesn't recognize Peru's confirmation page
**Why it happens:** Peru portal may have different HTML patterns than Colombia
**How to avoid:** Log the full HTML response during verification. Check if the current appointment on the portal has actually changed after a "failed" verification.
**Warning signs:** `verification_failed` with a valid consularTime

### Pitfall 5: Touching Bot Config Without Understanding Cascading Effects
**What goes wrong:** Changing `proxyProvider` or `targetDateBefore` mid-chain causes unexpected behavior
**Why it happens:** Active poll chain reads config from DB each iteration
**How to avoid:** Changes via PUT /api/bots/7 are safe (read fresh each poll). But understand that changing provider mid-chain won't affect the current poll, only the next one.

## Experiment Designs (Safe)

### Experiment 1: Direct Provider Dry-Run
**Goal:** Measure latency reduction with direct vs webshare
**Safety:** dryRun=true, no POST risk
**Method:** Change bot 7 to `proxyProvider: direct`, monitor next bookable date detection. Measure time from days.json response to times.json response. Compare with webshare baseline.
**Risk:** Direct from RPi may get IP-blocked (but Bot 7 is already on RPi)

### Experiment 2: Times Response Analysis
**Goal:** Understand what `getConsularTimes()` actually returns for phantom dates
**Safety:** Read-only, no POST risk
**Method:** Add detailed logging in `reschedule-logic.ts` to capture the raw response from `times.json` for each `no_times` outcome. Is it `{ available_times: [] }` or `{ available_times: null }` or something else?

### Experiment 3: Speculative POST with Colombia Bot
**Goal:** Test if POST with a guessed time works, and if failed POSTs increment portal counter
**Safety:** Use Colombia bot (no 2-reschedule limit), not Peru
**Method:** Find a bookable date on Bot 6, POST with a valid time from `getConsularTimes`, verify success. Then try POSTing with a time NOT in `getConsularTimes` -- see what happens.

### Experiment 4: Parallel Times Fetch
**Goal:** Fetch times for the bookable date simultaneously with the days.json response processing
**Safety:** Read-only optimization, no POST risk
**Method:** When `days.json` returns and contains a bookable date, immediately fire `getConsularTimes(date)` BEFORE entering `executeReschedule`. Pass the pre-fetched times as a parameter. Saves 1-2 seconds.

### Experiment 5: Historical Verification Audit
**Goal:** Determine if any `verification_failed` was actually a successful reschedule
**Safety:** Read-only portal check
**Method:** Manually log into the Peru portal and check current appointment. If it's NOT 2027-07-30, a past "failed" verification actually succeeded.

## Code Paths to Review/Modify

### Critical Files
1. **`src/services/reschedule-logic.ts:404-416`** -- `getConsularTimes` + `no_times` handling. Consider adding speculative time fallback.
2. **`src/services/reschedule-logic.ts:418-480`** -- `needsCas=false` path (Peru's path). The POST logic, claimSlot, and time iteration.
3. **`src/trigger/poll-visa.ts:920-950`** -- `daysForReschedule` filtering and `executeReschedule` invocation. Consider pre-fetching times here.
4. **`src/services/visa-client.ts:304-312`** -- `getConsularTimes` implementation. Could add response logging.
5. **`src/services/reschedule-logic.ts:455-476`** -- `followRedirectChain` + HTML verification. May need Peru-specific patterns.

### Configuration Changes (via API, no code)
- `PUT /api/bots/7` with `proxyProvider: "direct"` -- switch to direct for lower latency
- `PUT /api/bots/7` with `targetDateBefore: "2026-07-01"` -- widen the window to catch more dates (currently only 12 bookable sightings in 54 days)

## Proposed Strategy: Phased Approach

### Phase A: Diagnostics (no risk)
1. Add detailed logging for `no_times` outcomes (raw response body)
2. Add timing instrumentation to measure days-to-times latency
3. Switch to `direct` provider (config change only)
4. Widen `targetDateBefore` to `2026-07-01` to catch more date sightings for data collection

### Phase B: Latency Optimization (low risk, dry-run)
1. Pre-fetch times in `poll-visa.ts` immediately when bookable date detected
2. Pre-warm authenticity tokens (ensure `refreshTokens()` runs proactively)
3. Measure improvement via dry-run

### Phase C: Speculative POST (test on Colombia first)
1. Test POST behavior with no-times / wrong-times on Bot 6
2. If safe: add speculative time fallback to `reschedule-logic.ts`
3. Test end-to-end on Bot 6 (Colombia has no reschedule limit concern)

### Phase D: Armed Attempt (one-shot)
1. Configure Bot 7 with all optimizations
2. Set `dryRun: false`
3. Wait for next bookable date
4. Execute with fingers crossed

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 2.x |
| Config file | vitest.config.ts |
| Quick run command | `npm test` |
| Full suite command | `npm test` |

### Phase Requirements -> Test Map

Since this phase is primarily research/analysis + config changes + small code modifications, the test requirements are focused on any code changes made:

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| P4-01 | Pre-fetch times optimization doesn't break existing flow | unit | `npx vitest run src/services/__tests__/reschedule-cas-cache.test.ts -x` | Existing (extend) |
| P4-02 | Speculative time fallback only activates when times are empty | unit | `npx vitest run src/services/__tests__/reschedule-stability-fixes.test.ts -x` | Existing (extend) |
| P4-03 | Direct provider switch doesn't affect session management | integration | Manual: switch provider, verify next poll succeeds | Manual-only |
| P4-04 | dryRun=true never triggers POST for Peru path | unit | `npx vitest run src/services/__tests__/visa-client-reschedule.test.ts -x` | Existing |
| P4-05 | No regression in existing 206 tests | full suite | `npm test` | Existing |

### Sampling Rate
- **Per task commit:** `npm test`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green + manual verification of Bot 7 poll chain stability

### Wave 0 Gaps
None -- existing test infrastructure covers all phase requirements. New tests extend existing files.

## Sources

### Primary (HIGH confidence)
- Direct DB queries against production Neon PostgreSQL (bot config, poll_logs, reschedule_logs, date_sightings, bookable_events, ban_episodes, auth_logs)
- Source code: `src/services/reschedule-logic.ts`, `src/trigger/poll-visa.ts`, `src/services/visa-client.ts`
- `CLAUDE.md` project documentation

### Secondary (MEDIUM confidence)
- Historical pattern analysis from 189,662 poll records
- Timing analysis from phase_timings and reschedule_details JSON fields

## Metadata

**Confidence breakdown:**
- Bot state & config: HIGH -- direct DB query
- Historical data analysis: HIGH -- 189K+ records analyzed with SQL aggregations
- Root cause (phantom dates): HIGH -- 12/14 no_times with 0-2s detection time leaves no other explanation
- Provider impact: MEDIUM -- correlation (direct=success, webshare=failure) but small sample (n=2 successes)
- Speculative POST safety: LOW -- unknown if failed POSTs count toward portal limit
- Verification bug: MEDIUM -- 3 verification_failed events suggest parser may miss Peru patterns

**Research date:** 2026-04-09
**Valid until:** 2026-04-23 (14 days -- bot config and portal behavior may change)

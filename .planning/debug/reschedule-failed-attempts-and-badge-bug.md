---
status: awaiting_human_verify
trigger: "Bots #41, #42, #43, #48, #49 show hundreds of intentos fallidos (442–1036). Green badge shows → 9 abr 07:30 but actual consular date is still May 2026."
created: 2026-04-03T00:00:00Z
updated: 2026-04-03T20:00:00Z
---

## Current Focus

hypothesis: All 3 known bugs fixed. New "original date overwritten" bug root cause identified.
test: npm test — 163/163 passing
expecting: Human verification of fix behavior in production
next_action: Await human confirm that false-positive loop stops and badge clears after portal reversion

## Symptoms

expected: Reschedule attempts should succeed when a better slot is found. The green badge should correctly 
  reflect the actual rescheduled appointment date.
actual: |
  - Bots #41, #42, #43 show "→ 9 abr 07:30 hace 3h-7h" with 442–1036 failed attempts
  - Bot #49 shows "→ 9 abr 07:30 hace 12h" with 616 failed attempts
  - Bot #48 shows 65 failed attempts with no green success badge
  - Current consular date for those bots is still May 2026 — Apr 9 would be a valid improvement
  - "intentos fallidos" count is enormous: hundreds of failures
errors: false_positive_verification, verification_failed@07:30
reproduction: Check reschedule_logs for bots 41, 42, 43, 48, 49 via API or DB
started: false_positive_verification started 2026-03-31T18:52Z for bot 41

## Eliminated

- hypothesis: CAS unavailability blocking all reschedules
  evidence: "no_cas_days" is present but a minority (39 entries). 803 of 994 failures are 
    false_positive_verification / verification_failed — a separate root cause.
  timestamp: 2026-04-03T18:00Z

- hypothesis: Race condition between multiple bots competing for Apr 9 07:30
  evidence: The slot IS taken but not by our bots (they keep failing false_positive_verification,
    meaning the POST "succeeds" but the appointment doesn't change — consistent with a slot already
    taken by someone else on the portal). This is the correct behavior from verification. The bug is
    that the bot keeps retrying the same exhausted slot on every poll.
  timestamp: 2026-04-03T18:00Z

- hypothesis: Optimistic DB write before verification causes "original date overwritten"
  evidence: In executeReschedule, verification (getCurrentAppointment) happens BEFORE the DB write.
    Lines 417-446 run the check first; db.update at line 460 only executes after verified===true.
    So the no-CAS path does NOT write to DB on false_positive_verification.
  timestamp: 2026-04-03T20:00Z

## Evidence

- timestamp: 2026-04-03T18:00Z
  checked: reschedule_logs for bot 41 (last 1000 rows)
  found: |
    - Total: 1000 rows. 6 success, 994 failed.
    - Dominant error: "false_positive_verification" = 465 rows
    - Second dominant: "2026-04-09:verification_failed@07:30" = 338 rows (the summary log per-poll)
    - Both are ALWAYS for Apr 9 07:30 — no other date being tried
    - Failures started 2026-03-31T18:52Z and continued until 2026-04-03T12:50Z
    - 6 successes: all newConsularDate=2026-04-09 07:30 (except 2 entries from 2026-03-31)
    - Successes at: 2026-04-02T10:00Z, 2026-04-03T11:05Z, 11:12Z, 12:20Z
    - But currentConsularDate in DB is STILL 2026-04-28 (not 2026-04-09)
  implication: |
    The April 9 slot was taken by someone else. Our bots POST to reschedule and get a fake 302 
    success redirect (known portal behavior — "slot taken by another user, redirect still goes to 
    /instructions"), but getCurrentAppointment() returns Apr 28 not Apr 9. The verification 
    correctly marks this as false_positive_verification and adds Apr 9 to exhaustedDates within 
    that executeReschedule call. But exhaustedDates is a local Set — it does NOT persist to the 
    next poll. So the next poll (10-30s later) tries Apr 9 again, same result. Loops indefinitely.

- timestamp: 2026-04-03T18:05Z
  checked: Success log entries for bot 41
  found: |
    - Successes 7807, 7822, 8059 all show oldConsularDate=2026-04-28 despite the previous success 
      at 10:00Z (id 4481) having set newConsularDate=2026-04-09
    - Entry 2587 ([post_error_recovered]) shows success FROM Apr 10 BACK TO Apr 28 — confirms 
      portal reversion behavior during the "try to improve" loop
    - After the last success (8059, 12:20Z), the NEXT poll (8060, 12:24Z) again shows 
      oldConsularDate=2026-04-28 — the DB was not updated to Apr 9 OR was reverted
  implication: |
    The "successes" (7807, 7822, 8059) where the bot "succeeded" in booking Apr 9, the final 
    verification in executeReschedule PASSED (because getCurrentAppointment returned Apr 9 at that 
    moment), DB was updated to Apr 9. But then the PORTAL REVERTED the booking back to Apr 28 
    server-side. On the next poll, getCurrentAppointment() returns Apr 28 → sync block in poll-visa 
    detects change → overwrites DB back to Apr 28. This is correct behavior for sync, but the 
    badge had already logged success=true for Apr 9.

- timestamp: 2026-04-03T18:10Z
  checked: reschedule-logic.ts exhaustedDates and portal reversion paths
  found: |
    - exhaustedDates = new Set<string>() — local to each executeReschedule() call, NOT persisted
    - After false_positive_verification, exhaustedDates.add(candidate.date) prevents re-trying 
      within the SAME call (up to maxAttempts=5), but the NEXT poll call starts with a fresh empty Set
    - portal_reversion: after securedResult, the final verification at line 900 checks if 
      getCurrentAppointment() still matches. If portal reverted to Apr 28, sets DB back to Apr 28 
      (line 910) and returns success:false with reason='portal_reversion'. Zero portal_reversion 
      logs in reschedule_logs — the code returned before any failure log was written.
  implication: |
    Two separate bugs:
    1. exhaustedDates not persisted → bot retries same failing slot forever (hundreds of failures)
    2. Portal reversion: booking Apr 9 succeeds, portal immediately reverts it, DB syncs back to 
       Apr 28, no log entry for the reversion event specifically.

- timestamp: 2026-04-03T18:15Z
  checked: /api/bots/landing query for events (failedCount and successes)
  found: |
    - failedCount = COUNT of reschedule_logs rows where success=false in last 24h
    - successes = reschedule_logs rows where success=true in last 24h, ordered desc
    - The green badge (ev-pill ev-ok "→ 9 abr 07:30") comes from successes[0].date/time
    - Since the bot logged success=true for Apr 9 07:30 at 12:20Z today, the badge shows that
    - This is technically CORRECT behavior for the badge — it shows the last logged success
    - The "confusion" arises because the actual current appointment reverted to Apr 28 after 
      the success was logged
  implication: |
    The green badge showing "→ 9 abr 07:30" is not a bug in dashboard logic per se. It correctly 
    reads from reschedule_logs. The underlying problem is that the bot logged a "success" that was 
    later reverted by the portal (portal reversion), and the badge had no awareness of this.

- timestamp: 2026-04-03T18:20Z
  checked: Error format in reschedule_logs for false_positive_verification
  found: |
    Each poll generates EXACTLY 2 reschedule_logs rows:
    Row 1 (from inner CAS loop, line 650): success=false, error='false_positive_verification', 
           newConsularDate=Apr9, newConsularTime=07:30 (has the time)
    Row 2 (from final summary, line 960): success=false, error='2026-04-09:verification_failed@07:30', 
           newConsularDate=Apr9, newConsularTime=null (no time — uses failSummary format)
    So each poll that finds Apr 9 and attempts it generates 2 entries.
    With ~30s poll interval for these bots over 3-12 hours = hundreds of entries per bot.
  implication: |
    The failedCount shown in the dashboard is DOUBLE the actual number of poll attempts. Each 
    "attempt" generates 2 log rows. The "442-1036 intentos fallidos" is actually 221-518 unique 
    poll attempts that each tried Apr 9 and got a false positive verification.

- timestamp: 2026-04-03T20:00Z
  checked: All write points for currentConsularDate across entire codebase
  found: |
    Write points for currentConsularDate:
    
    A) reschedule-logic.ts executeReschedule():
       - No-CAS success path (line 460): writes after verification passes — SAFE
       - CAS success path (line 684): writes after verification passes — SAFE
       - Post-error verification sync (line 773): writes actual portal state — SAFE
       - Portal reversion sync (line 910): writes actual portal state — SAFE (now also logs)
    
    B) poll-visa.ts appointment sync block (lines 517+522-527):
       - Runs on every poll if getCurrentAppointment() returns a different date
       - Blindly writes whatever the portal HTML parser returns
       - NO guard checking if new date is better/worse than current DB value
       - POTENTIAL BUG: if portal has propagation delay after a real reschedule, the next poll
         could see the old date and overwrite the new one back to the old one
       - Also: if the portal reverts a reschedule, this correctly syncs DB back to the reverted date
    
    C) PUT /api/bots/:id (bots.ts line 875):
       - Direct API write, no guard — intentional (admin use)
    
    D) Bot create endpoint (bots.ts ~line 429): sets initial value on creation
  implication: |
    The most likely path for "original date overwritten unexpectedly":
    
    SCENARIO 1 — Portal propagation delay:
    executeReschedule writes Apr 9 to DB at T=0. At T=10s (next poll), getCurrentAppointment() 
    fetches /groups/{userId}. If the portal has propagation delay and still shows Apr 28, the 
    appointment sync block fires: changed=true → overwrites DB back to Apr 28. This could explain 
    intermittent reversions where the reschedule "seemed to work" but the DB reverted quickly.
    
    SCENARIO 2 — portal_reversion (confirmed root cause for the Apr 9 cases):
    executeReschedule successfully books Apr 9, writes DB. The "try to improve" second POST 
    causes the portal to revert Apr 9 → Apr 28. Final verification catches this, syncs DB back 
    to Apr 28. This is intentional behavior — the sync is correct — but it was previously silent.
    With Fix 2, portal_reversion events are now logged in reschedule_logs.
    
    SCENARIO 3 — No concurrent chains after scout/subscriber removal:
    The isScout/isSubscriber architecture was removed (v20260303.14). The dedup guard at line 782 
    prevents the same bot rescheduling twice within 3 minutes. No cross-bot overwrite risk.

## Resolution

root_cause: |
  THREE ROOT CAUSES:
  
  1. INFINITE RETRY LOOP (primary cause of hundreds of failures):
     Apr 9 07:30 is a ghost slot — POST appears to succeed (302 redirect) but appointment 
     never changes. exhaustedDates prevents retry within a single executeReschedule() call 
     but is NOT persisted between polls. No mechanism blocked the date cross-poll for 
     false_positive_verification (only no_cas_days were blocked via blockedConsularDates).
  
  2. PORTAL REVERSION SILENT (explains why currentConsularDate reverts to Apr 28):
     When the "secure then improve" second POST causes portal reversion, executeReschedule 
     catches it, syncs DB back to Apr 28, but wrote NO reschedule_logs entry with reason=
     portal_reversion. No visibility into how often this happens.
     
  3. BADGE STALE VICTORY (explains "→ 9 abr 07:30" badge with wrong current date):
     Badge showed last success=true log's newConsularDate regardless of whether 
     bots.currentConsularDate still matches. After portal reversion, badge showed the 
     reverted-away date as a "success" indefinitely.

  TASK 2 — "ORIGINAL DATE OVERWRITTEN" BUG:
  Root cause is primarily SCENARIO 1 (portal propagation delay) and SCENARIO 2 (portal_reversion).
  The appointment sync block in poll-visa.ts correctly syncs DB to portal state, but this means
  a just-rescheduled appointment can be overwritten if:
  (a) Portal shows old date during propagation delay (~seconds after reschedule)
  (b) Portal reverts the reschedule (portal_reversion confirmed behavior)
  No fix is recommended for the sync block itself — it's correct behavior. Fix 2 (logging 
  portal_reversion) provides visibility. Fix 1 (blocking false-positive dates) prevents the 
  ghost slot from triggering repeated reschedule/reversion cycles.

fix: |
  FIX 1 — Persist false-positive dates to blockedConsularDates (2h TTL):
  Files: src/services/reschedule-logic.ts, src/trigger/poll-visa.ts
  - Added falsePositiveDates Set to executeReschedule()
  - Both false_positive_verification spots (no-CAS and CAS paths) now add to falsePositiveDates
  - RescheduleResult interface extended with falsePositiveDates?: string[]
  - All return paths include falsePositiveDates
  - poll-visa.ts: after executeReschedule, blocks falsePositiveDates with 2h TTL in 
    blockedConsularDates (same jsonb_set mechanism as no_cas_days but 2h instead of 30m)
  
  FIX 2 — Log portal_reversion as failure in reschedule_logs:
  File: src/services/reschedule-logic.ts
  - portal_reversion path (line 908) now inserts reschedule_logs row with:
    success=false, error='portal_reversion',
    oldConsularDate=securedResult.date (what we thought we secured),
    newConsularDate=finalAppt.consularDate (what the portal reverted to)
  
  FIX 3 — Badge only shows success when newConsularDate matches currentConsularDate:
  File: src/api/bots.ts
  - /landing endpoint: events loop now only adds to successes[] if newConsularDate === 
    botCurrentDate[r.botId] (current appointment from bots table)
  - /recent-events endpoint: same guard added with a parallel bots query for current dates

verification: |
  npm test: 163/163 tests passing. No regressions.
  Behavioral verification needed in production:
  - After next poll with Apr 9 false_positive: date should be blocked for 2h, loop stops
  - portal_reversion events should appear in reschedule_logs with error='portal_reversion'
  - Badge should clear for bots where currentConsularDate != last success log's newConsularDate

files_changed:
  - src/services/reschedule-logic.ts
  - src/trigger/poll-visa.ts
  - src/api/bots.ts

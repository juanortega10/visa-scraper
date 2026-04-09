---
phase: 4
slug: bot-7-peru-research-y-plan-para-lograr-reagendamiento-exitoso
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-04-09
---

# Phase 4 -- Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npm test` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 4-01-01 | 01 | 1 | DIAG-01, DIAG-02 | unit | `npm test` | existing | pending |
| 4-01-02 | 01 | 1 | FIX-01 | unit | `npm test` | existing | pending |
| 4-02-01 | 02 | 1 | FIX-02, FIX-03, TEST-01 | unit | `npx vitest run src/services/__tests__/reschedule-stability-fixes.test.ts -x` | existing (extend) | pending |
| 4-02-02 | 02 | 1 | FIX-02 | checkpoint | N/A (human-verify) | N/A | pending |
| 4-03-01 | 03 | 2 | CONFIG-01, CONFIG-02 | integration | `curl -s "https://visa.homiapp.xyz/api/bots/7" \| jq -e '.proxyProvider == "direct" and .targetDateBefore == "2026-07-01" and .speculativeTimeFallback == false'` | N/A | pending |
| 4-03-02 | 03 | 2 | VERIFY-01 | checkpoint | `curl -s "https://visa.homiapp.xyz/api/bots/7/logs/polls?limit=3" \| jq -e 'length > 0'` | N/A | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements (vitest already installed, scripts pattern established). No Wave 0 gaps.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Phantom date detection | DIAG-01 | Requires live API call to Lima facility 115 | Check RPi logs for `rawTimesResponse` after phantom date sighting |
| Provider latency comparison | DIAG-02 | Requires live direct vs webshare comparison | Check `timesToFetchMs` in RPi logs after switching to direct |
| Verification parser for es-pe | FIX-01 | Requires actual Peru portal HTML | Query reschedule_logs for verification_failed entries; enhanced diagnostic logging captures body on next occurrence |
| Speculative fallback dry-run review | FIX-02 | User must review risk before enabling | Plan 02 checkpoint: review phantom-date logs, then enable speculativeTimeFallback |
| Armed reschedule success | FINAL | Cannot automate -- uses the 1 remaining attempt | Monitor bot 7 after enabling speculativeTimeFallback via API |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

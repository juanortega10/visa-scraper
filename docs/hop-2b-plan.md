# Hop 2b — Persistent cloud poller (executable plan)

> Replace the Trigger.dev poll **chains** with one long-lived cloud worker process that owns the polling
> loop, egresses via **webshare** (proven from cloud, 2026-06-11), and holds hot state in memory. Trigger.dev
> keeps the durable jobs (login-recovery, notify, reschedule wrapper, prefetch-cas, prune-logs), which the
> worker triggers via the SDK. Outcome: no RPi, no chain orchestration (orphan/dedup/self-trigger gone),
> no per-poll DB read-amplification, clean single-owner-per-bot.

**Grounding:** code map of `poll-visa.ts` (1964 lines) shows ~80% of the poll logic is already portable.
The portable helpers are untouched: `executeReschedule` (reschedule-logic.ts), `scheduling.ts`
(`getPollingDelay`/`calculatePriority`/`isInSuperCriticalWindow`/`getEffectiveInterval`), `visa-client.ts`,
`proxy-fetch.ts`, `login.ts:performLogin`, `date-helpers.ts`, `date-failure-tracker.ts`, `poll-logging.ts`.

---

## Architecture

```
┌─────────────────────────── WORKER PROCESS (cloud VM, always-on) ───────────────────────────┐
│  reload loop (every ~30-60s): load bots WHERE status=active AND runtime='worker'             │
│  ┌─────────────┐   per-bot in-memory state: session, lastDates, backoff counters, banFlag    │
│  │  Scheduler  │   (replaces the ~7-15 per-poll DB reads → read-amplification dies)          │
│  │ (min-heap   │                                                                              │
│  │  nextPollAt)│──due──▶ concurrency limiter (N≈pool size) ──▶ pollBotOnce(bot, state, deps) │
│  └─────────────┘                                              │  returns PollOutcome          │
│        ▲                                                       ▼                              │
│        └── schedule next poll at now+outcome.nextDelay ◀── act on outcome:                   │
│                                                          • persist material events (DB)       │
│   egress: webshare pool (proxy-fetch.ts)                 • update in-mem state                │
│   single-owner: in-process per-bot lock (Map)            • trigger notify/login (Trigger SDK) │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
        │ triggers durable jobs via @trigger.dev SDK
        ▼
   Trigger.dev (PRODUCTION): login-visa, notify-user, reschedule-visa, prefetch-cas, prune-logs
```

**Key design choices**
- **`pollBotOnce()` returns side-effects as DATA** (`nextDelay`, `shouldChain`, `newSession`, `events[]`,
  `notifications[]`, `loginRequest?`) — it does NOT call `.trigger()` or `runs.*` itself. The worker (and,
  during migration, the Trigger task) decide what to do with the outcome. This is what makes it runtime-agnostic.
- **Orphan/dedup disappear**: one process is the single owner; an in-process `Map<botId, lock>` guarantees one
  in-flight poll per bot. No `runs.retrieve/list/cancel`.
- **Self-trigger disappears**: the scheduler re-enqueues the bot at `now + outcome.nextDelay`.
- **Notifications/login-recovery stay durable**: the worker triggers `notify-user`/`login-visa` via the Trigger
  SDK (works from any Node process with the prod secret key). Don't reinvent durable jobs.

---

## Task breakdown (executable, sequenced)

### 2b.0 — Decisions / pre-work
- [ ] **Cloud host:** recommend **Fly.io** (cheap always-on single process, easy secrets, real `setTimeout`,
      SIGTERM graceful shutdown). Alternatives: Railway, Render, a small VPS. *Decision needed.*
- [ ] Confirm the worker can **trigger Trigger.dev tasks via SDK** (`tasks.trigger('notify-user', ...)`) using
      a prod secret key (`tr_prod_...` from the visa account → worker env).
- [ ] Full env-var set for the worker host (DATABASE_URL, MASTER_ENCRYPTION_KEY, WEBSHARE_API_KEY,
      RESEND_API_KEY, TRIGGER secret, ADMIN_*). Same set prod already has (§A2 validated).

### 2b.1 — Ownership lever (small, ship first, independently safe)
- [ ] Add `runtime` column to `bots`: `varchar` `'chain' | 'worker'`, default `'chain'`. Migration + `db:push`.
- [ ] **Guard in `poll-cron.ts`** (~line 30 filter): skip bots where `runtime='worker'`.
- [ ] **Guard in `poll-visa.ts run()`** (next to the env guard ~line 168): early-exit if `bot.runtime='worker'`
      → "owned by worker, chain yielding". *(Also fix the missing dev-side env guard while here — see §risk.)*
- [ ] Tool: `scripts/set-runtime.ts <botId> <chain|worker>` (clone of `set-poll-env.ts`, single-owner safe).
- [ ] **Verify:** flip a paused/pilot bot to `runtime='worker'` → confirm no chain polls it (it goes idle; the
      worker doesn't exist yet, so this only proves the chain *yields*). Rollback by flipping back.

### 2b.2 — Extract the poll core (highest effort/risk — do with tests, keep Trigger path green)
- [ ] Create `src/services/poll-core.ts` → `export async function pollBotOnce(input): Promise<PollOutcome>`.
- [ ] Move the portable logic out of `poll-visa.ts`: session decrypt + client setup (l.419-435), pre-emptive
      re-login (l.331-417), fetch+filter+evaluate (l.464-819 minus loop orchestration), inline reschedule
      (calls `executeReschedule`), date-change detection, ban-episode state, poll-log row construction,
      backoff/delay computation (l.1607-1685).
- [ ] Replace Trigger couplings with **injected deps**: `logger` (injectable; pino in worker, Trigger logger in
      task), `runId` (uuid), and **return** notifications/login-requests/self-delay as data — never `.trigger()`
      or `runs.*` inside the core.
- [ ] **Refactor `poll-visa.ts` to call `pollBotOnce`** then do only its Trigger-specific bits (self-trigger
      with `outcome.nextDelay`, fire `notify`/`login` triggers, orphan/dedup). → single source of truth; the
      live chain keeps working through the whole migration.
- [ ] Unit tests for `pollBotOnce` (extend existing reschedule/poll-logging tests). `npm test` green.

### 2b.3 — The worker process
- [ ] `src/worker/index.ts` (entry: bootstrap, reload loop, graceful shutdown), `src/worker/scheduler.ts`
      (min-heap of `{botId, nextPollAt}`, concurrency limiter), `src/worker/bot-state.ts` (per-bot in-memory
      cache: session, exclusions, lastDates, backoff counters, banFlag).
- [ ] Reload loop: every ~30-60s load owned active bots; add new, drop removed/paused; refresh external state
      (status changes, config edits) without dropping in-memory hot state.
- [ ] Execute: on due, acquire per-bot lock → `pollBotOnce` → persist material events + heartbeat poll_log →
      update in-mem state → schedule next at `now+nextDelay` → fire notify/login triggers.
- [ ] **In-memory state replaces the per-poll DB reads** (l.259-328, 628-632, 1607-1644) — load once, refresh
      per reload. This is where read-amplification dies.
- [ ] SIGTERM: stop scheduling, let in-flight polls finish, flush, exit.

### 2b.4 — Deploy infra
- [ ] Dockerfile + host config (e.g. `fly.toml`): single instance, restart-on-crash, healthcheck endpoint
      (`/health` returns scheduler depth + last-poll age), env vars/secrets.
- [ ] Logging to host stdout; basic alert if the loop stalls (no polls in N min).

### 2b.5 — Canary migration (clean cutover — no chain collision this time)
- [ ] Per bot: `set-runtime.ts <id> worker` → chain stops (2b.1 guard) → worker picks it up on next reload.
      **No dev↔cloud chain collision** because chains skip `runtime='worker'` and only the worker polls them.
- [ ] Waves: 1 pilot → soak 24-48h → 3-5 → 25% → 50% → 100%. Gates: soft_ban %, poll-success %, reschedule
      catches, session stability vs the bot's own baseline. **Rollback:** `set-runtime.ts <id> chain`.

### 2b.6 — Decommission
- [ ] 100% on worker + soaked → turn off the **RPi**; delete chain code: poll-cron self-trigger, orphan
      detection, dedup, `cancelPreviousRun`, `ensure-chain`, the 90s batch loop + super-critical in-run loop
      (the worker's scheduler handles cadence natively). Big subtraction.

---

## Risk notes (from the code map)

- **Single-owner is now in-process, not Trigger orphan/dedup.** A `Map<botId, inFlight>` lock + the
  `runtime='worker'` partition guarantee one owner. The ONE hazard: running **two worker instances** → both poll
  every owned bot. Mitigation: single instance (Fly `count=1`), or a DB advisory lock per bot if you later shard.
- **No dev-side env guard today** (`poll-visa.ts:168` only stops cloud runs). The `runtime` guard in 2b.1 closes
  this for the worker migration; also add the symmetric dev guard so a `['prod']`/worker bot can't be double-driven.
- **Batch loop & super-critical in-run loops collapse into the scheduler.** The worker doesn't need the 90s
  batch loop or the 8:58-9:08 continuous loop — it just schedules at the right cadence (`getPollingDelay`,
  with a tighter interval during the super-critical window). Simpler, but must replicate the *cadence*, not the loop.
- **Session persistence races:** always persist session after re-login; on error re-read from DB before retry
  (worker holds it in memory but DB is the source of truth across restarts).
- **Ban-episode state machine:** worker must open/close episodes transactionally and re-sync `endedAt IS NULL`
  on reload so a crash can't strand a bot in `hasOpenBanEpisode=true`.
- **Notifications/login are fire-and-forget triggers** to Trigger.dev — non-fatal if the queue is down, but log it.

---

## Sequencing & ROI

- **2b.1 is shippable today** (small, safe, reversible) and unblocks everything.
- **2b.2 is the crux** — once the core is extracted and the Trigger path is refactored to use it, the worker
  (2b.3) is "drive the core from a loop." Do 2b.2 carefully with tests; the live fleet keeps running on chains.
- 2b.3/2b.4 can proceed in parallel once 2b.2 lands.
- Interaction with **Fase 1 (telemetry off Neon):** the worker should write heartbeat poll_logs via the same
  `poll-logging.ts` gate; moving the firehose to a sink (Fase 1) is independent and can come before or after.

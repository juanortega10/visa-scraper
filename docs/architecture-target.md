# Target Architecture — Visa Bot at 300–1000 active bots

> **Status:** design / north-star. Not a commitment to build all of it now. Implement by phases
> (see §11). The point of this doc is to make every interim decision compatible with the target,
> so we never paint ourselves into a corner.
>
> **The one-line thesis:** This is not a compute-scaling problem. It is a **rate-limited work-distribution
> problem over a scarce pool of residential IPs.** The architecture is organized around the IP as the
> first-class scarce resource, not around servers.

---

## 1. Constraints & invariants (the physics — design must obey these)

These come from hard-won production learnings (see `CLAUDE.md` + memory). They are not negotiable; the
architecture exists to respect them.

| # | Invariant | Source | Architectural consequence |
|---|-----------|--------|---------------------------|
| I1 | **Polls cannot be shared or deduplicated.** Availability depends on `scheduleId` (# applicants). Two bots in the same city see different dates. | per-schedule availability | Poll work is **linear in bot count**. No fan-out/broadcast saves work. Pub/sub does NOT apply to polling. |
| I2 | **The scarce resource is the webshare-pool IP request budget** (avoiding `soft_ban`), per-IP, with a secondary per-account ceiling. **Not residential IPs** — datacenter proxy pool works. | 28 bots sustained on webshare, ~115K polls/day, soft_ban 0-2% | The scheduler must treat **per-IP token budget + soft_ban rate** as a hard constraint, and IP↔account mapping as a design choice (fingerprinting risk). |
| I3 | **Login works via the webshare IP pool** — 8/8 success on 2026-06-09; the 2026-06-03 "datacenter blocked on sign_in" finding no longer reproduces (pending multi-day stability confirmation). | re-tested 2026-06-09 (bot 6) | Login is **distributable across IPs** — **no residential host / RPi required.** Removes the single-IP login bottleneck and the entire login-storm throttle rationale. Confirm stability over several days before flipping `loginRouted` in production. |
| I4 | **Reschedule POST: webshare works** (Bright Data POST=402, GET only). Must never be lost or duplicated. | provider tests | Reschedule is a **durable, idempotent job** routed via **webshare** (no residential host needed) — NOT part of the poll loop's fire-and-forget. |
| I5 | **NEVER reschedule to a date ≥ current.** The slot is permanently lost. | CRITICAL RULE | The strictly-earlier guard lives in the reschedule executor, server-side of any queue. Non-bypassable. |
| I6 | **Bans escalate if you retry aggressively.** Blocks can be IP-level OR account-level. | TCP backoff logic | Backoff state is per-bot AND per-IP; a banned IP must be drained, a banned account must be paused — independently. |
| I7 | **Telemetry (`poll_logs`) is observability, not state.** 99% of current DB, append-only, read only in minute-windows. | measured: 9.6 GB / 9.7 GB | Telemetry must live **outside the OLTP DB**, in a cheap append/columnar sink. |
| I8 | **Webshare handles sustained es-co polling in production** — 28 bots, ~115K polls/day, soft_ban 0-2% typical (occasional spikes). The 2026-02-20 bot-12 block was a pre-circuit-breaker single-IP incident, NOT representative. | measured 2026-06-10 | Polling egress = **webshare pool**, made viable by `ProxyPoolManager` (breaker + recency penalty). Caveat: webshare is **noisier than direct** (~12% error / 2-4% soft_ban vs ~2%) and **rate-sensitive** → pool sizing + rate governance matter at 300-1000 bots. **No residential host / RPi needed for polling.** |

---

## 2. Capacity model — sizing for the target (do the math first)

Rough, conservative, to size the system. Tune with real measurement (Phase 0).

**Egress = webshare proxy pool** (datacenter, authenticated JSON GET — validated sustained, I8). Per-IP
sustainable rate is whatever keeps `soft_ban` low; `ProxyPoolManager` spreads load across the pool with a
recency penalty. Treat **soft_ban rate as the live signal**, not a fixed req/min guess.

**Observed production cadence (2026-06-10):** 28 bots → ~115K polls/day ≈ **~2.85 polls/min/bot** (≈20s
interval). That is the current default; **cadence is the dominant scaling lever** — most non-critical bots
could run slower (e.g. 60-90s) to cut fleet load 3-4×, reserving fast cadence for priority/drop-window bots.

| Bots | @ current ~2.85/min/bot | @ tiered cadence (~0.7/min avg) |
|------|--------------------------|----------------------------------|
| 300  | ~855 polls/min | ~210 polls/min |
| 600  | ~1700 polls/min | ~420 polls/min |
| 1000 | ~2850 polls/min | ~700 polls/min |

**Takeaways:**
- The cost lever at scale is **cadence policy + webshare pool size**, not residential IPs (there are none). Tiered cadence (slow the boring bots) is the cheapest 3-4× headroom available.
- One worker drives **many** IPs (I/O-bound), but binding **1 worker ≈ 1 pool IP** keeps rate accounting, session affinity, and ban isolation trivially local.
- Per-account ceiling is NOT binding as long as per-bot cadence stays ≤ ~3/min — which it does. The binding constraint is **per-IP soft_ban avoidance** across the shared pool.

---

## 3. Component overview

```
                         ┌──────────────────────────────┐
                         │  SCHEDULER / PLANNER           │  "when should each bot poll?"
                         │  (scheduling.ts as a service)  │  priority = criticality × drop-window × backoff
                         └───────────────┬────────────────┘
                                         │ enqueue poll-job { botId, priority, notBefore, ipGroup? }
                                         ▼
                         ┌──────────────────────────────┐
                         │   POLL QUEUE  (Redis/BullMQ)   │  priority + delayed visibility
                         │   rate-limiter per IP group    │  backpressure when IPs saturated
                         └───────────────┬────────────────┘
            ┌────────────────────────────┼────────────────────────────┐
            ▼                            ▼                             ▼
   ┌─────────────────┐         ┌─────────────────┐          ┌─────────────────┐
   │ WORKER (IP=res1) │        │ WORKER (IP=res2) │   ...    │ WORKER (IP=RPi)  │  1 worker ≈ 1 IP
   │ session cache    │        │ session cache    │          │ (also does login │  hot state in mem
   │ token-bucket     │        │ token-bucket     │          │  + reschedule)   │  backoff local
   └────────┬─────────┘        └────────┬─────────┘          └────────┬─────────┘
            │ poll → evaluate → if material event, emit       │
            ▼                                                 ▼
   ┌────────────────────────────── EVENT BUS (pub/sub) ──────────────────────────────┐
   │  topics: date.appeared · reschedule.requested · reschedule.succeeded ·           │
   │          ban.opened · ban.recovered · session.expired                            │
   └───┬───────────────────┬───────────────────┬───────────────────┬─────────────────┘
       ▼                   ▼                   ▼                   ▼
  ┌──────────┐     ┌────────────────┐   ┌──────────────┐   ┌──────────────────┐
  │ DURABLE  │     │ TELEMETRY SINK │   │  PRODUCT DB   │   │  NOTIFY / WEBHOOK │
  │ JOBS     │     │ (ClickHouse/   │   │  (Neon PG,    │   │  (email, WA,      │
  │(Trigger) │     │  Tinybird/S3)  │   │   ~75 MB)     │   │   dashboard live) │
  │ reschedule POST │ poll firehose,│   │ bots, resched,│   └──────────────────┘
  │ login recovery  │ sightings,    │   │ agencies,     │
  │ prefetch-cas    │ ban episodes  │   │ excluded, ... │
  └──────────────┘  └────────────────┘   └──────────────┘
```

---

## 4. Scheduler / Planner

**Responsibility:** decide *when* each bot should next be polled, and at what priority. This is your existing
`scheduling.ts` brain (`getPollingDelay`, `getCurrentPhase`, `DROP_SCHEDULES`) promoted from a per-run
recomputation into a **central, continuously-running planner**.

- Holds a min-heap / sorted set of `{ botId, nextPollAt, priority }` in Redis (`ZADD` by score = timestamp).
- A tick loop pops due bots and enqueues poll-jobs. Priority blends:
  `criticality (how close/critical the bot's current date is) × drop-window multiplier × backoff penalty`.
- **Backoff lives here as scheduling, not as a per-run DB read.** A bot in TCP-backoff simply gets a later
  `nextPollAt`. No more reading "last 5 poll_logs" on every run (kills the read-amplification).
- **Per-account safety cap** enforced here: never schedule a bot more than N/min regardless of priority.

**Why central, not per-bot cron:** at 1000 bots, 1000 crons is unmanageable and Trigger's 1-min floor forces
the chain hack. A single planner with a Redis sorted set gives arbitrary sub-second cadence, global priority,
and one place to reason about fairness.

---

## 5. Poll Queue (Redis + BullMQ)

**Why a queue and not chains:** the queue gives you, for free, everything the chain hack reimplements badly —
backpressure, priority, retry, delayed visibility, and **fair work distribution across IPs**. It also has a
single owner per job, so the entire `activeRunId` / orphan-detection / self-cancel saga **disappears**.

- **One queue, partitioned by IP group** via BullMQ rate-limiter groups (or one queue per IP group). Each
  group has a **token bucket = that IP's sustainable rate**. When an IP saturates, its jobs wait — automatic
  backpressure, no IP ever over-polled.
- Jobs carry `{ botId, priority, attempt }`. Delayed jobs implement cadence; priority implements drop-window urgency.
- Dead-letter for jobs that exhaust retries → emits `ban.opened` / alerts.

---

## 6. Workers

**Model: 1 worker process ≈ 1 egress IP** (a proxy-pool IP, not a physical host). Workers run in the **cloud**
(cheap always-on containers/VMs) and egress through the proxy pool — **no RPi, no physical residential box.**
Many workers per host (I/O-bound). The worker is the only thing that touches the embassy for its IP, so all
rate/session/ban state is **local and in-memory**.

> **Egress per traffic type (I3/I4/I8):** login → webshare pool (validated 8/8, confirm stability); reschedule
> POST → webshare; **sustained polling → the open question** (cloud-direct at low per-IP rate, or a residential
> proxy pool like Bright Data residential GET — must be validated before retiring the RPi for polling).

Each worker:
1. Pulls poll-jobs for its IP group (respecting the local token bucket).
2. **Holds the session in memory** (cookie + CSRF), persisted to Redis for crash-restart. **Zero per-poll DB read.**
3. Executes `days.json` → evaluates against the bot's `currentConsularDate` + guards (excluded dates, strictly-earlier, target cutoff) held in a periodically-refreshed in-memory config snapshot.
4. On a **material event** (earlier date found, ban, sighting, session expiry) → emits an event to the bus. On a **boring poll** → optionally samples to telemetry (heartbeat), never to Postgres.
5. If an earlier bookable date is found → emits `reschedule.requested` (does NOT do the POST inline — see §8).

**IP↔account affinity decision (flag for §13):** for realism, prefer **sticky-ish** mapping (an account mostly
polled from a stable IP, like a real user) over pure rotation. A single IP fanning 40 accounts' auth traffic is
a fingerprint. Sticky pools per region are the safer default; rotate only on IP death/ban.

**Ban isolation:** a worker that detects an IP-level block drains its bucket and signals the planner to
reroute its bots to healthy IPs; an account-level block pauses *that bot* across all IPs.

---

## 7. Event bus (pub/sub) — the side-effect plane

This is where pub/sub legitimately belongs (NOT on the polls). Workers publish facts; many independent
consumers react. Decouples the hot poll loop from everything slow.

| Topic | Published when | Consumers |
|-------|----------------|-----------|
| `reschedule.requested` | worker finds bookable earlier date | durable reschedule job |
| `reschedule.succeeded` / `.failed` | reschedule job completes | notify, dashboard, product DB, telemetry |
| `date.appeared` / `date.disappeared` | sighting delta | telemetry (sightings), analytics |
| `ban.opened` / `ban.recovered` | worker ban detection | ban-episode writer, alerting, planner (reroute) |
| `session.expired` | 302/401 on poll | login-recovery durable job |

Implementation: Redis Streams (cheap, already have Redis) or a managed bus (SNS/SQS, GCP Pub/Sub, NATS) if you
want cross-region durability later. Start with Redis Streams.

---

## 8. Durable jobs (what stays on Trigger.dev — yes, keep it)

Trigger.dev is the *right* tool for discrete, idempotent, infrequent, must-not-lose actions. After this design
it does **only** these, and is no longer abused as a poller:

- **`reschedule` POST** — triggered by `reschedule.requested`. Idempotent (keyed by bot + target date), routed
  via **webshare** (POST works; no residential host needed — I4), enforces I5/I4 server-side, refreshes tokens
  first (session priming), emits `reschedule.succeeded/.failed`. This is the single most important durable
  action; it deserves a framework with retries and visibility.
- **`login` / `login-recovery`** — triggered by onboarding or `session.expired`. Routed via the **webshare
  pool, distributed across IPs** (I3) — the old residential-only + login-throttle constraint is lifted once
  stability is confirmed. No RPi.
- **`prefetch-cas`** — periodic CAS cache refresh.
- **`notify`** — email/WhatsApp/webhook fan-out.
- **`prune-telemetry`** — retention on the sink (if the sink needs it; ClickHouse TTL does this natively).

---

## 9. Data architecture — three stores, three jobs

The core fix to the cost problem: **stop mixing transactional state with a telemetry firehose.**

| Store | Holds | Why | Cost shape |
|-------|-------|-----|-----------|
| **Postgres (Neon)** | Product state: bots, agencies, sessions (durable copy), reschedules, excluded ranges, credential attempts. ~75 MB. | Transactional, relational, low write rate. With telemetry gone, Neon **scale-to-zero works again.** | ~$5/mo |
| **Redis** | Hot state: planner sorted-set, queue, per-worker session cache, token buckets, event streams. | Sub-ms, ephemeral-tolerant, the real-time spine. | small managed instance |
| **Telemetry sink** (ClickHouse / Tinybird / Parquet-on-S3) | `poll_logs` firehose, `date_sightings`, `ban_episodes`, `cas_prefetch_logs`. Append-only, columnar, TTL'd. | Built for high-cardinality append + minute-window analytics. 10–100× cheaper per row than OLTP, faster dashboards. | cheap / usage-based |

**Dashboard** reads product facts from Postgres and trend/uptime aggregates from the telemetry sink. Today's
heartbeat-bucketing (5-min uptime, 30-min trends) maps cleanly onto columnar rollups.

---

## 10. Failure modes & how the design handles them

| Failure | Today | Target design |
|---------|-------|---------------|
| Worker/host crash | chain dies, `ensure-chain` cron resurrects (Tuesday) | jobs stay in queue; another worker (or restarted one) reloads session from Redis and continues. No resurrection cron. |
| IP gets blocked | per-bot TCP backoff in DB, manual nudging | worker drains bucket, planner reroutes its bots to healthy IPs, `ban.opened` alerts. Isolated to one IP. |
| Account blocked | bot errors, backoff | `ban.opened` (account class) → pause that bot everywhere, independent of IP health. |
| Queue backlog (drop window) | N/A (chains just pile runs) | backpressure visible as queue depth; low-priority bots degrade cadence gracefully; add IPs to add throughput. |
| Reschedule lost/dup | inline fire-and-forget risk | durable idempotent job, exactly-once semantics by (bot,target-date) key. |
| Neon bill spike | this whole incident | telemetry is off Neon; product writes are tiny; Neon sleeps. |

---

## 11. Migration path — phases mapped to this target

Each phase is independently valuable and reversible. Stop at any point; everything still works.

- **Phase 0 — stop the bleeding (now):** commit write-skip + `prune-logs`; cap Neon max CU ~0.5; measure reads vs writes. → bill ~$20-22.
- **Phase 1 — telemetry off the OLTP path:** route the poll firehose to the sink (or at minimum async+batched off the hot path). → Neon back to scale-to-zero, ~$5. *Target component delivered: §9 telemetry sink.*
- **Track L — login off the RPi (parallel, low risk):** (L1) spot-check webshare login stability over several days (2-3×/day); (L2) once stable, switch `loginRouted`/onboarding to the **webshare pool, distributed across IPs**, run it in the cloud, and **delete the login-storm throttle**. *Delivers: I3 lifted, login no longer residential/RPi-bound.*
- **Track P — RESOLVED (egress = webshare, already in production).** No experiment needed: 28 bots already poll sustained via webshare at ~115K/day (I8). Retiring the RPi for polling is therefore a **compute migration, not an egress problem**. Remaining sub-task: decide the 6 `direct` bots (move to webshare, or keep cloud-direct at low rate). *Open at scale: webshare pool sizing + per-IP rate governance to keep soft_ban low at 300-1000 bots.*
- **Phase 2 — move compute off the RPi (split into two blue/green hops — see §14).** Today the RPi is the **sole compute host for 100% of the fleet** (all bots on `["dev"]`) — a single home-internet box = single point of failure.
  - **Phase 2a — RPi → Trigger.dev cloud (near-zero code):** flip bots `['dev']`→`['prod']` via `pollEnvironments`; the cloud cron picks them up, the RPi chain self-stops (`poll-visa.ts:165-169` guard). Removes the home-RPi SPOF fast, validates webshare-from-cloud. Still on chains. Reversible per bot by flipping back.
  - **Phase 2b — Trigger.dev chains → persistent cloud worker:** extract the poll core out of `poll-visa.ts`; stand up the worker (in-memory session + in-process scheduler, egress webshare); ownership via a new `runtime` lever; Trigger.dev demoted to durable jobs; delete orphan/self-cancel machinery. **RPi fully retired at end of 2a; chains deleted at end of 2b.** *Delivers: §6 worker (n=1, cloud), §4 planner (in-proc), §8 durable jobs.*
- **Phase 3 — externalize queue + IP pool (when 1 IP saturates, ~50+ active bots):** Redis + BullMQ queue with per-IP rate groups; N cloud workers (1≈1 egress IP); Redis-backed planner; event bus for side effects. *Delivers: §4 (central), §5, §6 (n>1), §7. Now horizontally scalable to 1000 bots by adding IPs+workers.*
- **Phase 4 — IP/proxy supply as a system (toward 1000):** proxy-pool sourcing, health-scoring, sticky regional pools, per-account governance. At this scale, **IP supply is the product-critical subsystem**, not an afterthought.

---

## 12. Tech choices (defaults + rationale + alternatives)

| Concern | Default | Why | Alternative |
|---------|---------|-----|-------------|
| Queue | **BullMQ on Redis** | Node-native, priority + delayed jobs + rate-limiter groups out of the box, you'll already run Redis | Trigger.dev queues (but you want OUT of per-run overhead); SQS (heavier) |
| Hot state / planner | **Redis** (sorted set + streams) | one dependency covers queue, cache, pub/sub | Postgres advisory + LISTEN/NOTIFY (cheaper infra, worse at this scale) |
| Telemetry sink | **Tinybird** (managed ClickHouse) or self-host ClickHouse | columnar, TTL, fast minute-window rollups, cheap per row | Parquet→S3+Athena (cheapest, slower queries); Postgres partitioned + aggressive TTL (interim) |
| Durable jobs | **Keep Trigger.dev** | genuinely good for reschedule/login/notify; retries + visibility | Temporal (overkill); BullMQ (you'd lose the nice durable-job DX) |
| Workers host | **Cheap always-on cloud containers/VMs**, egress via proxy pool (webshare for login + reschedule POST; Track-P pool for sustained polling) | **No RPi** — it was a single-IP bottleneck. Login via webshare validated (I3); reschedule POST via webshare (I4) | RPi (retired); datacenter-direct only viable at low per-IP rate (I8) |

---

## 13. Open decisions (need a call before Phase 3)

1. **Webshare pool sizing + rate governance at scale (replaces the old "find an egress" question).** Egress is
   already webshare in production (I8). The open question is purely scaling: how many webshare IPs and what
   per-IP rate keep soft_ban low at 300-1000 bots? Plus: move the 6 `direct` bots to webshare, or keep them
   cloud-direct at low rate for priority accounts?
2. **IP↔account affinity:** sticky (human-like, safer fingerprint) vs rotating (simpler ops). Recommend sticky
   regional pools.
3. **Telemetry sink choice:** managed (Tinybird, fastest path) vs self-host ClickHouse (cheaper at volume) vs
   S3+Parquet (cheapest, slowest queries).
4. **Login/reschedule egress confirmed = webshare** (login validated 8/8 2026-06-09; reschedule POST works on
   webshare). Open only: confirm login stability over several days before flipping `loginRouted`.
5. **Do you keep Trigger.dev or fold durable jobs into BullMQ too?** Recommend keep — different tool for a
   different job; don't rebuild durable-execution DX.
6. **Cloud worker host (gates Phase 2b):** Fly.io / Railway / Render / a small VPS — needs an always-on process
   (not a job runner), webshare egress, secrets, and a restart/deploy story. #1 practical blocker for 2b.
7. **One hop or two?** Two hops (2a then 2b) removes the home-RPi SPOF in days for near-zero code, at the cost
   of an extra migration. One hop (RPi→worker directly) is less total work but keeps the SPOF until the worker
   is built and trusted, and validates cloud egress + new execution model + new ownership all at once.
   Recommend **two hops** for a smooth, low-blast-radius transition.

---

## 14. Transition strategy — blue/green BY BOT (not classic blue/green)

**Why not classic blue/green:** each bot is a **stateful singleton** (its own session, appointment, reschedule
budget). You cannot run two pollers for the same bot and "flip traffic" — overlap means **double poll rate
(→ soft_ban) and a reschedule race that can violate the strictly-earlier rule and permanently lose a slot**
(I5). So the unit of cutover is the **bot**, not the deployment.

**THE migration invariant (non-negotiable):** *exactly one poller owns a bot at any instant.* Never use a dual
`pollEnvironments` (`['dev','prod']`) during migration; never let the worker and a chain own the same bot.

**The pattern: parallel runtimes + canary-by-bot + instant per-bot rollback.** Blue (old) and Green (new) both
run live, but the fleet is **partitioned** between them by the ownership field — each bot belongs to exactly
one side. Migrate in waves; rollback = move the bot back to Blue. Blue stays 100% operational as the fallback
until Green owns the whole fleet and has soaked. This gives blue/green *safety* with per-bot granularity, and
during migration **load is literally split across both runtimes** (the load-distribution you asked for).

**Ownership levers (already / nearly free):**
- **Hop 2a** (RPi→cloud): the existing `pollEnvironments`. `['dev']`=RPi owns, `['prod']`=cloud owns. The
  RPi chain self-stops for a flipped bot (`poll-visa.ts:165-169`). **Zero new code.**
- **Hop 2b** (chains→worker): a new lever — extend `pollEnvironments` with a `'worker'` value (or a `runtime`
  column). Worker polls only its owned bots; add a guard in `poll-visa.ts` so a chain run yields a worker-owned bot.

**Wave schedule (per hop):**
1. **1 pilot bot** (`cohort='pilot'`, free — never bot 6/7 or a paying-priority bot first) → soak 24–48h.
2. **3–5 bots** → soak 24h.
3. **25% → 50% → 100%**, soaking between waves.
4. Soak at 100%, then **decommission Blue** (turn off the RPi / delete the chains).

**Promote/rollback gates (compare Green vs the bot's own Blue baseline):** poll-success %, **soft_ban %**,
reschedule catches not missed, session stability (no re-login thrash). **Rollback trigger:** Green's soft_ban
materially worse, a missed/incorrect reschedule, or session thrash → flip the bot back, diagnose, retry.

**Cutover safety per bot:** flip ownership during a quiet window; the old side stops within ≤1 poll cycle (the
guard), the new side reads the existing `sessions` row (unique per bot) and continues; pre-emptive re-login
covers expiry. A single overlapping poll is harmless; sustained overlap is not — hence the single-value rule.

---

## Appendix — what dies in this design (complexity you stop maintaining)

- `activeRunId` / `activeCloudRunId` tracking, `cancelPreviousRun`, orphan detection, self-cancel guard.
- `ensure-chain` resurrection cron.
- The cron+chain hybrid and sub-minute self-trigger hack.
- Per-run re-reads of bot config / last-5 poll_logs for backoff (~800K queries/day).
- `poll_logs` as 99% of your transactional DB.
- **The RPi** as a special residential host, and the **login-storm throttle** (`MAX_CONCURRENT_LOGINS`,
  `withLoginThrottle`) that only existed because login was thought to be residential-only (I3, now lifted).

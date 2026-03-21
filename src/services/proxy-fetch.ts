import { Agent, ProxyAgent } from 'undici';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export type ProxyErrorSource = 'proxy_infra' | 'embassy_block' | 'proxy_quota';

export type TcpSubcategory =
  | 'socket_immediate_close'  // bytesRead=0 → cuenta baneada activamente
  | 'pool_exhausted'          // todas las IPs webshare fallaron
  | 'connection_reset'        // ECONNRESET / "other side closed"
  | 'connection_timeout'      // ETIMEDOUT
  | 'dns_fail'                // ENOTFOUND
  | 'proxy_tunnel_fail'       // HTTP Tunneling → infra webshare
  | 'connection_refused';     // ECONNREFUSED

export type BlockClassification =
  | 'transient'    // pocas IPs fallaron, no exhausted
  | 'ip_ban'       // pool exhausted, bytesRead > 0
  | 'account_ban'; // bytesRead === 0 (servidor rechaza activamente)

export function classifyProxyError(err: unknown, _latencyMs: number): ProxyErrorSource {
  const msg = err instanceof Error ? err.message : String(err);
  if (/HTTP Tunneling/i.test(msg)) {
    if (/402|Payment Required|bandwidthlimit/i.test(msg)) return 'proxy_quota';  // bandwidth exhausted
    return 'proxy_infra';  // CONNECT phase failed
  }
  if (/ECONNREFUSED/i.test(msg))   return 'proxy_infra';  // proxy port refused
  if (/402|Payment Required|bandwidthlimit/i.test(msg)) return 'proxy_quota';
  return 'embassy_block';  // fetch failed, ETIMEDOUT, ECONNRESET, etc. → embassy
}

export type ProxyProvider = 'direct' | 'brightdata' | 'firecrawl' | 'webshare';

// Singleton agents — reuse TCP+TLS connections across requests.
// Creating a new connection per request costs ~200ms (TLS handshake).
// With shared agents, subsequent requests reuse warm connections.
let sharedProxyAgent: ProxyAgent | null = null;
let sharedDirectAgent: Agent | null = null;

// ── Dynamic Webshare proxy list ──────────────────────────────────────────────
// Cached to a temp file so the cache survives process forks (Trigger.dev dev
// mode runs each task in a child process, so in-memory state is reset per run).
// File TTL: 12h. Falls back to stale cache on API errors.
let dynamicWebshareUrls: string[] | null = null;
let dynamicWebshareLoadedAt = 0;
const WEBSHARE_CACHE_TTL_MS = 12 * 60 * 60_000; // 12h — IPs rarely change
const WEBSHARE_CACHE_FILE = join(tmpdir(), 'webshare-proxy-cache.json');
const PROXY_POOL_STATE_FILE = join(tmpdir(), '.proxy-pool-state.json');

async function loadWebshareProxiesFromApi(): Promise<string[]> {
  const apiKey = process.env.WEBSHARE_API_KEY;
  if (!apiKey) throw new Error('WEBSHARE_API_KEY not configured');
  const resp = await fetch('https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100', {
    headers: { Authorization: `Token ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`Webshare API HTTP ${resp.status}`);
  const json = await resp.json() as { results: { proxy_address: string; port: number; username: string; password: string; valid: boolean }[] };
  const valid = json.results.filter((p) => p.valid);
  return valid.map((p) => `http://${p.username}:${p.password}@${p.proxy_address}:${p.port}`);
}

/** Load cached IPs from the temp file. Returns null if missing or stale. */
function readWebshareFileCache(): { urls: string[]; loadedAt: number } | null {
  try {
    const raw = readFileSync(WEBSHARE_CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as { urls: string[]; loadedAt: number };
    if (!Array.isArray(parsed.urls) || typeof parsed.loadedAt !== 'number') return null;
    return parsed;
  } catch {
    return null; // File missing or corrupt
  }
}

/** Persist current cache to the temp file. */
function writeWebshareFileCache(urls: string[], loadedAt: number): void {
  try {
    mkdirSync(tmpdir(), { recursive: true });
    writeFileSync(WEBSHARE_CACHE_FILE, JSON.stringify({ urls, loadedAt }), 'utf-8');
  } catch {
    // Non-fatal — next run will re-fetch
  }
}

/** Returns the effective webshare URL list.
 *  Cached to a file (survives process forks) with a 12h TTL.
 *  On API error: uses stale cache (fail-open). */
export async function getEffectiveWebshareUrls(): Promise<string[]> {
  // Warm in-memory cache from file on fresh process start
  if (!dynamicWebshareUrls) {
    const cached = readWebshareFileCache();
    if (cached) {
      dynamicWebshareUrls = cached.urls;
      dynamicWebshareLoadedAt = cached.loadedAt;
    }
  }

  const isStale = Date.now() - dynamicWebshareLoadedAt > WEBSHARE_CACHE_TTL_MS;
  if (!dynamicWebshareUrls || isStale) {
    try {
      const urls = await loadWebshareProxiesFromApi();
      dynamicWebshareUrls = urls;
      dynamicWebshareLoadedAt = Date.now();
      writeWebshareFileCache(urls, dynamicWebshareLoadedAt);
      console.info(`[proxy-fetch] Loaded ${urls.length} valid webshare IPs from API`);
      await warmupProbeAllIps(urls);
    } catch (err) {
      if (dynamicWebshareUrls) {
        // API error but cache is warm — keep using it
        console.warn('[proxy-fetch] Webshare API error, using cached IPs:', err instanceof Error ? err.message : String(err));
      } else {
        throw err; // No cache at all → propagate
      }
    }
  }
  return dynamicWebshareUrls ?? [];
}

/** Marks the webshare IP cache as stale so it refreshes on the next request.
 *  Call when all IPs are circuit-broken or after a severe failure. */
export function invalidateWebshareCache(): void {
  dynamicWebshareLoadedAt = 0;
  try { writeWebshareFileCache(dynamicWebshareUrls ?? [], 0); } catch { /* non-fatal */ }
}

async function warmupProbeAllIps(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const PROBE_URL = 'https://www.google.com/';  // neutral target — tests tunnel, not embassy
  const t0wall = Date.now();
  const probes = urls.map(async (proxyUrl) => {
    const ip = (() => { try { return new URL(proxyUrl).hostname; } catch { return proxyUrl; } })();
    const t0 = Date.now();
    try {
      const agent = new ProxyAgent({ uri: proxyUrl, connectTimeout: 5_000, headersTimeout: 5_000 });
      await fetch(PROBE_URL, { signal: AbortSignal.timeout(5_000), dispatcher: agent } as RequestInit);
      proxyPool.recordOutcome(ip, true, Date.now() - t0);
      return { ip, ok: true };
    } catch (err) {
      const latencyMs = Date.now() - t0;
      // Warmup probes a neutral target (google.com) — any failure here is proxy
      // infrastructure, never embassy block (google.com doesn't ban these IPs).
      proxyPool.recordOutcome(ip, false, latencyMs, 'proxy_infra');
      return { ip, ok: false, source: 'proxy_infra' as ProxyErrorSource };
    }
  });
  const results = (await Promise.allSettled(probes))
    .map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean) as { ip: string; ok: boolean; source?: ProxyErrorSource }[];
  const healthy = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  console.info(`[proxy-pool] Warmup: ${healthy}/${urls.length} healthy in ${Date.now() - t0wall}ms`, failed.map(r => `${r.ip}:${r.source}`));
  proxyPool.persistState();
}

export interface ProxyFetchMeta {
  proxyAttemptIp: string | null;
  fallbackReason: string | null;
  websharePoolSize: number;
  errorSource: ProxyErrorSource | null;
  tcpSubcategory: TcpSubcategory | null;
  poolExhausted: boolean;
  socketBytesRead: number | null;
}

export function extractBytesRead(err: unknown): number | null {
  const cause = (err as any)?.cause;
  const bytes = cause?.socket?.bytesRead;
  return typeof bytes === 'number' ? bytes : null;
}

export function classifyTcpSubcategory(err: unknown, poolExhausted: boolean): TcpSubcategory {
  const msg = err instanceof Error ? err.message : String(err);
  if (extractBytesRead(err) === 0) return 'socket_immediate_close';
  if (poolExhausted) return 'pool_exhausted';
  if (/ENOTFOUND/i.test(msg)) return 'dns_fail';
  if (/ETIMEDOUT/i.test(msg)) return 'connection_timeout';
  if (/ECONNREFUSED/i.test(msg)) return 'connection_refused';
  if (/HTTP Tunneling/i.test(msg)) return 'proxy_tunnel_fail';
  return 'connection_reset'; // ECONNRESET, "other side closed", fetch failed
}

export function deriveBlockClassification(meta: Pick<ProxyFetchMeta, 'socketBytesRead' | 'poolExhausted'>): BlockClassification {
  if (meta.socketBytesRead === 0) return 'account_ban';
  if (meta.poolExhausted) return 'ip_ban';
  return 'transient';
}

// ── Proxy Pool Manager ───────────────────────────────────────────────────────
// 3-state circuit breaker (closed/half_open/open) + EWMA health scoring
// + weighted random selection. Standard pattern used by Linkerd/Envoy.

const EWMA_ALPHA = 0.2;
const RECENCY_SPREAD_MS = 30_000;  // IP recovers full weight after 30s (> poll interval)
const OPEN_ON_CONSECUTIVE_FAILS = 5;  // raised from 3 — more tolerant to noise
const CLOSE_ON_CONSECUTIVE_SUCCESSES = 3;
const OPEN_ON_EWMA_ERROR_RATE = 0.50;  // raised from 0.40
const DEGRADE_WARN_EWMA = 0.15;
// Aligned with poll-visa.ts tcp_blocked backoff (30→45→60min).
// At 5min the IP was going to half_open before the bot even retried (30min wait),
// making the state machine misleading. Start at 30min = first real retry window.
const HALF_OPEN_INITIAL_COOLDOWN_MS = 30 * 60_000;
const HALF_OPEN_MAX_COOLDOWN_MS = 60 * 60_000;  // max 60min (matches poll-visa cap)
const PROXY_INFRA_COOLDOWN_MS = 5 * 60_000;     // proxy tunnel down: recover in 5min
const EMBASSY_BAN_MS = 30 * 60_000;             // embassy ban: 30min cooldown
const EMBASSY_BAN_CONSECUTIVE_FAILS = 3;        // consecutive embassy_block before banning
const HALF_OPEN_PROBE_WEIGHT = 0.40;
const MAX_POOL_EVENTS = 100;
const WEBSHARE_MAX_RETRIES = 3;  // additional IPs to try before giving up (throws on exhaustion)

interface IpHealth {
  state: 'closed' | 'half_open' | 'open';
  ewmaErrorRate: number;
  ewmaLatencyMs: number;
  consecutiveFails: number;
  consecutiveSuccesses: number;
  stateChangedAt: number;
  cooldownMs: number;
  totalRequests: number;
  totalErrors: number;
  lastSelectedAt?: number;  // persisted — timestamp of last selection for recency penalty
  // Embassy ban: tracked independently of proxy circuit breaker
  embassyBannedUntil?: number | null;
  consecutiveEmbassyFails?: number;
}

interface PoolEvent {
  ts: number;
  ip: string;
  event: 'opened' | 'half_opened' | 'closed' | 'degraded' | 'recovered';
  reason: string;
  ewmaErrorRate: number;
  ewmaLatencyMs: number;
}

class ProxyPoolManager {
  private health = new Map<string, IpHealth>();
  private events: PoolEvent[] = [];

  constructor() { this.loadPoolState(); }

  private loadPoolState(): void {
    try {
      const parsed = JSON.parse(readFileSync(PROXY_POOL_STATE_FILE, 'utf-8')) as Record<string, IpHealth & Record<string, unknown>>;
      let loaded = 0;
      for (const [ip, entry] of Object.entries(parsed)) {
        if (!entry?.state) continue;
        const ageMs = Date.now() - (entry.stateChangedAt as number ?? 0);
        if (entry.state === 'open' && ageMs > (entry.cooldownMs as number ?? 0) * 2) continue;
        if (entry.state === 'closed' && ageMs > 4 * 60 * 60_000) continue;
        // half_open always valid
        this.health.set(ip, { ...entry, totalRequests: 0, totalErrors: 0 } as IpHealth);
        loaded++;
      }
      if (loaded > 0) console.info(`[proxy-pool] Loaded state: ${loaded} IPs from file`);
    } catch { /* file missing or corrupt — start fresh */ }
  }

  private savePoolState(): void {
    try {
      const out: Record<string, object> = {};
      for (const [ip, h] of this.health) {
        out[ip] = {
          state: h.state, ewmaErrorRate: h.ewmaErrorRate, ewmaLatencyMs: h.ewmaLatencyMs,
          cooldownMs: h.cooldownMs, stateChangedAt: h.stateChangedAt,
          consecutiveFails: h.consecutiveFails, consecutiveSuccesses: h.consecutiveSuccesses,
          lastSelectedAt: h.lastSelectedAt,
          embassyBannedUntil: h.embassyBannedUntil ?? null,
          consecutiveEmbassyFails: h.consecutiveEmbassyFails ?? 0,
        };
      }
      writeFileSync(PROXY_POOL_STATE_FILE, JSON.stringify(out));
    } catch { /* non-fatal */ }
  }

  public persistState(): void { this.savePoolState(); }

  private getOrInit(ip: string): IpHealth {
    let h = this.health.get(ip);
    if (!h) {
      h = {
        state: 'closed',
        ewmaErrorRate: 0,
        ewmaLatencyMs: 800,
        consecutiveFails: 0,
        consecutiveSuccesses: 0,
        stateChangedAt: Date.now(),
        cooldownMs: HALF_OPEN_INITIAL_COOLDOWN_MS,
        totalRequests: 0,
        totalErrors: 0,
      };
      this.health.set(ip, h);
    }
    return h;
  }

  private transition(ip: string, h: IpHealth, to: IpHealth['state'], reason: string): void {
    const prevState = h.state;
    h.state = to;
    h.stateChangedAt = Date.now();

    let eventType: PoolEvent['event'];
    if (to === 'open') {
      eventType = 'opened';
    } else if (to === 'half_open') {
      eventType = 'half_opened';
    } else {
      // closed — was it a recovery from half_open?
      eventType = prevState === 'half_open' ? 'recovered' : 'closed';
    }

    this.pushEvent({ ip, event: eventType, reason, ewmaErrorRate: h.ewmaErrorRate, ewmaLatencyMs: h.ewmaLatencyMs });
    this.savePoolState();
  }

  private pushEvent(ev: Omit<PoolEvent, 'ts'>): void {
    this.events.push({ ts: Date.now(), ...ev });
    if (this.events.length > MAX_POOL_EVENTS) this.events.shift();
  }

  recordOutcome(ip: string, success: boolean, latencyMs: number, source: ProxyErrorSource = 'embassy_block'): void {
    const h = this.getOrInit(ip);
    h.totalRequests++;
    if (!success) h.totalErrors++;

    // Update EWMA
    const prevEwmaError = h.ewmaErrorRate;
    h.ewmaErrorRate = EWMA_ALPHA * (success ? 0 : 1) + (1 - EWMA_ALPHA) * h.ewmaErrorRate;
    if (success && latencyMs > 0) {
      h.ewmaLatencyMs = EWMA_ALPHA * latencyMs + (1 - EWMA_ALPHA) * h.ewmaLatencyMs;
    }

    if (success) {
      const hadFailState = h.consecutiveFails > 0 || (h.consecutiveEmbassyFails ?? 0) > 0;
      h.consecutiveFails = 0;
      h.consecutiveSuccesses++;
      h.consecutiveEmbassyFails = 0;  // reset embassy fail counter on success
      h.embassyBannedUntil = null;    // clear ban on success — IP is working again
      if (hadFailState) this.savePoolState();  // persist reset so sibling processes see it
    } else {
      h.consecutiveSuccesses = 0;
      h.consecutiveFails++;
    }

    // Proxy infra / quota: open circuit breaker immediately with short cooldown
    if (!success && (source === 'proxy_infra' || source === 'proxy_quota')) {
      if (source === 'proxy_quota') {
        console.warn(`[proxy-pool] [QUOTA_EXHAUSTED] ${ip} returned 402 Payment Required — invalidating webshare cache`);
        invalidateWebshareCache();
      }
      if (h.state === 'closed') {
        h.cooldownMs = PROXY_INFRA_COOLDOWN_MS;
        this.transition(ip, h, 'open', `${source}: immediate open`);
        return;
      }
      if (h.state === 'half_open') {
        h.cooldownMs = Math.min(h.cooldownMs * 2, HALF_OPEN_MAX_COOLDOWN_MS);
        this.transition(ip, h, 'open', `${source}: immediate re-open`);
        return;
      }
    }

    // Embassy block: accumulate failures and set ban when threshold exceeded.
    // Only set ban once — don't refresh while active. This ensures the 30min window
    // always expires even if polls keep failing (prevents perpetual renewal).
    if (!success && source === 'embassy_block') {
      h.consecutiveEmbassyFails = (h.consecutiveEmbassyFails ?? 0) + 1;
      const banAlreadyActive = h.embassyBannedUntil && Date.now() < h.embassyBannedUntil;
      if (h.consecutiveEmbassyFails >= EMBASSY_BAN_CONSECUTIVE_FAILS && !banAlreadyActive) {
        h.embassyBannedUntil = Date.now() + EMBASSY_BAN_MS;
        this.pushEvent({
          ip, event: 'degraded',
          reason: `embassy ban: ${h.consecutiveEmbassyFails} consecutive embassy_block`,
          ewmaErrorRate: h.ewmaErrorRate, ewmaLatencyMs: h.ewmaLatencyMs,
        });
        this.savePoolState();
      }
    }

    // Check for half_open → closed (after cooldown, test probes)
    if (h.state === 'open') {
      const elapsed = Date.now() - h.stateChangedAt;
      if (elapsed >= h.cooldownMs) {
        this.transition(ip, h, 'half_open', `cooldown ${Math.round(h.cooldownMs / 60_000)}min elapsed`);
        h.consecutiveFails = 0;
        h.consecutiveSuccesses = 0;
      }
    }

    if (h.state === 'half_open') {
      if (success && h.consecutiveSuccesses >= CLOSE_ON_CONSECUTIVE_SUCCESSES) {
        h.cooldownMs = HALF_OPEN_INITIAL_COOLDOWN_MS; // reset cooldown on clean recovery
        this.transition(ip, h, 'closed', `${CLOSE_ON_CONSECUTIVE_SUCCESSES} consecutive successful probes`);
      } else if (!success && h.consecutiveFails >= 2) {
        h.cooldownMs = Math.min(h.cooldownMs * 2, HALF_OPEN_MAX_COOLDOWN_MS);
        this.transition(ip, h, 'open', `probe failed (${h.consecutiveFails} consecutive), cooldown → ${Math.round(h.cooldownMs / 60_000)}min`);
      }
    } else if (h.state === 'closed') {
      // Check open conditions
      const shouldOpen =
        h.consecutiveFails >= OPEN_ON_CONSECUTIVE_FAILS ||
        (h.totalRequests >= 10 && h.ewmaErrorRate > OPEN_ON_EWMA_ERROR_RATE);

      if (shouldOpen) {
        const reason = h.consecutiveFails >= OPEN_ON_CONSECUTIVE_FAILS
          ? `${OPEN_ON_CONSECUTIVE_FAILS} consecutive TCP failures`
          : `ewmaError ${Math.round(h.ewmaErrorRate * 100)}% > ${Math.round(OPEN_ON_EWMA_ERROR_RATE * 100)}%`;
        this.transition(ip, h, 'open', reason);
      } else if (
        h.totalRequests >= 10 &&
        h.ewmaErrorRate > DEGRADE_WARN_EWMA &&
        prevEwmaError <= DEGRADE_WARN_EWMA
      ) {
        // Degraded warning (stays closed)
        this.pushEvent({ ip, event: 'degraded', reason: `ewmaError ${Math.round(h.ewmaErrorRate * 100)}% (threshold: ${Math.round(DEGRADE_WARN_EWMA * 100)}%)`, ewmaErrorRate: h.ewmaErrorRate, ewmaLatencyMs: h.ewmaLatencyMs });
      }
    }
  }

  /** Re-reads lastSelectedAt timestamps from the state file before each selection.
   *  Does not touch health/EWMA — only updates recency timestamps.
   *  Reduces the race window between concurrent child processes (Trigger.dev dev mode). */
  private syncRecencyFromFile(): void {
    try {
      const raw = readFileSync(PROXY_POOL_STATE_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, { lastSelectedAt?: number }>;
      for (const [ip, entry] of Object.entries(parsed)) {
        const h = this.health.get(ip);
        if (h && entry.lastSelectedAt && entry.lastSelectedAt > (h.lastSelectedAt ?? 0)) {
          h.lastSelectedAt = entry.lastSelectedAt;
        }
      }
    } catch { /* non-fatal */ }
  }

  selectUrl(urls: string[]): { url: string; ip: string } {
    this.syncRecencyFromFile();  // reduce race window between concurrent processes
    if (urls.length === 0) return { url: 'direct', ip: 'direct' };
    // Initialize all known IPs
    const parsed = urls.map((url) => {
      if (url === 'direct') return { url, ip: 'direct' };
      try { return { url, ip: new URL(url).hostname }; } catch { return { url, ip: url }; }
    });

    for (const { ip } of parsed) {
      if (ip !== 'direct') this.getOrInit(ip);
    }

    // Promote open IPs whose cooldown has elapsed to half_open (passive recovery).
    // Without this, open IPs are never selected in normal mode and never recover.
    for (const { ip } of parsed) {
      if (ip === 'direct') continue;
      const h = this.health.get(ip);
      if (h?.state === 'open' && Date.now() - h.stateChangedAt >= h.cooldownMs) {
        this.transition(ip, h, 'half_open', `cooldown ${Math.round(h.cooldownMs / 60_000)}min elapsed (passive)`);
        h.consecutiveFails = 0;
        h.consecutiveSuccesses = 0;
      }
    }

    // Candidates: closed IPs + one half_open (probe); exclude embassy-banned IPs
    const isEmbassyBanned = (ip: string) => {
      const h = this.health.get(ip);
      return h?.embassyBannedUntil && Date.now() < h.embassyBannedUntil;
    };

    const closed = parsed.filter(({ ip }) => {
      if (ip === 'direct') return true;
      return this.getOrInit(ip).state === 'closed' && !isEmbassyBanned(ip);
    });
    const halfOpen = parsed.filter(({ ip }) => {
      if (ip === 'direct') return false;
      return this.getOrInit(ip).state === 'half_open' && !isEmbassyBanned(ip);
    });

    // Emergency mode: all open → use all
    // All half_open (no closed) → use half_open as candidates directly
    const candidates =
      closed.length === 0 && halfOpen.length === 0 ? parsed   // all open → emergency
      : closed.length > 0 ? closed                            // normal: prefer closed
      : halfOpen;                                             // all half_open → probe all

    // Build weighted list
    type Candidate = { url: string; ip: string; weight: number };
    const weighted: Candidate[] = [];

    for (const { url, ip } of candidates) {
      const h = ip === 'direct' ? null : this.health.get(ip);
      const errRate = h ? h.ewmaErrorRate : 0;
      const lat = h ? h.ewmaLatencyMs : 800;
      const baseWeight = (1 - errRate) * Math.min(1, 1500 / Math.max(lat, 1));
      const msSinceLastUse = h?.lastSelectedAt ? (Date.now() - h.lastSelectedAt) : Infinity;
      const recencyFactor = Math.min(1, msSinceLastUse / RECENCY_SPREAD_MS);
      const w = baseWeight * (0.1 + 0.9 * recencyFactor);
      weighted.push({ url, ip, weight: Math.max(w, 0.01) });
    }

    // Add one half_open probe candidate at fixed weight (only when there are also closed IPs)
    if (halfOpen.length > 0 && closed.length > 0) {
      const probe = halfOpen[Math.floor(Math.random() * halfOpen.length)]!;
      weighted.push({ ...probe, weight: HALF_OPEN_PROBE_WEIGHT });
    }

    // Weighted random pick
    const total = weighted.reduce((s, c) => s + c.weight, 0);
    let r = Math.random() * total;
    let picked: { url: string; ip: string } | null = null;
    for (const c of weighted) {
      r -= c.weight;
      if (r <= 0) { picked = c; break; }
    }
    if (!picked) picked = weighted[weighted.length - 1] ?? { url: 'direct', ip: 'direct' };
    // Mark last-selected time for recency penalty and persist so sibling processes see it.
    // Without the persist, each new child process (Trigger.dev dev mode) starts fresh
    // and all concurrent bot runs pick the same IP, defeating rotation.
    if (picked.ip !== 'direct') {
      const h = this.health.get(picked.ip);
      if (h) {
        h.lastSelectedAt = Date.now();
        this.savePoolState();
      }
    }
    return { url: picked.url, ip: picked.ip };
  }

  getState(): { ips: Record<string, IpHealth & { recoversInMs: number | null }>; events: PoolEvent[] } {
    const ips: Record<string, IpHealth & { recoversInMs: number | null }> = {};
    for (const [ip, h] of this.health) {
      const recoversInMs = h.state === 'open'
        ? Math.max(0, h.stateChangedAt + h.cooldownMs - Date.now())
        : null;
      ips[ip] = { ...h, recoversInMs };
    }
    return { ips, events: [...this.events].reverse() };
  }
}

export const proxyPool = new ProxyPoolManager();
export function getPoolState() { return proxyPool.getState(); }

/** Backward-compat wrapper: records a TCP failure with 0 latency */
export function recordWebshareIpFailure(ip: string): void {
  proxyPool.recordOutcome(ip, false, 0, 'embassy_block');
}

/** Backward-compat wrapper: returns a legacy-style summary of breaker state */
export function getIpBreakerState(): Record<string, { failures: number; state: string }> {
  const { ips } = proxyPool.getState();
  const out: Record<string, { failures: number; state: string }> = {};
  for (const [ip, h] of Object.entries(ips)) {
    out[ip] = { failures: h.totalErrors, state: h.state };
  }
  return out;
}

function getDirectAgent(): Agent {
  if (!sharedDirectAgent) {
    sharedDirectAgent = new Agent({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connections: 10,
      connectTimeout: 10_000,
      headersTimeout: 12_000,
    });
  }
  return sharedDirectAgent;
}

function getBrightDataAgent(): ProxyAgent {
  const proxyUrl = process.env.BRIGHT_DATA_PROXY_URL;
  if (!proxyUrl) throw new Error('BRIGHT_DATA_PROXY_URL not configured');

  if (!sharedProxyAgent) {
    sharedProxyAgent = new ProxyAgent({
      uri: proxyUrl,
      requestTls: { rejectUnauthorized: false },
    });
  }
  return sharedProxyAgent;
}

// Per-bot Webshare agents: cache ProxyAgent instances by URL to reuse TCP connections.
const perBotAgentCache = new Map<string, ProxyAgent>();

function getNextWebshareAgentFromUrls(urls: string[]): { agent: ProxyAgent | Agent; ip: string } {
  const { url, ip } = proxyPool.selectUrl(urls);
  if (url === 'direct') {
    return { agent: getDirectAgent(), ip: 'direct' };
  }
  let agent = perBotAgentCache.get(url);
  if (!agent) {
    agent = new ProxyAgent({ uri: url, connectTimeout: 10_000, headersTimeout: 12_000 });
    perBotAgentCache.set(url, agent);
  }
  return { agent, ip };
}

export async function proxyFetch(
  url: string,
  options: RequestInit,
  provider: ProxyProvider = 'direct',
  proxyUrls?: string[] | null,
): Promise<{ response: Response; meta: ProxyFetchMeta }> {
  const meta: ProxyFetchMeta = { proxyAttemptIp: null, fallbackReason: null, websharePoolSize: 0, errorSource: null, tcpSubcategory: null, poolExhausted: false, socketBytesRead: null };

  switch (provider) {
    case 'direct': {
      try {
        return {
          response: await fetch(url, {
            ...options,
            // @ts-expect-error undici dispatcher works with global fetch
            dispatcher: getDirectAgent(),
          }),
          meta,
        };
      } catch (err) {
        // Populate meta for direct provider TCP errors so captureConnInfo has data
        const msg = err instanceof Error ? err.message : String(err);
        const isTcp = /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|EPIPE|other side closed/i.test(msg);
        if (isTcp) {
          meta.socketBytesRead = extractBytesRead(err);
          meta.errorSource = classifyProxyError(err, 0);
          meta.tcpSubcategory = classifyTcpSubcategory(err, false);
          (err as Error & { proxyMeta?: ProxyFetchMeta }).proxyMeta = { ...meta };
        }
        throw err;
      }
    }
    case 'brightdata':
      return { response: await fetchViaBrightData(url, options), meta };
    case 'webshare': {
      // Resolve URL list: per-bot override → Webshare API (valid IPs only)
      const effectiveUrls = proxyUrls && proxyUrls.length > 0
        ? proxyUrls
        : await getEffectiveWebshareUrls();
      meta.websharePoolSize = effectiveUrls.length;
      if (effectiveUrls.length === 0) {
        console.warn('[proxy-fetch] No webshare URLs available, falling back to direct');
        meta.fallbackReason = 'NO_URLS';
        return {
          // @ts-expect-error undici dispatcher
          response: await fetch(url, { ...options, dispatcher: getDirectAgent() }),
          meta,
        };
      }

      const { agent, ip: selectedIp } = getNextWebshareAgentFromUrls(effectiveUrls);

      const TCP_RE = /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|other side closed|HTTP Tunneling/i;
      const CODE_RE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|other side closed/i;

      // Initial attempt + up to WEBSHARE_MAX_RETRIES additional IPs before throwing
      let attemptIp = selectedIp;
      let attemptAgent = agent;
      for (let attempt = 0; attempt <= WEBSHARE_MAX_RETRIES; attempt++) {
        meta.proxyAttemptIp = attemptIp;  // track last-attempted IP per iteration
        const t0 = Date.now();
        try {
          const response = await fetch(url, {
            ...options,
            // @ts-expect-error undici dispatcher works with global fetch
            dispatcher: attemptAgent,
          });
          if (attemptIp && attemptIp !== 'direct') {
            proxyPool.recordOutcome(attemptIp, true, Date.now() - t0);
          }
          return { response, meta };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!TCP_RE.test(msg)) throw err;  // Non-TCP → re-throw

          const latencyMs = Date.now() - t0;
          const errorSource = classifyProxyError(err, latencyMs);

          if (attemptIp && attemptIp !== 'direct') {
            proxyPool.recordOutcome(attemptIp, false, latencyMs, errorSource);
          }

          const sourceTag = `[${errorSource}]`;

          if (attempt < WEBSHARE_MAX_RETRIES) {
            // Rotate to next IP (circuit breaker already penalized the failed one)
            console.warn(`[proxy-fetch] ${sourceTag} ${attemptIp} failed (${latencyMs}ms), rotating`);
            ({ agent: attemptAgent, ip: attemptIp } = getNextWebshareAgentFromUrls(effectiveUrls));
            continue;
          }

          // All webshare IPs exhausted → throw (no direct fallback)
          // Mark cache stale so next request re-fetches fresh IP list.
          if (!proxyUrls?.length) invalidateWebshareCache();
          meta.fallbackReason = (msg.match(CODE_RE)?.[0] ?? 'TCP_FAIL').toUpperCase();
          meta.errorSource = errorSource;
          meta.poolExhausted = true;
          meta.socketBytesRead = extractBytesRead(err);
          meta.tcpSubcategory = classifyTcpSubcategory(err, true);
          console.warn(`[proxy-fetch] ${sourceTag} All webshare IPs exhausted after ${WEBSHARE_MAX_RETRIES + 1} attempts, throwing`);
          (err as Error & { proxyMeta?: ProxyFetchMeta }).proxyMeta = { ...meta };
          throw err;
        }
      }
      throw new Error('unreachable');
    }
    case 'firecrawl':
      return { response: await fetchViaFirecrawl(url, options), meta };
  }
}

async function fetchViaBrightData(
  url: string,
  options: RequestInit,
): Promise<Response> {
  const agent = getBrightDataAgent();
  return fetch(url, {
    ...options,
    // @ts-expect-error undici dispatcher works with global fetch
    dispatcher: agent,
  });
}

async function fetchViaFirecrawl(
  url: string,
  options: RequestInit,
): Promise<Response> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY not configured');

  // Pass original request headers to Firecrawl so it forwards them
  const headers = options.headers instanceof Headers
    ? Object.fromEntries(options.headers.entries())
    : (options.headers as Record<string, string>) ?? {};

  const resp = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ['rawHtml'],
      headers,
      waitFor: 0,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Firecrawl API error ${resp.status}: ${text}`);
  }

  const json = (await resp.json()) as { success: boolean; data?: { rawHtml?: string } };
  if (!json.success || !json.data?.rawHtml) {
    throw new Error('Firecrawl returned no rawHtml');
  }

  // Wrap the raw content in a synthetic Response so callers can use it normally
  return new Response(json.data.rawHtml, {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}

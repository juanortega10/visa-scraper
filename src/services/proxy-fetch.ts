import { Agent, ProxyAgent } from 'undici';

export type ProxyProvider = 'direct' | 'brightdata' | 'firecrawl' | 'webshare';

// Singleton agents — reuse TCP+TLS connections across requests.
// Creating a new connection per request costs ~200ms (TLS handshake).
// With shared agents, subsequent requests reuse warm connections.
let sharedProxyAgent: ProxyAgent | null = null;
let sharedDirectAgent: Agent | null = null;
let lastProxyIp: string | null = null;

// ── Dynamic Webshare proxy list ──────────────────────────────────────────────
// Loaded once per process via WEBSHARE_API_KEY → GET /api/v2/proxy/list/
// Filters valid:true IPs only. Webshare verifies each IP periodically.
let dynamicWebshareUrls: string[] | null = null;
let dynamicWebshareLoaded = false;

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

/** Returns the effective webshare URL list, loaded once per process from the Webshare API. */
export async function getEffectiveWebshareUrls(): Promise<string[]> {
  if (!dynamicWebshareLoaded) {
    dynamicWebshareLoaded = true;
    const urls = await loadWebshareProxiesFromApi();
    dynamicWebshareUrls = urls;
    const ips = urls.map((u) => { try { return new URL(u).hostname; } catch { return u; } });
    console.info(`[proxy-fetch] Loaded ${urls.length} valid webshare IPs from API: ${ips.join(', ')}`);
  }
  return dynamicWebshareUrls ?? [];
}

// ── Fallback metadata (module-level, like lastProxyIp) ──────────────────────
// Populated on every proxyFetch call. Call getProxyFetchMeta() right after.
let lastProxyAttemptIp: string | null = null;  // IP tried before any fallback
let lastFallbackHappened = false;
let lastFallbackReason: string | null = null;
let lastWebsharePoolSize = 0;

export function getProxyFetchMeta() {
  return {
    proxyAttemptIp: lastProxyAttemptIp,
    fallbackHappened: lastFallbackHappened,
    fallbackReason: lastFallbackReason,
    websharePoolSize: lastWebsharePoolSize,
  };
}

// ── Proxy Pool Manager ───────────────────────────────────────────────────────
// 3-state circuit breaker (closed/half_open/open) + EWMA health scoring
// + weighted random selection. Standard pattern used by Linkerd/Envoy.

const EWMA_ALPHA = 0.2;
const OPEN_ON_CONSECUTIVE_FAILS = 3;
const CLOSE_ON_CONSECUTIVE_SUCCESSES = 3;
const OPEN_ON_EWMA_ERROR_RATE = 0.40;
const DEGRADE_WARN_EWMA = 0.15;
// Aligned with poll-visa.ts tcp_blocked backoff (30→45→60min).
// At 5min the IP was going to half_open before the bot even retried (30min wait),
// making the state machine misleading. Start at 30min = first real retry window.
const HALF_OPEN_INITIAL_COOLDOWN_MS = 30 * 60_000;
const HALF_OPEN_MAX_COOLDOWN_MS = 60 * 60_000;  // max 60min (matches poll-visa cap)
const HALF_OPEN_PROBE_WEIGHT = 0.15;
const MAX_POOL_EVENTS = 100;

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
  }

  private pushEvent(ev: Omit<PoolEvent, 'ts'>): void {
    this.events.push({ ts: Date.now(), ...ev });
    if (this.events.length > MAX_POOL_EVENTS) this.events.shift();
  }

  recordOutcome(ip: string, success: boolean, latencyMs: number): void {
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
      h.consecutiveFails = 0;
      h.consecutiveSuccesses++;
    } else {
      h.consecutiveSuccesses = 0;
      h.consecutiveFails++;
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

  selectUrl(urls: string[]): { url: string; ip: string } {
    // Initialize all known IPs
    const parsed = urls.map((url) => {
      if (url === 'direct') return { url, ip: 'direct' };
      try { return { url, ip: new URL(url).hostname }; } catch { return { url, ip: url }; }
    });

    for (const { ip } of parsed) {
      if (ip !== 'direct') this.getOrInit(ip);
    }

    // Candidates: closed IPs + one half_open (probe)
    const closed = parsed.filter(({ ip }) => {
      if (ip === 'direct') return true;
      return this.getOrInit(ip).state === 'closed';
    });
    const halfOpen = parsed.filter(({ ip }) => {
      if (ip === 'direct') return false;
      return this.getOrInit(ip).state === 'half_open';
    });

    // Emergency mode: all open → use all
    const candidates = closed.length === 0 && halfOpen.length === 0 ? parsed : closed;

    // Build weighted list
    type Candidate = { url: string; ip: string; weight: number };
    const weighted: Candidate[] = [];

    for (const { url, ip } of candidates) {
      const h = ip === 'direct' ? null : this.health.get(ip);
      const errRate = h ? h.ewmaErrorRate : 0;
      const lat = h ? h.ewmaLatencyMs : 800;
      const w = (1 - errRate) * Math.min(1, 1500 / Math.max(lat, 1));
      weighted.push({ url, ip, weight: Math.max(w, 0.01) });
    }

    // Add one half_open probe candidate at fixed weight
    if (halfOpen.length > 0 && closed.length > 0) {
      const probe = halfOpen[Math.floor(Math.random() * halfOpen.length)]!;
      weighted.push({ ...probe, weight: HALF_OPEN_PROBE_WEIGHT });
    }

    // Weighted random pick
    const total = weighted.reduce((s, c) => s + c.weight, 0);
    let r = Math.random() * total;
    for (const c of weighted) {
      r -= c.weight;
      if (r <= 0) return { url: c.url, ip: c.ip };
    }
    const last = weighted[weighted.length - 1]!;
    return { url: last.url, ip: last.ip };
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
  proxyPool.recordOutcome(ip, false, 0);
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
    lastProxyIp = null;
    return { agent: getDirectAgent(), ip: 'direct' };
  }
  lastProxyIp = ip;
  let agent = perBotAgentCache.get(url);
  if (!agent) {
    agent = new ProxyAgent({ uri: url });
    perBotAgentCache.set(url, agent);
  }
  return { agent, ip };
}

export function getLastProxyIp(): string | null { return lastProxyIp; }

export async function proxyFetch(
  url: string,
  options: RequestInit,
  provider: ProxyProvider = 'direct',
  proxyUrls?: string[] | null,
): Promise<Response> {
  // Reset fallback metadata before every call
  lastProxyAttemptIp = null;
  lastFallbackHappened = false;
  lastFallbackReason = null;
  lastWebsharePoolSize = 0;

  switch (provider) {
    case 'direct':
      lastProxyIp = null;
      return fetch(url, {
        ...options,
        // @ts-expect-error undici dispatcher works with global fetch
        dispatcher: getDirectAgent(),
      });
    case 'brightdata':
      return fetchViaBrightData(url, options);
    case 'webshare': {
      // Resolve URL list: per-bot override → Webshare API (valid IPs only)
      const effectiveUrls = proxyUrls && proxyUrls.length > 0
        ? proxyUrls
        : await getEffectiveWebshareUrls();
      lastWebsharePoolSize = effectiveUrls.length;

      const { agent, ip: selectedIp } = getNextWebshareAgentFromUrls(effectiveUrls);

      lastProxyAttemptIp = lastProxyIp;

      const t0 = Date.now();
      try {
        const resp = await fetch(url, {
          ...options,
          // @ts-expect-error undici dispatcher works with global fetch
          dispatcher: agent,
        });
        if (selectedIp && selectedIp !== 'direct') {
          proxyPool.recordOutcome(selectedIp, true, Date.now() - t0);
        }
        return resp;
      } catch (err) {
        // Webshare TCP failure — record for pool manager, then fallback to direct
        const msg = err instanceof Error ? err.message : String(err);
        if (/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|other side closed|HTTP Tunneling/i.test(msg)) {
          if (selectedIp && selectedIp !== 'direct') {
            proxyPool.recordOutcome(selectedIp, false, Date.now() - t0);
          }
          // Extract the specific error code for tracing (ECONNRESET, ETIMEDOUT, etc.)
          const codeMatch = msg.match(/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|other side closed/i);
          lastFallbackHappened = true;
          lastFallbackReason = codeMatch ? codeMatch[0].toUpperCase() : 'TCP_FAIL';
          lastProxyIp = null; // will resolve to direct IP
          return fetch(url, {
            ...options,
            // @ts-expect-error undici dispatcher works with global fetch
            dispatcher: getDirectAgent(),
          });
        }
        throw err;
      }
    }
    case 'firecrawl':
      return fetchViaFirecrawl(url, options);
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

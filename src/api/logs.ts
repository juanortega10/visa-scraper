import { Hono } from 'hono';
import { db } from '../db/client.js';
import { bots, pollLogs, rescheduleLogs, casPrefetchLogs, dispatchLogs, bookableEvents, dateSightings, banEpisodes } from '../db/schema.js';
import { eq, desc, and, gte, lte, sql, isNotNull } from 'drizzle-orm';

export const logsRouter = new Hono();

// In-memory cache to reduce Neon egress for heavy 24h full-scan endpoints
const resultCache = new Map<string, { data: unknown; expiresAt: number }>();
function getCached(key: string) {
  const e = resultCache.get(key);
  if (e && Date.now() < e.expiresAt) return e.data;
  return null;
}
function setCached(key: string, data: unknown, ttlMs = 5 * 60_000) {
  resultCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// Poll summary (24h buckets + top 5)
logsRouter.get('/bots/:id/logs/polls/summary', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const hours = parseInt(c.req.query('hours') || '24');
  const cacheKey = `summ-${botId}-${hours}`;
  const cached = getCached(cacheKey);
  if (cached) return c.json(cached);
  const since = new Date(Date.now() - hours * 3600_000);

  // Omit allDates (~10-50 KB/row) — use earliestDate + topDates fallback
  const rows = await db
    .select({
      earliestDate: pollLogs.earliestDate,
      topDates: pollLogs.topDates,
      rawDatesCount: pollLogs.rawDatesCount,
      status: pollLogs.status,
      createdAt: pollLogs.createdAt,
    })
    .from(pollLogs)
    .where(
      and(
        eq(pollLogs.botId, botId),
        gte(pollLogs.createdAt, since),
        sql`${pollLogs.status} IN ('ok', 'filtered_out')`,
      ),
    )
    .orderBy(pollLogs.createdAt);

  // Effective earliest: filtered date if available, fallback to raw topDates[0]
  function getEffectiveDate(r: typeof rows[number]): string | null {
    if (r.earliestDate) return r.earliestDate;
    const td = r.topDates as string[] | null;
    return td && td.length > 0 ? td[0] : null;
  }

  // 30-min buckets (uses effective date — raw trend even for filtered_out)
  const bucketMs = 30 * 60_000;
  const bucketMap = new Map<number, { t: number; dates: string[] }>();
  for (const r of rows) {
    const eff = getEffectiveDate(r);
    if (!eff) continue;
    const ts = new Date(r.createdAt!).getTime();
    const key = Math.floor(ts / bucketMs) * bucketMs;
    let b = bucketMap.get(key);
    if (!b) { b = { t: key, dates: [] }; bucketMap.set(key, b); }
    b.dates.push(eff);
  }
  const buckets = Array.from(bucketMap.values()).map((b) => ({
    t: new Date(b.t).toISOString(),
    earliestDate: b.dates.sort()[0], // best (earliest) in bucket
    count: b.dates.length,
  }));

  // Top 5 best dates — uses effective date (filtered or raw) for traceability
  const seen = new Map<string, string>(); // date → first seenAt ISO
  for (const r of rows) {
    const d = getEffectiveDate(r);
    if (!d) continue;
    if (!seen.has(d)) seen.set(d, new Date(r.createdAt!).toISOString());
  }
  const top5 = Array.from(seen.entries())
    .map(([date, seenAt]) => ({ date, seenAt }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);

  const totalOkPolls = rows.filter((r) => r.status === 'ok').length;
  const totalFilteredOutPolls = rows.filter((r) => r.status === 'filtered_out').length;

  const result = { buckets, top5, totalPolls: rows.length, totalOkPolls, totalFilteredOutPolls, windowHours: hours };
  setCached(cacheKey, result);
  return c.json(result);
});

// Cancellations (server-side computation over full 24h window)
logsRouter.get('/bots/:id/logs/polls/cancellations', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const hours = Math.min(parseInt(c.req.query('hours') || '24'), 240); // cap 10 days
  const cacheKey = `canc-${botId}-${hours}`;
  const cached = getCached(cacheKey);
  if (cached) return c.json(cached);
  const since = new Date(Date.now() - hours * 3600_000);

  const rows = await db
    .select({
      topDates: pollLogs.topDates,
      dateChanges: pollLogs.dateChanges,
      createdAt: pollLogs.createdAt,
    })
    .from(pollLogs)
    .where(
      and(
        eq(pollLogs.botId, botId),
        gte(pollLogs.createdAt, since),
        sql`${pollLogs.status} IN ('ok', 'filtered_out')`,
      ),
    )
    .orderBy(desc(pollLogs.createdAt));

  // Reconstruct dateChanges from topDates for polls missing it (historical)
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].dateChanges) continue;
    const curTd = rows[i].topDates as string[] | null;
    if (!curTd || curTd.length === 0) continue;
    const curSet = new Set(curTd);
    // Find older poll with topDates
    const prevSet = new Set<string>();
    for (let k = i + 1; k < rows.length; k++) {
      const ptd = rows[k].topDates as string[] | null;
      if (ptd && ptd.length > 0) { ptd.forEach((d) => prevSet.add(d)); break; }
    }
    const appeared = [...curSet].filter((d) => !prevSet.has(d));
    const disappeared = [...prevSet].filter((d) => !curSet.has(d));
    if (appeared.length > 0 || disappeared.length > 0) {
      (rows[i] as any).dateChanges = { appeared, disappeared };
    }
  }

  // Compute today in Bogota for "days from now"
  const nowBog = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const todayMs = new Date(nowBog.getFullYear(), nowBog.getMonth(), nowBog.getDate()).getTime();
  function daysFr(ds: string) {
    const [y, m, d] = ds.split('-').map(Number) as [number, number, number];
    return Math.round((new Date(y, m - 1, d).getTime() - todayMs) / 864e5);
  }

  // Build disappearance lookup: date → timestamps[]
  const disMap = new Map<string, number[]>();
  for (const r of rows) {
    const dc = r.dateChanges as { appeared?: string[]; disappeared?: string[] } | null;
    if (!dc?.disappeared?.length) continue;
    const time = new Date(r.createdAt!).getTime();
    for (const dd of dc.disappeared) {
      let arr = disMap.get(dd);
      if (!arr) { arr = []; disMap.set(dd, arr); }
      arr.push(time);
    }
  }
  for (const arr of disMap.values()) arr.sort((a, b) => a - b);

  // Build events
  const events: { time: number; date: string; days: number; goneAt: number | null; dur: number | null }[] = [];
  const uniq = new Set<string>();
  const burstMap = new Map<number, { time: number; count: number; best: number }>();

  for (const r of rows) {
    const dc = r.dateChanges as { appeared?: string[]; disappeared?: string[] } | null;
    if (!dc?.appeared?.length) continue;
    // Filter appeared to only dates within 365 days (skip far-future reload noise)
    // Then skip if still > 30 (true mass-reload after long gap)
    let appeared = dc.appeared;
    if (appeared.length > 30) {
      appeared = appeared.filter((d) => daysFr(d) <= 365);
      if (appeared.length === 0 || appeared.length > 30) continue;
    }
    const time = new Date(r.createdAt!).getTime();
    let burst = burstMap.get(time);
    if (!burst) { burst = { time, count: 0, best: 99999 }; burstMap.set(time, burst); }

    for (const date of appeared) {
      const days = daysFr(date);
      let goneAt: number | null = null, dur: number | null = null;
      const disList = disMap.get(date);
      if (disList) {
        for (const g of disList) { if (g > time) { goneAt = g; dur = g - time; break; } }
      }
      events.push({ time, date, days, goneAt, dur });
      uniq.add(date);
      burst.count++;
      if (days < burst.best) burst.best = days;
    }
  }

  if (events.length === 0) {
    setCached(cacheKey, null);
    return c.json(null);
  }

  const tMin = rows.length > 0 ? new Date(rows[rows.length - 1].createdAt!).getTime() : 0;
  let tMax = rows.length > 0 ? new Date(rows[0].createdAt!).getTime() : 1;
  if (tMin === tMax) tMax = tMin + 1;

  const bursts = [...burstMap.values()]
    .filter((b) => b.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  let closeCount = 0;
  for (const e of events) if (e.days < 60) closeCount++;

  const result = {
    events, tMin, tMax, bursts,
    totalEvents: events.length, uniqueDates: uniq.size, closeCount,
  };
  setCached(cacheKey, result);
  return c.json(result);
});

// Poll health (chain + IP aggregation)
logsRouter.get('/bots/:id/logs/polls/health', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const minutes = parseInt(c.req.query('minutes') || '15');
  const since = new Date(Date.now() - minutes * 60_000);

  const rows = await db
    .select({
      chainId: pollLogs.chainId,
      provider: pollLogs.provider,
      publicIp: pollLogs.publicIp,
      status: pollLogs.status,
      responseTimeMs: pollLogs.responseTimeMs,
      createdAt: pollLogs.createdAt,
    })
    .from(pollLogs)
    .where(and(eq(pollLogs.botId, botId), gte(pollLogs.createdAt, since)))
    .orderBy(desc(pollLogs.createdAt));

  const windowMs = minutes * 60_000;

  // Aggregate by chain
  const chainMap = new Map<string, { polls: number; latencySum: number; latencyCount: number; lastPollAt: string; statuses: Record<string, number> }>();
  // Aggregate by IP
  const ipMap = new Map<string, { polls: number; latencySum: number; latencyCount: number; chain: string; chainCounts: Record<string, number>; successCount: number; tcpBlockedCount: number; lastSeenAt: string; provider: string }>();

  for (const r of rows) {
    const chain = r.chainId || 'unknown';
    const ip = r.publicIp || 'unknown';
    const latency = r.responseTimeMs ?? 0;
    const status = r.status || 'unknown';
    const ts = new Date(r.createdAt!).toISOString();
    const isSuccess = status === 'ok' || status === 'filtered_out';

    // Chain aggregation
    let ch = chainMap.get(chain);
    if (!ch) { ch = { polls: 0, latencySum: 0, latencyCount: 0, lastPollAt: ts, statuses: {} }; chainMap.set(chain, ch); }
    ch.polls++;
    if (latency > 0) { ch.latencySum += latency; ch.latencyCount++; }
    ch.statuses[status] = (ch.statuses[status] || 0) + 1;

    // IP aggregation
    let ipEntry = ipMap.get(ip);
    if (!ipEntry) { ipEntry = { polls: 0, latencySum: 0, latencyCount: 0, chain, chainCounts: {}, successCount: 0, tcpBlockedCount: 0, lastSeenAt: ts, provider: r.provider || 'unknown' }; ipMap.set(ip, ipEntry); }
    ipEntry.polls++;
    if (latency > 0) { ipEntry.latencySum += latency; ipEntry.latencyCount++; }
    if (isSuccess) ipEntry.successCount++;
    if (status === 'tcp_blocked') ipEntry.tcpBlockedCount++;
    ipEntry.chainCounts[chain] = (ipEntry.chainCounts[chain] || 0) + 1;
  }

  const chains: Record<string, object> = {};
  for (const [name, ch] of chainMap) {
    chains[name] = {
      polls: ch.polls,
      pollsPerMin: +(ch.polls / (windowMs / 60_000)).toFixed(1),
      avgLatencyMs: ch.latencyCount > 0 ? Math.round(ch.latencySum / ch.latencyCount) : 0,
      lastPollAt: ch.lastPollAt,
      statuses: ch.statuses,
    };
  }

  const ips: Record<string, object> = {};
  for (const [ip, entry] of ipMap) {
    // Determine predominant chain
    let predominantChain = entry.chain;
    let maxCount = 0;
    for (const [ch, count] of Object.entries(entry.chainCounts)) {
      if (count > maxCount) { predominantChain = ch; maxCount = count; }
    }
    ips[ip] = {
      polls: entry.polls,
      pollsPerMin: +(entry.polls / (windowMs / 60_000)).toFixed(1),
      avgLatencyMs: entry.latencyCount > 0 ? Math.round(entry.latencySum / entry.latencyCount) : 0,
      successRate: entry.polls > 0 ? +(entry.successCount / entry.polls * 100).toFixed(0) : 0,
      tcpBlockedCount: entry.tcpBlockedCount,
      tcpBlockedRate: entry.polls > 0 ? +(entry.tcpBlockedCount / entry.polls * 100).toFixed(1) : 0,
      chain: predominantChain,
      lastSeenAt: entry.lastSeenAt,
      provider: entry.provider,
    };
  }

  // Alerts
  const alerts: Array<{ type: string; message: string; severity: string }> = [];

  // high_fallback: chain with webshare provider but >50% polls on unknown/direct IP
  for (const [chain, ch] of chainMap) {
    const chainIps = [...ipMap.entries()].filter(([, e]) => e.chainCounts[chain]);
    const directPolls = chainIps
      .filter(([ip]) => ip === 'unknown' || !ip.match(/\d+\.\d+\.\d+\.\d+/) || chainIps.length === 1)
      .reduce((sum, [, e]) => sum + (e.chainCounts[chain] || 0), 0);
    if (ch.polls > 5 && directPolls / ch.polls > 0.5) {
      // Check if this chain should be using webshare
      const webshareIps = chainIps.filter(([, e]) => e.provider === 'webshare');
      if (webshareIps.length === 0 && chainIps.some(([, e]) => e.provider === 'direct')) {
        // All direct — expected for cloud chain, skip
      }
    }
  }

  // chain_silent: chain without polls in last 3 min
  const threeMinAgo = Date.now() - 3 * 60_000;
  for (const [chain, ch] of chainMap) {
    const lastMs = new Date(ch.lastPollAt).getTime();
    if (lastMs < threeMinAgo) {
      alerts.push({ type: 'chain_silent', message: `${chain} chain: no polls in ${Math.round((Date.now() - lastMs) / 60_000)}min`, severity: 'warning' });
    }
  }

  // rate_high: IP with >15 req/min
  for (const [ip, entry] of ipMap) {
    const rate = entry.polls / (windowMs / 60_000);
    if (rate > 15) {
      alerts.push({ type: 'rate_high', message: `${ip}: ${rate.toFixed(1)} req/min (limit ~20)`, severity: rate > 18 ? 'critical' : 'warning' });
    }
  }

  // ip_block_rate_high: IP with >5% tcp_blocked in the window (circuit breaker threshold = 3 in 20min)
  for (const [ip, entry] of ipMap) {
    if (entry.tcpBlockedCount === 0) continue;
    const blockRate = entry.tcpBlockedCount / entry.polls;
    if (entry.tcpBlockedCount >= 3 || blockRate > 0.05) {
      const pct = (blockRate * 100).toFixed(0);
      const label = entry.tcpBlockedCount >= 3 ? 'circuit breaker active' : `${pct}% bloqueo`;
      alerts.push({
        type: 'ip_block_rate_high',
        message: `${ip}: ${entry.tcpBlockedCount} tcp_blocked/${entry.polls} polls (${pct}%) — ${label}`,
        severity: blockRate > 0.15 ? 'critical' : 'warning',
      });
    }
  }

  return c.json({
    windowMinutes: minutes,
    totalPolls: rows.length,
    ratePerMin: +(rows.length / (windowMs / 60_000)).toFixed(1),
    chains,
    ips,
    alerts,
  });
});

// Poll logs
logsRouter.get('/bots/:id/logs/polls', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const hasDate = c.req.query('hasDate') === 'true';

  // Omit allDates, phaseTimings, rescheduleDetails to reduce egress
  const logs = await db
    .select({
      id: pollLogs.id, botId: pollLogs.botId,
      earliestDate: pollLogs.earliestDate, datesCount: pollLogs.datesCount,
      rawDatesCount: pollLogs.rawDatesCount, topDates: pollLogs.topDates,
      responseTimeMs: pollLogs.responseTimeMs, status: pollLogs.status,
      error: pollLogs.error, pollPhase: pollLogs.pollPhase,
      rescheduleResult: pollLogs.rescheduleResult,
      chainId: pollLogs.chainId, provider: pollLogs.provider,
      reloginHappened: pollLogs.reloginHappened,
      dateChanges: pollLogs.dateChanges,
      publicIp: pollLogs.publicIp,
      runId: pollLogs.runId,
      fetchIndex: pollLogs.fetchIndex,
      connectionInfo: pollLogs.connectionInfo,
      createdAt: pollLogs.createdAt,
    })
    .from(pollLogs)
    .where(and(
      eq(pollLogs.botId, botId),
      hasDate ? isNotNull(pollLogs.earliestDate) : undefined,
    ))
    .orderBy(desc(pollLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json(logs);
});

// Date history (all-time, one row per Bogota day with earliest poll date seen)
logsRouter.get('/bots/:id/logs/date-history', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const cacheKey = `dh-${botId}`;
  const cached = getCached(cacheKey);
  if (cached) return c.json(cached);

  const rows = await db
    .select({
      day: sql<string>`date_trunc('day', ${pollLogs.createdAt} AT TIME ZONE 'America/Bogota')::date`,
      bestDate: sql<string>`min(${pollLogs.earliestDate})`,
      polls: sql<number>`count(*)::int`,
    })
    .from(pollLogs)
    .where(and(eq(pollLogs.botId, botId), isNotNull(pollLogs.earliestDate)))
    .groupBy(sql`date_trunc('day', ${pollLogs.createdAt} AT TIME ZONE 'America/Bogota')`)
    .orderBy(sql`date_trunc('day', ${pollLogs.createdAt} AT TIME ZONE 'America/Bogota') asc`);

  const days = rows.map((r) => ({
    day: String(r.day).slice(0, 10),
    bestDate: r.bestDate,
    polls: r.polls,
  }));

  const result = { days };
  setCached(cacheKey, result);
  return c.json(result);
});

// Poll log detail (loads allDates on-demand for calendar)
logsRouter.get('/bots/:id/logs/polls/:pollId', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const pollId = parseInt(c.req.param('pollId'));
  if (isNaN(botId) || isNaN(pollId)) return c.json({ error: 'Invalid ID' }, 400);

  const [log] = await db
    .select()
    .from(pollLogs)
    .where(and(eq(pollLogs.id, pollId), eq(pollLogs.botId, botId)))
    .limit(1);

  if (!log) return c.json({ error: 'Not found' }, 404);
  return c.json(log);
});

// CAS prefetch logs
logsRouter.get('/bots/:id/logs/cas-prefetch', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  // Keep changesJson (small, needed for dashboard CAS Changes view)
  // Omit reliabilityJson to reduce egress
  const logs = await db
    .select({
      id: casPrefetchLogs.id, botId: casPrefetchLogs.botId,
      totalDates: casPrefetchLogs.totalDates, fullDates: casPrefetchLogs.fullDates,
      lowDates: casPrefetchLogs.lowDates, durationMs: casPrefetchLogs.durationMs,
      requestCount: casPrefetchLogs.requestCount, error: casPrefetchLogs.error,
      changesJson: casPrefetchLogs.changesJson,
      createdAt: casPrefetchLogs.createdAt,
    })
    .from(casPrefetchLogs)
    .where(eq(casPrefetchLogs.botId, botId))
    .orderBy(desc(casPrefetchLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json(logs);
});

// Dispatch logs (for scout bots)
logsRouter.get('/bots/:id/logs/dispatches', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  // Omit details JSONB (~15-100 KB/row) to reduce egress
  const logs = await db
    .select({
      id: dispatchLogs.id, scoutBotId: dispatchLogs.scoutBotId,
      facilityId: dispatchLogs.facilityId,
      subscribersConsidered: dispatchLogs.subscribersConsidered,
      subscribersAttempted: dispatchLogs.subscribersAttempted,
      subscribersSucceeded: dispatchLogs.subscribersSucceeded,
      subscribersFailed: dispatchLogs.subscribersFailed,
      subscribersSkipped: dispatchLogs.subscribersSkipped,
      durationMs: dispatchLogs.durationMs,
      pollLogId: dispatchLogs.pollLogId, runId: dispatchLogs.runId,
      createdAt: dispatchLogs.createdAt,
    })
    .from(dispatchLogs)
    .where(eq(dispatchLogs.scoutBotId, botId))
    .orderBy(desc(dispatchLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json(logs);
});

// Dispatches received by a subscriber bot
logsRouter.get('/bots/:id/logs/dispatches/received', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const limit = parseInt(c.req.query('limit') || '20');
  const offset = parseInt(c.req.query('offset') || '0');

  // Get subscriber's facility to filter dispatch_logs
  const [bot] = await db
    .select({ consularFacilityId: bots.consularFacilityId })
    .from(bots)
    .where(eq(bots.id, botId))
    .limit(1);
  if (!bot) return c.json({ error: 'Bot not found' }, 404);

  // Query dispatch_logs for this facility, then filter details in JS for this botId
  const logs = await db
    .select({
      id: dispatchLogs.id,
      scoutBotId: dispatchLogs.scoutBotId,
      facilityId: dispatchLogs.facilityId,
      availableDates: dispatchLogs.availableDates,
      details: dispatchLogs.details,
      durationMs: dispatchLogs.durationMs,
      createdAt: dispatchLogs.createdAt,
    })
    .from(dispatchLogs)
    .where(eq(dispatchLogs.facilityId, bot.consularFacilityId))
    .orderBy(desc(dispatchLogs.createdAt))
    .limit(limit * 3) // over-fetch since we filter in JS
    .offset(offset);

  // Filter to dispatches that include this subscriber and extract their detail
  const result = [];
  for (const log of logs) {
    if (result.length >= limit) break;
    const detail = (log.details || []).find((d) => d.botId === botId);
    if (!detail) continue;
    result.push({
      id: log.id,
      scoutBotId: log.scoutBotId,
      availableDates: log.availableDates,
      createdAt: log.createdAt,
      durationMs: log.durationMs,
      detail,
    });
  }

  return c.json(result);
});

// Proxy pool health — derived from poll_logs.connectionInfo (cross-process safe)
// Also fetches the current IP list from Webshare API so unobserved IPs are visible.
logsRouter.get('/bots/:id/proxy-pool', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const windowHours = parseInt(c.req.query('hours') || '2');
  const since = new Date(Date.now() - windowHours * 3_600_000);

  // Fetch bot config + poll logs in parallel
  const [botRows, rows] = await Promise.all([
    db.select({ proxyProvider: bots.proxyProvider, proxyUrls: bots.proxyUrls })
      .from(bots).where(eq(bots.id, botId)).limit(1),
    db.select({
      createdAt: pollLogs.createdAt,
      status: pollLogs.status,
      responseTimeMs: pollLogs.responseTimeMs,
      connectionInfo: pollLogs.connectionInfo,
    }).from(pollLogs)
      .where(and(eq(pollLogs.botId, botId), gte(pollLogs.createdAt, since)))
      .orderBy(pollLogs.createdAt),
  ]);

  const bot = botRows[0];

  // Fetch current IP list from Webshare API (only if bot uses webshare and no per-bot overrides)
  let websharePool: { ip: string; valid: boolean; country: string }[] = [];
  const apiKey = process.env.WEBSHARE_API_KEY;
  if (bot?.proxyProvider === 'webshare' && apiKey) {
    try {
      const resp = await fetch('https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100', {
        headers: { Authorization: `Token ${apiKey}` },
      });
      if (resp.ok) {
        const json = await resp.json() as { results: { proxy_address: string; valid: boolean; country_code: string }[] };
        websharePool = json.results.map((p) => ({ ip: p.proxy_address, valid: p.valid, country: p.country_code }));
      }
    } catch { /* non-fatal */ }
  }

  // Aggregate per attemptedIp (the ip tried before any fallback)
  const ipData: Record<string, {
    polls: number; tcpBlocked: number; ok: number;
    latencies: number[]; lastSeen: string; lastStatus: string;
    embassyBlock: number; proxyInfra: number; proxyQuota: number;
  }> = {};

  for (const r of rows) {
    const ci = r.connectionInfo as Record<string, unknown> | null;
    const ip: string = (ci?.proxyAttemptIp as string) || 'direct';
    const fallback = !!(ci?.fallbackHappened);
    const isTcp = r.status === 'tcp_blocked' || fallback;

    if (!ipData[ip]) ipData[ip] = { polls: 0, tcpBlocked: 0, ok: 0, latencies: [], lastSeen: '', lastStatus: '', embassyBlock: 0, proxyInfra: 0, proxyQuota: 0 };
    const d = ipData[ip]!;
    d.polls++;
    d.lastSeen = r.createdAt?.toISOString() ?? '';
    d.lastStatus = r.status ?? '';
    if (isTcp) {
      d.tcpBlocked++;
      const errorSource = ci?.errorSource as string | undefined;
      if (errorSource === 'embassy_block') d.embassyBlock++;
      else if (errorSource === 'proxy_infra') d.proxyInfra++;
      else if (errorSource === 'proxy_quota') d.proxyQuota++;
    } else {
      d.ok++;
      if (r.responseTimeMs) d.latencies.push(r.responseTimeMs);
    }
  }

  // Seed unobserved Webshare IPs with zero stats
  for (const { ip } of websharePool) {
    if (!ipData[ip]) ipData[ip] = { polls: 0, tcpBlocked: 0, ok: 0, latencies: [], lastSeen: '', lastStatus: '' };
  }

  // Build response — attach Webshare metadata where available
  const webshareByIp = Object.fromEntries(websharePool.map((p) => [p.ip, p]));
  const ips = Object.fromEntries(
    Object.entries(ipData).map(([ip, d]) => {
      const ws = webshareByIp[ip];
      const avgLatMs = d.latencies.length > 0
        ? Math.round(d.latencies.reduce((s, v) => s + v, 0) / d.latencies.length)
        : null;
      return [ip, {
        polls: d.polls,
        tcpBlocked: d.tcpBlocked,
        tcpBlockedRate: d.polls > 0 ? Math.round(d.tcpBlocked / d.polls * 100) : 0,
        okRate: d.polls > 0 ? Math.round(d.ok / d.polls * 100) : 100,
        avgLatMs,
        lastSeen: d.lastSeen || null,
        lastStatus: d.lastStatus || null,
        tcpBreakdown: {
          embassyBlock: d.embassyBlock,
          proxyInfra: d.proxyInfra,
          proxyQuota: d.proxyQuota,
          unknown: d.tcpBlocked - d.embassyBlock - d.proxyInfra - d.proxyQuota,
        },
        // Webshare metadata (null for direct/non-webshare IPs)
        wsValid: ws?.valid ?? null,
        wsCountry: ws?.country ?? null,
        windowHours,
      }];
    })
  );

  const recentTcp = rows.filter((r) => r.status === 'tcp_blocked');
  const recentQuota = recentTcp.filter((r) =>
    ((r.connectionInfo as Record<string, unknown> | null)?.errorSource) === 'proxy_quota'
  );
  const quotaExhausted = recentTcp.length >= 3 && recentTcp.length === recentQuota.length;

  return c.json({
    ips,
    websharePoolSize: websharePool.length,
    windowHours,
    totalPolls: rows.length,
    quotaExhausted,
  });
});

// Bookable events
logsRouter.get('/bots/:id/logs/bookable-events', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const hours = Math.min(parseInt(c.req.query('hours') || '168'), 720); // cap 30 days
  const cacheKey = `be-${botId}-${hours}`;
  const cached = getCached(cacheKey);
  if (cached) return c.json(cached);

  const since = new Date(Date.now() - hours * 3_600_000);
  const rows = await db
    .select()
    .from(bookableEvents)
    .where(and(eq(bookableEvents.botId, botId), gte(bookableEvents.detectedAt, since)))
    .orderBy(desc(bookableEvents.detectedAt))
    .limit(300);

  setCached(cacheKey, rows, 60_000);
  return c.json(rows);
});

// Date sightings (materialized cancellations)
logsRouter.get('/bots/:id/logs/date-sightings', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const hours = Math.min(parseInt(c.req.query('hours') || '24'), 240);
  const maxDays = parseInt(c.req.query('maxDays') || '365');
  const cacheKey = `ds-${botId}-${hours}-${maxDays}`;
  const cached = getCached(cacheKey);
  if (cached) return c.json(cached);

  const since = new Date(Date.now() - hours * 3600_000);
  const rows = await db
    .select()
    .from(dateSightings)
    .where(and(
      eq(dateSightings.botId, botId),
      gte(dateSightings.appearedAt, since),
      lte(dateSightings.daysFromNow, maxDays),
    ))
    .orderBy(desc(dateSightings.appearedAt))
    .limit(500);

  const result = {
    events: rows.map(r => ({
      date: r.date,
      time: new Date(r.appearedAt).getTime(),
      days: r.daysFromNow,
      goneAt: r.disappearedAt ? new Date(r.disappearedAt).getTime() : null,
      dur: r.durationMs,
    })),
    totalEvents: rows.length,
    uniqueDates: new Set(rows.map(r => r.date)).size,
    closeCount: rows.filter(r => r.daysFromNow != null && r.daysFromNow < 60).length,
    tMin: rows.length > 0 ? new Date(rows[rows.length - 1].appearedAt).getTime() : 0,
    tMax: rows.length > 0 ? new Date(rows[0].appearedAt).getTime() : 1,
  };
  setCached(cacheKey, result, 60_000);
  return c.json(result);
});

// Reschedule logs
logsRouter.get('/bots/:id/logs/reschedules', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const logs = await db
    .select()
    .from(rescheduleLogs)
    .where(eq(rescheduleLogs.botId, botId))
    .orderBy(desc(rescheduleLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json(logs);
});

// ── Ban Status ────────────────────────────────────────────

logsRouter.get('/bots/:id/ban-status', async (c) => {
  const botId = parseInt(c.req.param('id'));
  if (isNaN(botId)) return c.json({ error: 'Invalid bot ID' }, 400);

  const cacheKey = `ban-status-${botId}`;
  const cached = getCached(cacheKey);
  if (cached) return c.json(cached);

  const [openBan] = await db.select().from(banEpisodes)
    .where(and(eq(banEpisodes.botId, botId), sql`${banEpisodes.endedAt} IS NULL`))
    .limit(1);

  const stats = await db.execute<{
    classification: string; count: string; avg_min: string;
    median_min: string; p90_min: string; min_min: string; max_min: string;
  }>(sql`
    SELECT classification,
      COUNT(*)::text as count,
      ROUND(AVG(duration_min))::text as avg_min,
      ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_min))::text as median_min,
      ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY duration_min))::text as p90_min,
      MIN(duration_min)::text as min_min,
      MAX(duration_min)::text as max_min
    FROM ban_episodes
    WHERE bot_id = ${botId} AND ended_at IS NOT NULL AND duration_min IS NOT NULL
    GROUP BY classification
  `);

  const historicalStats: Record<string, { count: number; avgMin: number; medianMin: number; p90Min: number }> = {};
  for (const row of stats.rows) {
    historicalStats[row.classification] = {
      count: parseInt(row.count), avgMin: parseInt(row.avg_min),
      medianMin: parseInt(row.median_min), p90Min: parseInt(row.p90_min),
    };
  }

  const recentEpisodes = await db.select({
    id: banEpisodes.id, startedAt: banEpisodes.startedAt, endedAt: banEpisodes.endedAt,
    durationMin: banEpisodes.durationMin, classification: banEpisodes.classification, pollCount: banEpisodes.pollCount,
  }).from(banEpisodes).where(eq(banEpisodes.botId, botId)).orderBy(desc(banEpisodes.startedAt)).limit(5);

  let currentBan = null;
  let estimatedRecoveryMin = null;
  if (openBan) {
    const durationSoFarMin = Math.round((Date.now() - openBan.startedAt.getTime()) / 60000);
    const clsStats = historicalStats[openBan.classification];
    estimatedRecoveryMin = clsStats ? Math.max(0, clsStats.medianMin - durationSoFarMin) : null;
    currentBan = {
      startedAt: openBan.startedAt, durationSoFarMin, classification: openBan.classification,
      pollCount: openBan.pollCount, pollDetails: openBan.pollDetails, triggerContext: openBan.triggerContext,
    };
  }

  const result = { currentBan, estimatedRecoveryMin, historicalStats, recentEpisodes };
  setCached(cacheKey, result, 60_000);
  return c.json(result);
});

// ── Ban Episodes List ─────────────────────────────────────

logsRouter.get('/bots/:id/ban-episodes', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const limit = parseInt(c.req.query('limit') || '20');
  const offset = parseInt(c.req.query('offset') || '0');

  const episodes = await db.select().from(banEpisodes)
    .where(eq(banEpisodes.botId, botId))
    .orderBy(desc(banEpisodes.startedAt))
    .limit(limit).offset(offset);

  return c.json(episodes);
});

// ── Reschedule Analytics ──────────────────────────────────

logsRouter.get('/bots/:id/reschedule-analytics', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const days = parseInt(c.req.query('days') || '30');
  if (isNaN(botId)) return c.json({ error: 'Invalid bot ID' }, 400);

  const cacheKey = `reschedule-analytics-${botId}-${days}`;
  const cached = getCached(cacheKey);
  if (cached) return c.json(cached);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const reschedules = await db.select({
    success: rescheduleLogs.success, createdAt: rescheduleLogs.createdAt,
    oldConsularDate: rescheduleLogs.oldConsularDate, newConsularDate: rescheduleLogs.newConsularDate,
  }).from(rescheduleLogs).where(and(eq(rescheduleLogs.botId, botId), gte(rescheduleLogs.createdAt, since)));

  const successes = reschedules.filter(r => r.success);

  const outcomeRows = await db.execute<{ outcome: string; count: string }>(sql`
    SELECT outcome, COUNT(*)::text as count FROM bookable_events
    WHERE bot_id = ${botId} AND detected_at >= ${since} GROUP BY outcome ORDER BY count DESC
  `);
  const failureBreakdown: Record<string, number> = {};
  for (const r of outcomeRows.rows) failureBreakdown[r.outcome] = parseInt(r.count);

  const hourly = await db.execute<{ hour: string; successes: string; total: string }>(sql`
    SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Bogota')::text as hour,
      SUM(CASE WHEN success THEN 1 ELSE 0 END)::text as successes, COUNT(*)::text as total
    FROM reschedule_logs WHERE bot_id = ${botId} AND created_at >= ${since} GROUP BY 1 ORDER BY 1
  `);
  const byHourBogota = hourly.rows.map(r => ({
    hour: parseInt(r.hour), successes: parseInt(r.successes), attempts: parseInt(r.total),
  }));

  const daily = await db.execute<{ dow: string; successes: string; total: string }>(sql`
    SELECT EXTRACT(DOW FROM created_at AT TIME ZONE 'America/Bogota')::text as dow,
      SUM(CASE WHEN success THEN 1 ELSE 0 END)::text as successes, COUNT(*)::text as total
    FROM reschedule_logs WHERE bot_id = ${botId} AND created_at >= ${since} GROUP BY 1 ORDER BY 1
  `);
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const byDayOfWeek = daily.rows.map(r => ({
    day: dayNames[parseInt(r.dow)] ?? r.dow, successes: parseInt(r.successes), attempts: parseInt(r.total),
  }));

  const durationStats = await db.execute<{ median_ms: string }>(sql`
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)::text as median_ms
    FROM date_sightings WHERE bot_id = ${botId} AND appeared_at >= ${since} AND duration_ms IS NOT NULL
  `);
  const medianSlotDurationMin = durationStats.rows[0]?.median_ms
    ? Math.round(parseInt(durationStats.rows[0].median_ms) / 60000 * 10) / 10 : null;

  const improvements = successes
    .filter(r => r.oldConsularDate && r.newConsularDate)
    .map(r => Math.round((new Date(r.oldConsularDate!).getTime() - new Date(r.newConsularDate!).getTime()) / 86400000))
    .filter(d => d > 0);

  const result = {
    summary: {
      totalAttempts: reschedules.length, successes: successes.length,
      successRate: reschedules.length > 0 ? Math.round(successes.length / reschedules.length * 1000) / 1000 : 0,
    },
    failureBreakdown,
    timingPatterns: { byHourBogota, byDayOfWeek, medianSlotDurationMin },
    datePatterns: {
      avgDaysImprovement: improvements.length > 0 ? Math.round(improvements.reduce((a, b) => a + b, 0) / improvements.length) : null,
      totalImprovements: improvements.length,
    },
  };

  setCached(cacheKey, result, 5 * 60_000);
  return c.json(result);
});

// ── Cross-Schedule Date Comparison ────────────────────────

logsRouter.get('/cross-schedule-comparison', async (c) => {
  const cacheKey = 'cross-schedule-comparison';
  const cached = getCached(cacheKey);
  if (cached) return c.json(cached);

  const activeBots = await db.select({
    id: bots.id, scheduleId: bots.scheduleId, locale: bots.locale,
    applicantCount: sql<number>`array_length(${bots.applicantIds}, 1)`,
  }).from(bots).where(eq(bots.status, 'active'));

  const schedules: Array<{ botId: number; scheduleId: string | null; applicantCount: number; locale: string | null; dates: string[] }> = [];

  for (const bot of activeBots) {
    const [poll] = await db.select({ allDates: pollLogs.allDates }).from(pollLogs)
      .where(and(eq(pollLogs.botId, bot.id), sql`${pollLogs.status} IN ('ok', 'filtered_out')`, isNotNull(pollLogs.allDates)))
      .orderBy(desc(pollLogs.createdAt)).limit(1);
    if (!poll?.allDates) continue;
    const dates = (poll.allDates as Array<{ date: string }>).map(d => d.date);
    schedules.push({ botId: bot.id, scheduleId: bot.scheduleId, applicantCount: bot.applicantCount ?? 0, locale: bot.locale, dates });
  }

  const byLocale: Record<string, typeof schedules> = {};
  for (const s of schedules) (byLocale[s.locale ?? 'es-co'] ??= []).push(s);

  const comparisons: Array<{
    locale: string;
    bots: Array<{ botId: number; scheduleId: string | null; applicantCount: number; datesCount: number }>;
    sharedDates: number; uniqueDates: Record<number, string[]>;
  }> = [];

  for (const [locale, localeBots] of Object.entries(byLocale)) {
    if (localeBots.length < 2) continue;
    const sets = localeBots.map(b => new Set(b.dates));
    const shared = [...sets[0]!].filter(d => sets.every(s => s.has(d)));
    const uniqueDates: Record<number, string[]> = {};
    for (let i = 0; i < localeBots.length; i++) {
      const only = localeBots[i]!.dates.filter(d => sets.every((s, j) => j === i || !s.has(d)));
      if (only.length > 0) uniqueDates[localeBots[i]!.botId] = only.slice(0, 10);
    }
    comparisons.push({
      locale,
      bots: localeBots.map(b => ({ botId: b.botId, scheduleId: b.scheduleId, applicantCount: b.applicantCount, datesCount: b.dates.length })),
      sharedDates: shared.length, uniqueDates,
    });
  }

  const result = { comparisons, timestamp: new Date().toISOString() };
  setCached(cacheKey, result, 5 * 60_000);
  return c.json(result);
});

// ── Slot Patterns (global) ────────────────────────────────

logsRouter.get('/slot-patterns', async (c) => {
  const days = parseInt(c.req.query('days') || '7');
  const cacheKey = `slot-patterns-${days}`;
  const cached = getCached(cacheKey);
  if (cached) return c.json(cached);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const hourly = await db.execute<{ hour: string; count: string; median_duration_ms: string }>(sql`
    SELECT EXTRACT(HOUR FROM appeared_at AT TIME ZONE 'America/Bogota')::text as hour,
      COUNT(*)::text as count,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)::text as median_duration_ms
    FROM date_sightings WHERE appeared_at >= ${since} AND duration_ms IS NOT NULL GROUP BY 1 ORDER BY 1
  `);
  const hourlyDistribution = hourly.rows.map(r => ({
    hour: parseInt(r.hour), sightings: parseInt(r.count),
    medianDurationMin: r.median_duration_ms ? Math.round(parseInt(r.median_duration_ms) / 60000 * 10) / 10 : null,
  }));

  const daily = await db.execute<{ dow: string; count: string }>(sql`
    SELECT EXTRACT(DOW FROM appeared_at AT TIME ZONE 'America/Bogota')::text as dow, COUNT(*)::text as count
    FROM date_sightings WHERE appeared_at >= ${since} GROUP BY 1 ORDER BY 1
  `);
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayOfWeekDistribution = daily.rows.map(r => ({
    day: dayNames[parseInt(r.dow)] ?? r.dow, sightings: parseInt(r.count),
  }));

  const proximity = await db.execute<{ bucket: string; count: string; median_duration_ms: string }>(sql`
    SELECT CASE WHEN days_from_now < 30 THEN 'under30days' WHEN days_from_now < 90 THEN '30to90days' ELSE 'over90days' END as bucket,
      COUNT(*)::text as count,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)::text as median_duration_ms
    FROM date_sightings WHERE appeared_at >= ${since} AND duration_ms IS NOT NULL AND days_from_now IS NOT NULL GROUP BY 1
  `);
  const closeDateStats: Record<string, { count: number; medianDurationMin: number | null }> = {};
  for (const r of proximity.rows) {
    closeDateStats[r.bucket] = {
      count: parseInt(r.count),
      medianDurationMin: r.median_duration_ms ? Math.round(parseInt(r.median_duration_ms) / 60000 * 10) / 10 : null,
    };
  }

  const result = { hourlyDistribution, dayOfWeekDistribution, closeDateStats, periodDays: days };
  setCached(cacheKey, result, 10 * 60_000);
  return c.json(result);
});

// ── Poll Rate Analysis ────────────────────────────────────

logsRouter.get('/poll-rate-analysis', async (c) => {
  const days = parseInt(c.req.query('days') || '7');
  const cacheKey = `poll-rate-analysis-${days}`;
  const cached = getCached(cacheKey);
  if (cached) return c.json(cached);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const overall = await db.execute<{ total: string; tcp_blocked: string; soft_ban: string }>(sql`
    SELECT COUNT(*)::text as total,
      SUM(CASE WHEN status = 'tcp_blocked' THEN 1 ELSE 0 END)::text as tcp_blocked,
      SUM(CASE WHEN status = 'soft_ban' THEN 1 ELSE 0 END)::text as soft_ban
    FROM poll_logs WHERE created_at >= ${since}
  `);
  const totalPolls = parseInt(overall.rows[0]?.total ?? '0');
  const tcpBlocked = parseInt(overall.rows[0]?.tcp_blocked ?? '0');
  const softBan = parseInt(overall.rows[0]?.soft_ban ?? '0');

  const rateCorrelation = await db.execute<{ rate_bucket: string; polls: string; blocked: string }>(sql`
    WITH gaps AS (
      SELECT status, EXTRACT(EPOCH FROM created_at - LAG(created_at) OVER (PARTITION BY bot_id ORDER BY created_at)) as gap_s
      FROM poll_logs WHERE created_at >= ${since}
    ),
    rated AS (
      SELECT status,
        CASE WHEN gap_s IS NULL OR gap_s > 120 OR gap_s <= 0 THEN NULL ELSE ROUND(60.0 / gap_s, 1) END as rate_per_min
      FROM gaps
    )
    SELECT CASE WHEN rate_per_min < 1 THEN '<1/min' WHEN rate_per_min < 3 THEN '1-3/min'
      WHEN rate_per_min < 5 THEN '3-5/min' WHEN rate_per_min < 8 THEN '5-8/min' ELSE '8+/min' END as rate_bucket,
      COUNT(*)::text as polls, SUM(CASE WHEN status = 'tcp_blocked' THEN 1 ELSE 0 END)::text as blocked
    FROM rated WHERE rate_per_min IS NOT NULL GROUP BY 1 ORDER BY MIN(rate_per_min)
  `);
  const rateVsBanCorrelation = rateCorrelation.rows.map(r => ({
    rateRange: r.rate_bucket, polls: parseInt(r.polls), blocked: parseInt(r.blocked),
    blockRate: parseInt(r.polls) > 0 ? Math.round(parseInt(r.blocked) / parseInt(r.polls) * 10000) / 10000 : 0,
  }));

  const byProviderRows = await db.execute<{ provider: string; polls: string; blocked: string; avg_ms: string }>(sql`
    SELECT COALESCE(provider, 'unknown') as provider, COUNT(*)::text as polls,
      SUM(CASE WHEN status = 'tcp_blocked' THEN 1 ELSE 0 END)::text as blocked,
      ROUND(AVG(response_time_ms))::text as avg_ms
    FROM poll_logs WHERE created_at >= ${since} GROUP BY 1 ORDER BY COUNT(*) DESC
  `);
  const byProvider: Record<string, { polls: number; blockRate: number; avgResponseMs: number }> = {};
  for (const r of byProviderRows.rows) {
    const p = parseInt(r.polls);
    byProvider[r.provider] = { polls: p, blockRate: p > 0 ? Math.round(parseInt(r.blocked) / p * 10000) / 10000 : 0, avgResponseMs: parseInt(r.avg_ms) };
  }

  const sessionAge = await db.execute<{ age_bucket: string; polls: string; blocked: string }>(sql`
    SELECT CASE
        WHEN (connection_info->>'sessionAgeMs')::int < 900000 THEN '0-15min'
        WHEN (connection_info->>'sessionAgeMs')::int < 1800000 THEN '15-30min'
        WHEN (connection_info->>'sessionAgeMs')::int < 2700000 THEN '30-45min'
        WHEN (connection_info->>'sessionAgeMs')::int < 3600000 THEN '45-60min'
        ELSE '60min+'
      END as age_bucket,
      COUNT(*)::text as polls, SUM(CASE WHEN status = 'tcp_blocked' THEN 1 ELSE 0 END)::text as blocked
    FROM poll_logs WHERE created_at >= ${since} AND connection_info->>'sessionAgeMs' IS NOT NULL
    GROUP BY 1 ORDER BY MIN((connection_info->>'sessionAgeMs')::int)
  `);
  const sessionAgeVsBlock = sessionAge.rows.map(r => ({
    ageRange: r.age_bucket, polls: parseInt(r.polls),
    blockRate: parseInt(r.polls) > 0 ? Math.round(parseInt(r.blocked) / parseInt(r.polls) * 10000) / 10000 : 0,
  }));

  const safeBuckets = rateVsBanCorrelation.filter(r => r.blockRate < 0.05);
  const optimalRate = safeBuckets.length > 0 ? safeBuckets[safeBuckets.length - 1]!.rateRange : 'unknown';

  const result = {
    overallStats: { totalPolls, tcpBlockedRate: totalPolls > 0 ? Math.round(tcpBlocked / totalPolls * 10000) / 10000 : 0, softBanRate: totalPolls > 0 ? Math.round(softBan / totalPolls * 10000) / 10000 : 0, periodDays: days },
    rateVsBanCorrelation, byProvider, sessionAgeVsBlock,
    recommendation: { optimalRate, reasoning: `Highest rate bucket with <5% block rate: ${optimalRate}` },
  };

  setCached(cacheKey, result, 10 * 60_000);
  return c.json(result);
});


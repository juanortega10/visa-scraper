import { Hono } from 'hono';
import { db } from '../db/client.js';
import { sql } from 'drizzle-orm';

export const blockIntelRouter = new Hono();

// In-memory cache (same pattern as logs.ts)
const resultCache = new Map<string, { data: unknown; expiresAt: number }>();
function getCached(key: string) {
  const e = resultCache.get(key);
  if (e && Date.now() < e.expiresAt) return e.data;
  return null;
}
function setCached(key: string, data: unknown, ttlMs = 60_000) {
  resultCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// ── Endpoint A: Cross-bot IP correlation ────────────────────────────────────
// Per-IP: which bots were affected, temporal overlap, verdict
blockIntelRouter.get('/cross-bot', async (c) => {
  const hours = Math.min(parseInt(c.req.query('hours') || '24'), 720);
  const cacheKey = `bi-xbot-${hours}`;
  const cached = getCached(cacheKey);
  if (cached) return c.json(cached);

  const { rows } = await db.execute(sql`
    SELECT
      public_ip,
      bot_id,
      count(*)::int AS total_polls,
      count(*) FILTER (WHERE status = 'tcp_blocked')::int AS tcp_blocked,
      ROUND(count(*) FILTER (WHERE status = 'tcp_blocked')::numeric / NULLIF(count(*), 0) * 100, 1) AS block_rate,
      min(created_at) FILTER (WHERE status = 'tcp_blocked') AS first_block,
      max(created_at) FILTER (WHERE status = 'tcp_blocked') AS last_block,
      mode() WITHIN GROUP (ORDER BY provider) AS provider
    FROM poll_logs
    WHERE created_at > NOW() - ${hours + ' hours'}::interval
      AND public_ip IS NOT NULL
    GROUP BY public_ip, bot_id
    ORDER BY public_ip, tcp_blocked DESC
  `);

  // Group by IP and compute cross-bot verdicts
  const ipMap = new Map<string, {
    bots: Array<{ botId: number; totalPolls: number; tcpBlocked: number; blockRate: number; firstBlock: string | null; lastBlock: string | null; provider: string }>;
  }>();

  for (const r of rows) {
    const ip = r.public_ip as string;
    let entry = ipMap.get(ip);
    if (!entry) { entry = { bots: [] }; ipMap.set(ip, entry); }
    entry.bots.push({
      botId: r.bot_id as number,
      totalPolls: r.total_polls as number,
      tcpBlocked: r.tcp_blocked as number,
      blockRate: Number(r.block_rate),
      firstBlock: r.first_block as string | null,
      lastBlock: r.last_block as string | null,
      provider: r.provider as string,
    });
  }

  const ips = Object.fromEntries(
    [...ipMap.entries()]
      .filter(([, v]) => v.bots.some(b => b.tcpBlocked > 0))
      .map(([ip, v]) => {
        const botsWithBlocks = v.bots.filter(b => b.tcpBlocked > 0).length;
        const totalBots = v.bots.length;
        const verdict = botsWithBlocks >= 2 && botsWithBlocks / totalBots > 0.5
          ? 'ip_scoped'
          : botsWithBlocks === 1 && totalBots >= 2
            ? 'account_scoped'
            : 'inconclusive';
        return [ip, { bots: v.bots, verdict, botsAffected: botsWithBlocks, botsTotal: totalBots }];
      }),
  );

  const result = { ips, windowHours: hours };
  setCached(cacheKey, result);
  return c.json(result);
});

// ── Endpoint B: Block episodes ──────────────────────────────────────────────
// Contiguous tcp_blocked streaks with start/end/duration/classification/recovery
blockIntelRouter.get('/episodes', async (c) => {
  const botId = c.req.query('botId') ? parseInt(c.req.query('botId')!) : undefined;
  const hours = Math.min(parseInt(c.req.query('hours') || '48'), 720);
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const cacheKey = `bi-ep-${botId ?? 'all'}-${hours}-${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return c.json(cached);

  // Get tcp_blocked polls + their neighbors for episode boundary detection
  const { rows } = await db.execute(sql.raw(`
    WITH blocked_windows AS (
      SELECT bot_id,
        min(created_at) AS window_start,
        max(created_at) AS window_end
      FROM poll_logs
      WHERE created_at > NOW() - '${hours} hours'::interval
        AND status = 'tcp_blocked'
        ${botId ? `AND bot_id = ${botId}` : ''}
      GROUP BY bot_id, date_trunc('hour', created_at)
    )
    SELECT p.id, p.bot_id, p.status, p.created_at,
      p.public_ip, p.provider, p.response_time_ms,
      p.connection_info->>'blockClassification' AS block_cls,
      p.connection_info->>'tcpSubcategory' AS tcp_sub,
      p.connection_info->>'errorSource' AS error_src
    FROM poll_logs p
    JOIN blocked_windows bw ON p.bot_id = bw.bot_id
      AND p.created_at BETWEEN bw.window_start - interval '5 minutes' AND bw.window_end + interval '5 minutes'
    WHERE p.created_at > NOW() - '${hours} hours'::interval
    ORDER BY p.bot_id, p.created_at
    LIMIT 5000
  `));

  // Build episodes: contiguous tcp_blocked streaks per bot
  interface PollRow {
    bot_id: number;
    status: string;
    created_at: string;
    public_ip: string | null;
    block_cls: string | null;
    tcp_sub: string | null;
    provider: string | null;
    response_time_ms: number | null;
  }
  interface EpisodeBuilder {
    botId: number;
    polls: PollRow[];
    preBlockLatencies: number[];
  }

  type Episode = {
    botId: number;
    startAt: string;
    endAt: string;
    durationMin: number;
    pollCount: number;
    classifications: Record<string, number>;
    subcategories: Record<string, number>;
    ips: string[];
    provider: string | null;
    recoveryMethod: string;
    preBlockAvgLatencyMs: number | null;
  };

  const episodes: Episode[] = [];

  function finalizeEpisode(ep: EpisodeBuilder, recoveryPoll?: PollRow) {
    if (ep.polls.length === 0) return;
    const first = ep.polls[0]!;
    const last = ep.polls[ep.polls.length - 1]!;
    const start = new Date(first.created_at);
    const end = new Date(last.created_at);
    const classifications: Record<string, number> = {};
    const subcategories: Record<string, number> = {};
    const ipSet = new Set<string>();

    for (const p of ep.polls) {
      const cls = p.block_cls || 'unknown';
      classifications[cls] = (classifications[cls] || 0) + 1;
      const sub = p.tcp_sub || 'unknown';
      subcategories[sub] = (subcategories[sub] || 0) + 1;
      if (p.public_ip) ipSet.add(p.public_ip);
    }

    let recoveryMethod = 'unknown';
    if (recoveryPoll) {
      if (last.public_ip && recoveryPoll.public_ip && last.public_ip !== recoveryPoll.public_ip) {
        recoveryMethod = 'ip_rotation';
      } else if (recoveryPoll.status === 'ok' || recoveryPoll.status === 'filtered_out') {
        recoveryMethod = 'natural_recovery';
      }
    }

    const avgPreBlock = ep.preBlockLatencies.length > 0
      ? Math.round(ep.preBlockLatencies.reduce((s, v) => s + v, 0) / ep.preBlockLatencies.length)
      : null;

    episodes.push({
      botId: ep.botId,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      durationMin: Math.round((end.getTime() - start.getTime()) / 60_000 * 10) / 10,
      pollCount: ep.polls.length,
      classifications,
      subcategories,
      ips: [...ipSet],
      provider: first.provider,
      recoveryMethod,
      preBlockAvgLatencyMs: avgPreBlock,
    });
  }

  let current: EpisodeBuilder | null = null;

  for (const r of rows) {
    const poll = r as unknown as PollRow;
    if (poll.status === 'tcp_blocked') {
      if (!current || current.botId !== poll.bot_id) {
        if (current) finalizeEpisode(current);
        current = { botId: poll.bot_id, polls: [], preBlockLatencies: [] };
      }
      current.polls.push(poll);
    } else {
      if (current && current.botId === poll.bot_id) {
        if (current.polls.length === 0 && poll.response_time_ms) {
          current.preBlockLatencies.push(poll.response_time_ms);
        }
        if (current.polls.length > 0) {
          finalizeEpisode(current, poll);
          current = null;
        }
      }
    }
  }
  if (current && current.polls.length > 0) finalizeEpisode(current);

  episodes.sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime());
  const result = { episodes: episodes.slice(0, limit), totalEpisodes: episodes.length, windowHours: hours };
  setCached(cacheKey, result);
  return c.json(result);
});

// ── Endpoint C: Risk factors ────────────────────────────────────────────────
// Rate-vs-block, provider-vs-block, hour-of-day, day-of-week correlations
blockIntelRouter.get('/risk-factors', async (c) => {
  const hours = Math.min(parseInt(c.req.query('hours') || '48'), 720);
  const cacheKey = `bi-rf-${hours}`;
  const cached = getCached(cacheKey);
  if (cached) return c.json(cached);

  const [byProvider, byHour, byDow, byLocale, byClassification] = await Promise.all([
    db.execute(sql`
      SELECT provider, count(*)::int AS total,
        count(*) FILTER (WHERE status = 'tcp_blocked')::int AS blocked,
        ROUND(count(*) FILTER (WHERE status = 'tcp_blocked')::numeric / NULLIF(count(*), 0) * 100, 2) AS block_rate
      FROM poll_logs
      WHERE created_at > NOW() - ${hours + ' hours'}::interval AND provider IS NOT NULL
      GROUP BY provider ORDER BY block_rate DESC
    `),
    db.execute(sql`
      SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Bogota')::int AS hour,
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'tcp_blocked')::int AS blocked,
        ROUND(count(*) FILTER (WHERE status = 'tcp_blocked')::numeric / NULLIF(count(*), 0) * 100, 2) AS block_rate
      FROM poll_logs
      WHERE created_at > NOW() - ${hours + ' hours'}::interval
      GROUP BY hour ORDER BY hour
    `),
    db.execute(sql`
      SELECT EXTRACT(DOW FROM created_at AT TIME ZONE 'America/Bogota')::int AS dow,
        TO_CHAR(created_at AT TIME ZONE 'America/Bogota', 'Day') AS day_name,
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'tcp_blocked')::int AS blocked,
        ROUND(count(*) FILTER (WHERE status = 'tcp_blocked')::numeric / NULLIF(count(*), 0) * 100, 2) AS block_rate
      FROM poll_logs
      WHERE created_at > NOW() - ${hours + ' hours'}::interval
      GROUP BY dow, day_name ORDER BY dow
    `),
    db.execute(sql`
      SELECT b.locale, count(*)::int AS total,
        count(*) FILTER (WHERE p.status = 'tcp_blocked')::int AS blocked,
        ROUND(count(*) FILTER (WHERE p.status = 'tcp_blocked')::numeric / NULLIF(count(*), 0) * 100, 2) AS block_rate
      FROM poll_logs p
      JOIN bots b ON p.bot_id = b.id
      WHERE p.created_at > NOW() - ${hours + ' hours'}::interval
      GROUP BY b.locale ORDER BY block_rate DESC
    `),
    db.execute(sql`
      SELECT COALESCE(connection_info->>'blockClassification', 'null') AS classification,
        count(*)::int
      FROM poll_logs
      WHERE created_at > NOW() - ${hours + ' hours'}::interval AND status = 'tcp_blocked'
      GROUP BY classification ORDER BY count DESC
    `),
  ]);

  const result = {
    byProvider: byProvider.rows,
    byHour: byHour.rows.map(r => ({ ...r, block_rate: Number(r.block_rate) })),
    byDayOfWeek: byDow.rows.map(r => ({
      ...r,
      day_name: typeof r.day_name === 'string' ? r.day_name.trim() : r.day_name,
      block_rate: Number(r.block_rate),
    })),
    byLocale: byLocale.rows,
    classificationBreakdown: byClassification.rows,
    windowHours: hours,
  };
  setCached(cacheKey, result, 2 * 60_000);
  return c.json(result);
});

// ── Endpoint D: Time-series trends ──────────────────────────────────────────
blockIntelRouter.get('/trends', async (c) => {
  const hours = Math.min(parseInt(c.req.query('hours') || '168'), 720);
  const granularity = c.req.query('granularity') === 'day' ? 'day' : 'hour';
  const cacheKey = `bi-tr-${hours}-${granularity}`;
  const cached = getCached(cacheKey);
  if (cached) return c.json(cached);

  const truncFn = granularity === 'day' ? 'day' : 'hour';

  const [mainResult, providerResult, clsResult] = await Promise.all([
    db.execute(sql.raw(`
      SELECT
        date_trunc('${truncFn}', created_at AT TIME ZONE 'America/Bogota')::text AS bucket,
        count(*)::int AS total,
        count(*) FILTER (WHERE status IN ('ok', 'filtered_out'))::int AS ok,
        count(*) FILTER (WHERE status = 'tcp_blocked')::int AS tcp_blocked,
        count(*) FILTER (WHERE status = 'soft_ban')::int AS soft_ban,
        count(*) FILTER (WHERE status = 'error')::int AS error,
        count(*) FILTER (WHERE status = 'session_expired')::int AS session_expired,
        ROUND(count(*) FILTER (WHERE status = 'tcp_blocked')::numeric / NULLIF(count(*), 0) * 100, 2) AS block_rate,
        ROUND(AVG(response_time_ms) FILTER (WHERE status IN ('ok', 'filtered_out')))::int AS avg_latency_ms
      FROM poll_logs
      WHERE created_at > NOW() - '${hours} hours'::interval
      GROUP BY bucket
      ORDER BY bucket
    `)),
    db.execute(sql.raw(`
      SELECT
        date_trunc('${truncFn}', created_at AT TIME ZONE 'America/Bogota')::text AS bucket,
        provider,
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'tcp_blocked')::int AS tcp_blocked,
        ROUND(count(*) FILTER (WHERE status = 'tcp_blocked')::numeric / NULLIF(count(*), 0) * 100, 2) AS block_rate
      FROM poll_logs
      WHERE created_at > NOW() - '${hours} hours'::interval AND provider IS NOT NULL
      GROUP BY bucket, provider
      ORDER BY bucket, provider
    `)),
    db.execute(sql.raw(`
      SELECT
        date_trunc('${truncFn}', created_at AT TIME ZONE 'America/Bogota')::text AS bucket,
        COALESCE(connection_info->>'blockClassification', 'null') AS classification,
        count(*)::int
      FROM poll_logs
      WHERE created_at > NOW() - '${hours} hours'::interval AND status = 'tcp_blocked'
      GROUP BY bucket, classification
      ORDER BY bucket
    `)),
  ]);

  const result = {
    timeseries: mainResult.rows.map(r => ({ ...r, block_rate: Number(r.block_rate) })),
    byProvider: providerResult.rows.map(r => ({ ...r, block_rate: Number(r.block_rate) })),
    byClassification: clsResult.rows,
    windowHours: hours,
    granularity,
  };
  setCached(cacheKey, result, 2 * 60_000);
  return c.json(result);
});

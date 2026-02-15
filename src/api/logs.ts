import { Hono } from 'hono';
import { db } from '../db/client.js';
import { pollLogs, rescheduleLogs, casPrefetchLogs, dispatchLogs } from '../db/schema.js';
import { eq, desc, and, gte, sql } from 'drizzle-orm';

export const logsRouter = new Hono();

// Poll summary (24h buckets + top 5)
logsRouter.get('/bots/:id/logs/polls/summary', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const hours = parseInt(c.req.query('hours') || '24');
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

  return c.json({ buckets, top5, totalPolls: rows.length, totalOkPolls, totalFilteredOutPolls, windowHours: hours });
});

// Poll logs
logsRouter.get('/bots/:id/logs/polls', async (c) => {
  const botId = parseInt(c.req.param('id'));
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

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
      createdAt: pollLogs.createdAt,
    })
    .from(pollLogs)
    .where(eq(pollLogs.botId, botId))
    .orderBy(desc(pollLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json(logs);
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


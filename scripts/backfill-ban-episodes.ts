/**
 * Backfill ban_episodes from poll_logs (tcp_blocked only).
 * Groups consecutive tcp_blocked per bot (gap >30min = new episode).
 * Finds recovery poll for each episode with a targeted query.
 */
import { db } from '../src/db/client.js';
import { pollLogs, banEpisodes, type BanPollDetail } from '../src/db/schema.js';
import { eq, and, gt, sql, ne } from 'drizzle-orm';
import { desc } from 'drizzle-orm';

const GAP_MS = 30 * 60 * 1000;

async function main() {
  const [existing] = await db.select({ count: sql<number>`count(*)` }).from(banEpisodes);
  if (existing && existing.count > 0) {
    console.log(`ban_episodes already has ${existing.count} rows. DELETE FROM ban_episodes to re-run.`);
    process.exit(0);
  }

  // Process per bot to avoid loading everything into memory
  const botIds = await db.execute<{ bot_id: string }>(sql`
    SELECT DISTINCT bot_id::text FROM poll_logs WHERE status = 'tcp_blocked' ORDER BY bot_id
  `);

  let totalEpisodes = 0;

  for (const row of botIds.rows) {
    const botId = parseInt(row.bot_id);
    console.log(`\nBot ${botId}...`);

    const blocks = await db.select({
      provider: pollLogs.provider,
      publicIp: pollLogs.publicIp,
      responseTimeMs: pollLogs.responseTimeMs,
      connectionInfo: pollLogs.connectionInfo,
      createdAt: pollLogs.createdAt,
    }).from(pollLogs)
      .where(and(eq(pollLogs.botId, botId), eq(pollLogs.status, 'tcp_blocked')))
      .orderBy(pollLogs.createdAt);

    console.log(`  ${blocks.length} tcp_blocked polls`);
    if (blocks.length === 0) continue;

    // Group into episodes
    type Ep = {
      startedAt: Date;
      lastBlockAt: Date;
      classification: string;
      pollCount: number;
      pollDetails: BanPollDetail[];
      triggerContext: object;
    };

    const episodes: Ep[] = [];
    let cur: Ep | null = null;

    for (const b of blocks) {
      const info = b.connectionInfo as any;
      const cls = info?.blockClassification ?? 'transient';
      const detail: BanPollDetail = {
        at: b.createdAt.toISOString(), cls,
        sub: info?.tcpSubcategory, provider: b.provider ?? undefined,
        ip: b.publicIp ?? undefined, ms: b.responseTimeMs ?? undefined,
        bytesRead: info?.socketBytesRead ?? undefined,
      };

      if (!cur || b.createdAt.getTime() - cur.lastBlockAt.getTime() > GAP_MS) {
        if (cur) episodes.push(cur);
        cur = {
          startedAt: b.createdAt, lastBlockAt: b.createdAt,
          classification: cls, pollCount: 1, pollDetails: [detail],
          triggerContext: {
            provider: b.provider, publicIp: b.publicIp,
            pollRateRecentPerMin: info?.pollRateRecentPerMin,
            sessionAgeMs: info?.sessionAgeMs,
          },
        };
      } else {
        cur.lastBlockAt = b.createdAt;
        cur.pollCount++;
        cur.pollDetails.push(detail);
        if (cls !== cur.classification && cur.classification !== 'mixed') cur.classification = 'mixed';
      }
    }
    if (cur) episodes.push(cur);

    console.log(`  ${episodes.length} episodes`);

    // Find recovery for each episode + insert
    const batch: Array<{
      botId: number; startedAt: Date; endedAt: Date | null; durationMin: number | null;
      classification: string; pollCount: number; pollDetails: BanPollDetail[];
      triggerContext: object; recoveryContext: object | null;
    }> = [];

    for (const ep of episodes) {
      // Find first non-tcp_blocked poll after lastBlockAt
      const [recovery] = await db.select({
        status: pollLogs.status, provider: pollLogs.provider,
        publicIp: pollLogs.publicIp, createdAt: pollLogs.createdAt,
      }).from(pollLogs)
        .where(and(
          eq(pollLogs.botId, botId),
          gt(pollLogs.createdAt, ep.lastBlockAt),
          ne(pollLogs.status, 'tcp_blocked'),
        ))
        .orderBy(pollLogs.createdAt)
        .limit(1);

      batch.push({
        botId,
        startedAt: ep.startedAt,
        endedAt: recovery?.createdAt ?? null,
        durationMin: recovery ? Math.round((recovery.createdAt.getTime() - ep.startedAt.getTime()) / 60000) : null,
        classification: ep.classification,
        pollCount: ep.pollCount,
        pollDetails: ep.pollDetails,
        triggerContext: ep.triggerContext,
        recoveryContext: recovery ? {
          provider: recovery.provider, publicIp: recovery.publicIp, recoveryStatus: recovery.status,
        } : null,
      });
    }

    // Insert in chunks
    const CHUNK = 50;
    for (let i = 0; i < batch.length; i += CHUNK) {
      await db.insert(banEpisodes).values(batch.slice(i, i + CHUNK));
    }
    totalEpisodes += batch.length;
    const resolved = batch.filter(e => e.endedAt).length;
    console.log(`  Inserted ${batch.length} (${resolved} resolved, ${batch.length - resolved} open)`);
  }

  console.log(`\n✅ Backfill complete: ${totalEpisodes} total episodes`);
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

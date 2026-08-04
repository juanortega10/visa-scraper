import { schedules, logger } from '@trigger.dev/sdk/v3';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/**
 * Log retention — scheduled cron (daily 03:00 Bogota / 08:00 UTC, PRODUCTION only).
 *
 * High-volume telemetry tables grow unbounded and drive Neon storage + compute.
 * `poll_logs` is ~99% of the DB. Nothing in the polling path reads rows older than
 * a few minutes (backoff/rate/prefetch only touch the last few rows — see poll-visa.ts),
 * and the dashboard windows are ≤10 days, so pruning is safe.
 *
 * Deletes in batches (BATCH rows/statement) to avoid long locks and WAL spikes on Neon.
 * The first run clears the historical backlog over several iterations; daily runs after
 * that only trim ~1 day of rows.
 *
 * Note: Postgres does not return freed pages to the OS without VACUUM FULL (which locks).
 * autovacuum marks the space reusable so the table stops growing; a one-time manual
 * `VACUUM (FULL) poll_logs` can reclaim disk after the first big cleanup if desired.
 */

// table → { column used for age, days to keep }
const RETENTION: { table: string; column: string; days: number }[] = [
  { table: 'poll_logs', column: 'created_at', days: 30 },
  { table: 'cas_prefetch_logs', column: 'created_at', days: 30 },
  { table: 'auth_logs', column: 'created_at', days: 90 },
  // Analytics tables — small but bounded so they don't creep up over time.
  { table: 'date_sightings', column: 'appeared_at', days: 180 },
  { table: 'bookable_events', column: 'detected_at', days: 180 },
];

const BATCH = 50_000;
const MAX_BATCHES = 400; // safety cap: up to 20M rows/table/run

export const pruneLogsSchedule = schedules.task({
  id: 'prune-logs',
  cron: {
    pattern: '0 8 * * *', // 08:00 UTC = 03:00 Bogota
    environments: ['PRODUCTION'],
  },
  machine: { preset: 'micro' },
  maxDuration: 600,

  run: async () => {
    const summary: Record<string, number> = {};
    for (const { table, column, days } of RETENTION) {
      let total = 0;
      for (let i = 0; i < MAX_BATCHES; i++) {
        // Delete a bounded slice by id to keep each statement cheap (indexed delete).
        const res = await db.execute(sql`
          DELETE FROM ${sql.raw(table)}
          WHERE id IN (
            SELECT id FROM ${sql.raw(table)}
            WHERE ${sql.raw(column)} < now() - ${sql.raw(`interval '${days} days'`)}
            LIMIT ${BATCH}
          )
        `);
        const n = res.rowCount ?? 0;
        total += n;
        if (n < BATCH) break;
        await new Promise((r) => setTimeout(r, 200)); // breathe between batches
      }
      summary[table] = total;
      logger.info('prune-logs', { table, deleted: total, keepDays: days });
    }
    logger.info('prune-logs DONE', { summary });
    return { summary };
  },
});

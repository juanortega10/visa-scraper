/**
 * Backfill poll_logs.ban_phase from ban_episodes.
 * - tcp_blocked polls during an episode: first = 'trigger', rest = 'sustained'
 * - First non-tcp_blocked poll after episode ends: 'recovery'
 */
import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

async function main() {
  // Check current state
  const before = await db.execute<{ tagged: string; total: string }>(sql`
    SELECT
      SUM(CASE WHEN ban_phase IS NOT NULL THEN 1 ELSE 0 END)::text as tagged,
      COUNT(*)::text as total
    FROM poll_logs
  `);
  console.log(`Before: ${before.rows[0]?.tagged ?? 0} tagged / ${before.rows[0]?.total ?? 0} total polls`);

  // Tag trigger polls: first tcp_blocked in each episode
  console.log('\nTagging trigger polls...');
  const triggerResult = await db.execute(sql`
    UPDATE poll_logs p
    SET ban_phase = 'trigger'
    FROM ban_episodes b
    WHERE p.bot_id = b.bot_id
      AND p.status = 'tcp_blocked'
      AND p.ban_phase IS NULL
      AND p.created_at >= b.started_at
      AND p.created_at <= b.started_at + INTERVAL '2 seconds'
  `);
  console.log(`  Trigger: ${triggerResult.rowCount} polls tagged`);

  // Tag sustained polls: tcp_blocked polls during episode (not trigger)
  console.log('Tagging sustained polls...');
  const sustainedResult = await db.execute(sql`
    UPDATE poll_logs p
    SET ban_phase = 'sustained'
    FROM ban_episodes b
    WHERE p.bot_id = b.bot_id
      AND p.status = 'tcp_blocked'
      AND p.ban_phase IS NULL
      AND p.created_at > b.started_at + INTERVAL '2 seconds'
      AND (b.ended_at IS NULL OR p.created_at <= b.ended_at)
  `);
  console.log(`  Sustained: ${sustainedResult.rowCount} polls tagged`);

  // Tag recovery polls: first non-tcp_blocked poll that matches episode endedAt
  console.log('Tagging recovery polls...');
  const recoveryResult = await db.execute(sql`
    UPDATE poll_logs p
    SET ban_phase = 'recovery'
    FROM ban_episodes b
    WHERE p.bot_id = b.bot_id
      AND p.status != 'tcp_blocked'
      AND p.ban_phase IS NULL
      AND b.ended_at IS NOT NULL
      AND p.created_at >= b.ended_at
      AND p.created_at <= b.ended_at + INTERVAL '2 seconds'
  `);
  console.log(`  Recovery: ${recoveryResult.rowCount} polls tagged`);

  // Summary
  const after = await db.execute<{ phase: string; count: string }>(sql`
    SELECT COALESCE(ban_phase, 'normal') as phase, COUNT(*)::text as count
    FROM poll_logs GROUP BY 1 ORDER BY count DESC
  `);
  console.log('\nFinal distribution:');
  for (const row of after.rows) {
    console.log(`  ${row.phase}: ${row.count}`);
  }

  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

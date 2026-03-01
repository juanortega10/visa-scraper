/**
 * Query DB for Bot 7's best historical dates across ALL polls.
 * Usage: npx tsx --env-file=.env scripts/bot7-best-dates.ts
 */
import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

async function main() {
  // Overall stats
  const stats = await db.execute(sql`
    SELECT
      COUNT(*) as total_polls,
      COUNT(*) FILTER (WHERE top_dates->>0 IS NOT NULL) as polls_with_dates,
      MIN(top_dates->>0) as best_earliest_ever,
      MIN(created_at) as first_poll,
      MAX(created_at) as last_poll
    FROM poll_logs WHERE bot_id = 7
  `);
  const s = stats.rows[0] as any;
  console.log('=== Bot 7 All-time Stats ===');
  console.log(`Total polls: ${s.total_polls}`);
  console.log(`Polls with dates: ${s.polls_with_dates}`);
  console.log(`Best earliest ever: ${s.best_earliest_ever}`);
  console.log(`Period: ${new Date(s.first_poll).toLocaleDateString('en-US', { timeZone: 'America/Bogota' })} → ${new Date(s.last_poll).toLocaleDateString('en-US', { timeZone: 'America/Bogota' })}`);

  // Top 15 closest dates
  const best = await db.execute(sql`
    SELECT top_dates->>0 as earliest, raw_dates_count, created_at, provider, public_ip
    FROM poll_logs
    WHERE bot_id = 7 AND top_dates->>0 IS NOT NULL
    ORDER BY top_dates->>0 ASC
    LIMIT 15
  `);
  console.log('\n=== Top 15 Closest Dates Ever Seen ===');
  for (const r of best.rows as any[]) {
    const ts = new Date(r.created_at).toLocaleString('en-US', { timeZone: 'America/Bogota', hour12: false, month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    console.log(`  ${r.earliest}  |  ${r.raw_dates_count} raw  |  ${ts}  |  ${r.provider}  |  ${r.public_ip || ''}`);
  }

  // Dates before target (2026-05-01)
  const beforeTarget = await db.execute(sql`
    SELECT top_dates->>0 as earliest, raw_dates_count, created_at
    FROM poll_logs
    WHERE bot_id = 7 AND top_dates->>0 < '2026-05-01'
    ORDER BY top_dates->>0 ASC
    LIMIT 10
  `);
  console.log(`\n=== Dates Before Target (2026-05-01) ===`);
  if (beforeTarget.rows.length === 0) {
    console.log('  NONE — Bot 7 has NEVER seen a date before May 2026');
  } else {
    for (const r of beforeTarget.rows as any[]) {
      const ts = new Date(r.created_at).toLocaleString('en-US', { timeZone: 'America/Bogota', hour12: false });
      console.log(`  ${r.earliest}  |  ${ts}`);
    }
  }

  // Distribution by month
  const monthly = await db.execute(sql`
    SELECT
      to_char(top_dates->>0::date, 'YYYY-MM') as month,
      COUNT(*) as times_seen,
      MIN(created_at) as first_seen
    FROM poll_logs
    WHERE bot_id = 7 AND top_dates->>0 IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `);
  console.log('\n=== Earliest Date by Month (how often seen as top) ===');
  for (const r of monthly.rows as any[]) {
    console.log(`  ${r.month}  |  seen ${String(r.times_seen).padStart(4)} times  |  first: ${new Date(r.first_seen).toLocaleDateString('en-US', { timeZone: 'America/Bogota' })}`);
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });

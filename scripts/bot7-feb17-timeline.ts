/**
 * Timeline of Bot 7 polls around Feb 17 to understand the visibility shift.
 * Usage: npx tsx --env-file=.env scripts/bot7-feb17-timeline.ts
 */
import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

async function main() {
  // Check what Bot 7's current_consular_date was over time via poll logs
  // The earliest date seen should tell us about the visibility window

  // Daily summary: earliest date seen per day
  const daily = await db.execute(sql`
    SELECT
      DATE(created_at AT TIME ZONE 'America/Bogota') as day,
      MIN(top_dates->>0) as best_earliest,
      COUNT(*) as polls,
      COUNT(*) FILTER (WHERE top_dates->>0 IS NOT NULL) as with_dates,
      MIN(raw_dates_count) FILTER (WHERE top_dates->>0 IS NOT NULL) as min_raw,
      MAX(raw_dates_count) FILTER (WHERE top_dates->>0 IS NOT NULL) as max_raw
    FROM poll_logs
    WHERE bot_id = 7
    GROUP BY 1
    ORDER BY 1
  `);

  console.log('=== Bot 7: Daily Best Earliest Date ===');
  console.log('Day         | Best earliest  | Polls | w/dates | Raw range');
  console.log('------------|----------------|-------|---------|----------');
  for (const r of daily.rows as any[]) {
    const day = new Date(r.day).toISOString().split('T')[0];
    console.log(`${day}  | ${r.best_earliest || '(none)'.padEnd(14)} | ${String(r.polls).padStart(5)} | ${String(r.with_dates).padStart(7)} | ${r.min_raw ?? '-'}-${r.max_raw ?? '-'}`);
  }

  // Zoom into Feb 17: hourly breakdown
  console.log('\n=== Feb 17 Hourly (Bogota) ===');
  const feb17 = await db.execute(sql`
    SELECT
      EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Bogota') as hour,
      MIN(top_dates->>0) as best_earliest,
      COUNT(*) as polls,
      COUNT(*) FILTER (WHERE top_dates->>0 IS NOT NULL) as with_dates
    FROM poll_logs
    WHERE bot_id = 7
      AND created_at >= '2026-02-17T05:00:00Z'
      AND created_at < '2026-02-18T05:00:00Z'
    GROUP BY 1
    ORDER BY 1
  `);
  for (const r of feb17.rows as any[]) {
    console.log(`  ${String(r.hour).padStart(2)}:00  | ${r.best_earliest || '(none)'}  | ${r.polls} polls (${r.with_dates} w/dates)`);
  }

  // The key poll where 2026-02-24 was seen
  console.log('\n=== Poll where 2026-02-24 was seen ===');
  const keyPoll = await db.execute(sql`
    SELECT id, top_dates, raw_dates_count, created_at, provider, public_ip, status
    FROM poll_logs
    WHERE bot_id = 7 AND top_dates->>0 = '2026-02-24'
  `);
  for (const r of keyPoll.rows as any[]) {
    const ts = new Date(r.created_at).toLocaleString('en-US', { timeZone: 'America/Bogota', hour12: false });
    console.log(`  Poll #${r.id}: ${ts} | ${r.raw_dates_count} raw | ${r.provider} | ${r.public_ip}`);
    console.log(`  topDates: ${JSON.stringify(r.top_dates)}`);
  }

  // Transition: last poll before the shift and first poll after
  console.log('\n=== Transition point: when did earliest jump from close to far? ===');
  const transition = await db.execute(sql`
    WITH ranked AS (
      SELECT
        id, top_dates->>0 as earliest, raw_dates_count, created_at,
        LAG(top_dates->>0) OVER (ORDER BY created_at) as prev_earliest
      FROM poll_logs
      WHERE bot_id = 7 AND top_dates->>0 IS NOT NULL
    )
    SELECT * FROM ranked
    WHERE earliest > '2026-06-01' AND prev_earliest < '2026-06-01'
    ORDER BY created_at
    LIMIT 5
  `);
  for (const r of transition.rows as any[]) {
    const ts = new Date(r.created_at).toLocaleString('en-US', { timeZone: 'America/Bogota', hour12: false });
    console.log(`  Poll #${r.id}: ${ts} | prev=${r.prev_earliest} → curr=${r.earliest}`);
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });

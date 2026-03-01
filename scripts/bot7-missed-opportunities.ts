/**
 * Investigate why Bot 7 didn't act on flash dates (2026-02-24, etc.)
 * and check if any dates within target window appeared in the last week.
 *
 * Usage: npx tsx --env-file=.env scripts/bot7-missed-opportunities.ts
 */
import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

async function main() {
  // 1. The key polls where close dates appeared — full detail
  console.log('=== Polls where Bot 7 saw dates before 2026-05-01 ===\n');
  const closeDates = await db.execute(sql`
    SELECT id, top_dates, raw_dates_count, earliest_date, dates_count,
           created_at, status, error, poll_phase, reschedule_result,
           provider, public_ip, relogin_happened, chain_id
    FROM poll_logs
    WHERE bot_id = 7 AND (top_dates->>0) < '2026-05-01'
    ORDER BY created_at
  `);

  for (const r of closeDates.rows as any[]) {
    const ts = new Date(r.created_at).toLocaleString('en-US', { timeZone: 'America/Bogota', hour12: false });
    console.log(`Poll #${r.id} — ${ts}`);
    console.log(`  topDates: ${JSON.stringify(r.top_dates)}`);
    console.log(`  rawDatesCount: ${r.raw_dates_count}, earliestDate: ${r.earliest_date}, datesCount: ${r.dates_count}`);
    console.log(`  status: ${r.status}, rescheduleResult: ${r.reschedule_result}`);
    console.log(`  pollPhase: ${r.poll_phase}, chainId: ${r.chain_id}`);
    console.log(`  provider: ${r.provider}, ip: ${r.public_ip}`);
    console.log(`  error: ${r.error || '(none)'}`);
    console.log(`  relogin: ${r.relogin_happened}`);
    console.log('');
  }

  // 2. What was Bot 7's config around Feb 17?
  // Check polls around that time for context
  console.log('=== Bot 7 poll context around Feb 17 17:10 (when 2026-02-24 seen) ===\n');
  const context = await db.execute(sql`
    SELECT id, top_dates->>0 as earliest, raw_dates_count, earliest_date, dates_count,
           status, reschedule_result, error, created_at, poll_phase
    FROM poll_logs
    WHERE bot_id = 7
      AND created_at BETWEEN '2026-02-17T22:05:00Z' AND '2026-02-17T22:20:00Z'
    ORDER BY created_at
  `);
  for (const r of context.rows as any[]) {
    const ts = new Date(r.created_at).toLocaleString('en-US', { timeZone: 'America/Bogota', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    console.log(`  ${ts} | #${r.id} | earliest=${r.earliest} | earliestDate=${r.earliest_date} | datesCount=${r.dates_count} | status=${r.status} | reschedule=${r.reschedule_result || '-'} | phase=${r.poll_phase}`);
  }

  // 3. Check Bot 7 current config from bots table
  console.log('\n=== Bot 7 current config ===');
  const bot = await db.execute(sql`
    SELECT id, current_consular_date, current_consular_time, target_date_before,
           max_reschedules, reschedule_count, status, is_scout, is_subscriber,
           proxy_provider, locale, schedule_id
    FROM bots WHERE id = 7
  `);
  const b = bot.rows[0] as any;
  console.log(`  scheduleId: ${b.schedule_id}`);
  console.log(`  currentConsularDate: ${b.current_consular_date} ${b.current_consular_time}`);
  console.log(`  targetDateBefore: ${b.target_date_before}`);
  console.log(`  maxReschedules: ${b.max_reschedules}, rescheduleCount: ${b.reschedule_count}`);
  console.log(`  status: ${b.status}, isScout: ${b.is_scout}, isSubscriber: ${b.is_subscriber}`);
  console.log(`  proxyProvider: ${b.proxy_provider}, locale: ${b.locale}`);

  // 4. Last 7 days: ALL polls where topDates[0] < targetDateBefore (2026-05-01)
  console.log('\n=== Last 7 days: dates within target window (<2026-05-01) ===\n');
  const lastWeek = await db.execute(sql`
    SELECT id, top_dates->>0 as earliest, top_dates, raw_dates_count,
           earliest_date, dates_count, status, reschedule_result, error,
           created_at, provider, public_ip, poll_phase
    FROM poll_logs
    WHERE bot_id = 7
      AND created_at >= NOW() - INTERVAL '7 days'
      AND (top_dates->>0) < '2026-05-01'
    ORDER BY top_dates->>0
  `);

  if (lastWeek.rows.length === 0) {
    console.log('  NONE — no dates before 2026-05-01 seen in the last 7 days');
  } else {
    console.log(`  Found ${lastWeek.rows.length} polls with dates before target:\n`);
    for (const r of lastWeek.rows as any[]) {
      const ts = new Date(r.created_at).toLocaleString('en-US', { timeZone: 'America/Bogota', hour12: false });
      console.log(`  ${r.earliest} | ${ts} | status=${r.status} | reschedule=${r.reschedule_result || '-'} | ${r.provider} | phase=${r.poll_phase}`);
    }
  }

  // 5. Last 7 days: dates before 2026-07-01 (broader window)
  console.log('\n=== Last 7 days: dates before 2026-07-01 (broader) ===\n');
  const broader = await db.execute(sql`
    SELECT (top_dates->>0) as earliest, COUNT(*) as times,
           MIN(created_at) as first_seen, MAX(created_at) as last_seen
    FROM poll_logs
    WHERE bot_id = 7
      AND created_at >= NOW() - INTERVAL '7 days'
      AND (top_dates->>0) < '2026-07-01'
    GROUP BY 1
    ORDER BY 1
  `);

  if (broader.rows.length === 0) {
    console.log('  NONE — no dates before July 2026 seen in the last 7 days');
  } else {
    for (const r of broader.rows as any[]) {
      const first = new Date(r.first_seen).toLocaleString('en-US', { timeZone: 'America/Bogota', hour12: false, month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const last = new Date(r.last_seen).toLocaleString('en-US', { timeZone: 'America/Bogota', hour12: false, month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      console.log(`  ${r.earliest} | seen ${r.times}x | first: ${first} | last: ${last}`);
    }
  }

  // 6. Excluded dates for Bot 7
  console.log('\n=== Excluded dates for Bot 7 ===');
  const excl = await db.execute(sql`
    SELECT start_date, end_date, reason FROM excluded_dates WHERE bot_id = 7
  `);
  if (excl.rows.length === 0) {
    console.log('  (none)');
  } else {
    for (const r of excl.rows as any[]) {
      console.log(`  ${r.start_date} → ${r.end_date} | ${r.reason || ''}`);
    }
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });

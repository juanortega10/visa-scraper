import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';

const db = drizzle(neon(process.env.DATABASE_URL!));

const result = await db.execute(sql`
  SELECT id, created_at, success, old_consular_date, new_consular_date, new_consular_time,
         error, fail_step, fail_reason, provider, session_age_ms, duration_ms, run_id, detail
  FROM reschedule_logs
  WHERE bot_id = 7
  ORDER BY created_at DESC
  LIMIT 20
`);

console.log('Reschedule logs bot 7 (all time):\n');
for (const r of result.rows as any[]) {
  console.log(`[${r.id}] ${r.created_at} | success=${r.success}`);
  console.log(`  ${r.old_consular_date} → ${r.new_consular_date} @ ${r.new_consular_time}`);
  console.log(`  error="${r.error}" | failStep=${r.fail_step} | failReason=${r.fail_reason}`);
  console.log(`  provider=${r.provider} | sessionAge=${r.session_age_ms}ms | dur=${r.duration_ms}ms`);
  console.log(`  runId=${r.run_id}`);
  console.log();
}
process.exit(0);

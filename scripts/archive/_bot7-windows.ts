import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';

const db = drizzle(neon(process.env.DATABASE_URL!));

// Fetch all status=ok polls for bot 7 (bookable dates)
const result = await db.execute(sql`
  SELECT created_at, earliest_date, top_dates
  FROM poll_logs
  WHERE bot_id = 7 AND status = 'ok'
  ORDER BY created_at ASC
`);

const rows = result.rows as { created_at: string; earliest_date: string | null; top_dates: string[] | null }[];
console.log(`Total bookable polls (status=ok): ${rows.length}\n`);

const DAYS = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
const byDow: Record<string, number> = {};
const byHour: Record<number, number> = {};
const byDowHour: Record<string, number> = {};

for (const row of rows) {
  const dt = new Date(row.created_at);
  // UTC-5 Bogota
  const bog = new Date(dt.getTime() - 5 * 60 * 60 * 1000);
  const dow = bog.getUTCDay();
  const hour = bog.getUTCHours();
  const dowName = DAYS[dow]!;
  const key = `${dowName} ${String(hour).padStart(2,'0')}h`;
  byDow[dowName] = (byDow[dowName] ?? 0) + 1;
  byHour[hour] = (byHour[hour] ?? 0) + 1;
  byDowHour[key] = (byDowHour[key] ?? 0) + 1;
}

console.log('=== Por día de la semana ===');
for (const d of DAYS) {
  const n = byDow[d] ?? 0;
  if (n) console.log(`  ${d}: ${n}`);
}

console.log('\n=== Por hora Bogota (UTC-5) ===');
for (let h = 0; h < 24; h++) {
  const n = byHour[h] ?? 0;
  if (n) console.log(`  ${String(h).padStart(2,'0')}:00 → ${n}`);
}

console.log('\n=== Top combinaciones día+hora (descendente) ===');
const sorted = Object.entries(byDowHour).sort((a, b) => b[1] - a[1]);
for (const [k, v] of sorted) {
  console.log(`  ${k}: ${v}`);
}

process.exit(0);

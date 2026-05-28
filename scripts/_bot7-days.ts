import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { pollLogs } from '../src/db/schema.js';
import { eq, and } from 'drizzle-orm';

const db = drizzle(neon(process.env.DATABASE_URL!));

const rows = await db.select({
  createdAt: pollLogs.createdAt,
  topDates: pollLogs.topDates,
  responseTimeMs: pollLogs.responseTimeMs,
}).from(pollLogs)
  .where(and(eq(pollLogs.botId, 7), eq(pollLogs.status, 'ok')))
  .orderBy(pollLogs.createdAt);

const LIMA_OFFSET = -5;
const days = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
const dayCounts: Record<string, number> = {};
const hourCounts: Record<number, number> = {};

console.log(`\nTotal sightings bookables bot 7: ${rows.length}\n`);
console.log('Día  | Lima             | UTC               | Fecha vista    | ms');
console.log('-----|------------------|-------------------|----------------|------');

for (const r of rows) {
  const utc = new Date(r.createdAt);
  const lima = new Date(utc.getTime() + LIMA_OFFSET * 3600000);
  const dayName = days[lima.getUTCDay()];
  const limaHour = lima.getUTCHours();
  dayCounts[dayName] = (dayCounts[dayName] ?? 0) + 1;
  hourCounts[limaHour] = (hourCounts[limaHour] ?? 0) + 1;
  const limaStr = lima.toISOString().replace('T',' ').slice(0,16);
  const utcStr  = utc.toISOString().replace('T',' ').slice(0,16);
  const topDate = ((r.topDates as string[])?.[0] ?? 'N/A').padEnd(14);
  console.log(`${dayName.padEnd(5)}| ${limaStr} | ${utcStr} | ${topDate} | ${r.responseTimeMs}`);
}

console.log('\n── Por día ──');
for (const d of ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom']) {
  if (dayCounts[d]) console.log(`${d}: ${'█'.repeat(dayCounts[d])} (${dayCounts[d]})`);
}

console.log('\n── Por hora Lima ──');
for (let h = 0; h < 24; h++) {
  if (hourCounts[h]) console.log(`${String(h).padStart(2,'0')}h: ${'█'.repeat(hourCounts[h])} (${hourCounts[h]})`);
}

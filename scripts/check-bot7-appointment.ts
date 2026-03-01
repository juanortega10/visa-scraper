import { db } from '../src/db/client.js';
import { pollLogs, bots } from '../src/db/schema.js';
import { eq, desc, and, lt, isNotNull } from 'drizzle-orm';

const [bot] = await db.select().from(bots).where(eq(bots.id, 7));
console.log(`Bot 7: current=${bot.currentConsularDate} ${bot.currentConsularTime}, target<${bot.targetDateBefore}, maxReschedules=${bot.maxReschedules}, count=${bot.rescheduleCount}`);

// Find all polls where earliestDate was better than current
const goodPolls = await db.select({
  createdAt: pollLogs.createdAt,
  status: pollLogs.status,
  earliestDate: pollLogs.earliestDate,
  datesCount: pollLogs.datesCount,
  rescheduleResult: pollLogs.rescheduleResult,
  error: pollLogs.error,
  responseTimeMs: pollLogs.responseTimeMs,
  topDates: pollLogs.topDates,
}).from(pollLogs)
  .where(and(
    eq(pollLogs.botId, 7),
    isNotNull(pollLogs.earliestDate),
    lt(pollLogs.earliestDate, '2026-07-30')
  ))
  .orderBy(desc(pollLogs.createdAt))
  .limit(20);

console.log(`\nPolls with dates better than current (${goodPolls.length}):`);
for (const p of goodPolls) {
  const t = new Date(p.createdAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  console.log(`  ${t} | ${p.status} | earliest=${p.earliestDate} | dates=${p.datesCount} | reschedule=${p.rescheduleResult || 'none'} | ${p.responseTimeMs}ms | error=${(p.error || 'none').substring(0, 100)}`);
  if (p.topDates) {
    const top = (p.topDates as any[]).slice(0, 5);
    console.log(`    topDates: ${top.map((d: any) => d.date).join(', ')}`);
  }
}

// When was 3 mar 2026 seen?
const marPolls = await db.select({
  createdAt: pollLogs.createdAt,
  status: pollLogs.status,
  earliestDate: pollLogs.earliestDate,
  datesCount: pollLogs.datesCount,
  rescheduleResult: pollLogs.rescheduleResult,
  error: pollLogs.error,
}).from(pollLogs)
  .where(and(
    eq(pollLogs.botId, 7),
    isNotNull(pollLogs.earliestDate),
    lt(pollLogs.earliestDate, '2026-04-01')
  ))
  .orderBy(desc(pollLogs.createdAt))
  .limit(10);

console.log(`\nPolls with dates < April 2026 (${marPolls.length}):`);
for (const p of marPolls) {
  const t = new Date(p.createdAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  console.log(`  ${t} | ${p.status} | earliest=${p.earliestDate} | dates=${p.datesCount} | reschedule=${p.rescheduleResult || 'none'} | error=${(p.error || 'none').substring(0, 100)}`);
}

process.exit(0);

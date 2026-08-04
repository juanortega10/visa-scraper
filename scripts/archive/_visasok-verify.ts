import { db } from '../src/db/client.js';
import { bots, pollLogs, rescheduleLogs } from '../src/db/schema.js';
import { inArray, desc, eq, gte, and } from 'drizzle-orm';

const ids = [179, 180];
const since = new Date(Date.now() - 30 * 60_000);
for (const id of ids) {
  const [b] = await db.select().from(bots).where(eq(bots.id, id));
  const polls = await db.select().from(pollLogs)
    .where(and(eq(pollLogs.botId, id), gte(pollLogs.createdAt, since)))
    .orderBy(desc(pollLogs.createdAt)).limit(4);
  const rs = await db.select().from(rescheduleLogs)
    .where(and(eq(rescheduleLogs.botId, id), gte(rescheduleLogs.createdAt, since)))
    .orderBy(desc(rescheduleLogs.createdAt)).limit(3);
  console.log(`\n=== Bot ${id} === status=${b!.status} provider=${b!.proxyProvider} current=${b!.currentConsularDate} ${b!.currentConsularTime} activeRunId=${b!.activeRunId}`);
  console.log(`  polls (last ${polls.length}):`);
  for (const p of polls) {
    console.log(`    ${p.createdAt?.toISOString()} status=${p.status} earliest=${p.earliestDate} datesCount=${p.datesCount} rescheduleResult=${p.rescheduleResult ?? '-'}`);
  }
  console.log(`  reschedules since: ${rs.length}`);
  for (const r of rs) console.log(`    ${r.createdAt?.toISOString()} ${r.success ? 'OK' : 'FAIL'} ${r.oldConsularDate}→${r.newConsularDate} ${r.error ?? ''}`);
}
process.exit(0);

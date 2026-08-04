import { db } from '../src/db/client.js';
import { pollLogs } from '../src/db/schema.js';
import { eq, desc, gte, and, sql } from 'drizzle-orm';

async function main() {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const counts = await db.select({ status: pollLogs.status, n: sql<number>`count(*)::int` })
    .from(pollLogs)
    .where(and(eq(pollLogs.botId, 222), gte(pollLogs.createdAt, since)))
    .groupBy(pollLogs.status);
  console.log('Last 24h status counts:', counts);

  // Last successful (ok/filtered) poll
  const [lastOk] = await db.select({ createdAt: pollLogs.createdAt, status: pollLogs.status, earliestDate: pollLogs.earliestDate })
    .from(pollLogs)
    .where(and(eq(pollLogs.botId, 222), sql`${pollLogs.status} IN ('ok','filtered_out')`))
    .orderBy(desc(pollLogs.createdAt)).limit(1);
  console.log('Last OK/filtered poll:', lastOk ? `${new Date(lastOk.createdAt).toLocaleString('en-US',{timeZone:'America/Bogota'})} (${lastOk.status}, earliest=${lastOk.earliestDate})` : 'NONE in table');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

import { db } from '../src/db/client.js';
import { bots, pollLogs, rescheduleLogs } from '../src/db/schema.js';
import { eq, desc, gte, and, inArray } from 'drizzle-orm';
const IDS = [182, 183, 184, 185];
const since = new Date(Date.now() - 15 * 60_000);
for (const id of IDS) {
  const [b] = await db.select().from(bots).where(eq(bots.id, id));
  const [last] = await db.select().from(pollLogs).where(eq(pollLogs.botId, id)).orderBy(desc(pollLogs.createdAt)).limit(1);
  const rs = await db.select({ id: rescheduleLogs.id }).from(rescheduleLogs).where(and(eq(rescheduleLogs.botId, id), gte(rescheduleLogs.createdAt, since)));
  const ageS = last?.createdAt ? Math.round((Date.now() - last.createdAt.getTime()) / 1000) : null;
  console.log(`bot ${id}: status=${b!.status} current=${b!.currentConsularDate} ${b!.currentConsularTime} | lastPoll=${last ? `${last.status} earliest=${last.earliestDate} count=${last.datesCount} (${ageS}s)` : 'none'} | reschedules=${rs.length}`);
}
process.exit(0);

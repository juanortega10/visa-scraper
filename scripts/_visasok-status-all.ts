import { db } from '../src/db/client.js';
import { bots, excludedDates, pollLogs } from '../src/db/schema.js';
import { inArray, eq, desc } from 'drizzle-orm';
const ids = [173, 179, 180];
for (const id of ids) {
  const [b] = await db.select().from(bots).where(eq(bots.id, id));
  const ex = await db.select().from(excludedDates).where(eq(excludedDates.botId, id));
  const [last] = await db.select().from(pollLogs).where(eq(pollLogs.botId, id)).orderBy(desc(pollLogs.createdAt)).limit(1);
  const ageS = last?.createdAt ? Math.round((Date.now() - last.createdAt.getTime()) / 1000) : null;
  console.log(JSON.stringify({
    id, status: b!.status, provider: b!.proxyProvider, skipCas: b!.skipCas,
    current: `${b!.currentConsularDate} ${b!.currentConsularTime}`, cas: b!.currentCasDate,
    excluded: ex.map(e => `${e.startDate}->${e.endDate}`),
    lastPoll: last ? `${last.status} earliest=${last.earliestDate} count=${last.datesCount} (${ageS}s ago)` : 'none',
  }));
}
process.exit(0);

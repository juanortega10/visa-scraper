import { db } from '../src/db/client.js';
import { bots, pollLogs } from '../src/db/schema.js';
import { inArray, eq, desc } from 'drizzle-orm';
const IDS = [173, 179, 180, 182, 183, 184, 185, 6];
const all = await db.select().from(bots).where(inArray(bots.id, IDS));
for (const b of all.sort((a,z)=>a.id-z.id)) {
  const [last] = await db.select().from(pollLogs).where(eq(pollLogs.botId, b.id)).orderBy(desc(pollLogs.createdAt)).limit(1);
  const ageS = last?.createdAt ? Math.round((Date.now() - last.createdAt.getTime()) / 1000) : null;
  console.log(`bot ${b.id}: status=${b.status} current=${b.currentConsularDate} ${b.currentConsularTime ?? ''} | lastPoll=${last ? `${last.status} earliest=${last.earliestDate} (${ageS}s ago)` : 'NONE'}`);
}
process.exit(0);

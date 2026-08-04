import { db } from '../src/db/client.js';
import { bots, excludedDates } from '../src/db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';
const IDS = [182, 183, 184, 185];
const START = '2026-05-28', END = '2026-06-06'; // 1ra aceptable = 2026-06-07
for (const id of IDS) {
  const ex = await db.select().from(excludedDates).where(and(eq(excludedDates.botId, id), eq(excludedDates.startDate, START), eq(excludedDates.endDate, END)));
  if (ex.length === 0) await db.insert(excludedDates).values({ botId: id, startDate: START, endDate: END });
}
const all = await db.select({ id: bots.id, status: bots.status, provider: bots.proxyProvider, current: bots.currentConsularDate }).from(bots).where(inArray(bots.id, IDS));
for (const b of all) {
  const ex = await db.select().from(excludedDates).where(eq(excludedDates.botId, b.id));
  console.log(`bot ${b.id}: status=${b.status} provider=${b.provider} current=${b.current} excluded=[${ex.map(e=>e.startDate+'->'+e.endDate).join(', ')}]`);
}
process.exit(0);

import { db } from '../src/db/client.js';
import { bots, excludedDates } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

// provider->direct, skipCas->true (no CAS account), targetDateBefore stays null (no upper bound)
await db.update(bots).set({ proxyProvider: 'direct', skipCas: true, targetDateBefore: null, updatedAt: new Date() }).where(eq(bots.id, 173));

// Extend the existing exclusion start back to today; keep end 2026-06-16 (first acceptable = Jun 17)
const ex = await db.select().from(excludedDates).where(eq(excludedDates.botId, 173));
const row = ex.find(e => e.endDate === '2026-06-16');
if (row) {
  await db.update(excludedDates).set({ startDate: '2026-05-28' }).where(eq(excludedDates.id, row.id));
} else {
  await db.insert(excludedDates).values({ botId: 173, startDate: '2026-05-28', endDate: '2026-06-16' });
}

const [b] = await db.select().from(bots).where(eq(bots.id, 173));
const ex2 = await db.select().from(excludedDates).where(eq(excludedDates.botId, 173));
console.log(`bot 173: provider=${b.proxyProvider} skipCas=${b.skipCas} targetDateBefore=${b.targetDateBefore} current=${b.currentConsularDate} ${b.currentConsularTime}`);
console.log(`excluded: [${ex2.map(e => e.startDate + '->' + e.endDate).join(', ')}]  (first acceptable = day after end)`);
process.exit(0);

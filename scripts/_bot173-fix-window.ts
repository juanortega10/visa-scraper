import { db } from '../src/db/client.js';
import { excludedDates } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
const ex = await db.select().from(excludedDates).where(eq(excludedDates.botId, 173));
const row = ex.find(e => e.startDate === '2026-05-28');
if (!row) { console.error('expected exclusion row not found:', JSON.stringify(ex)); process.exit(1); }
await db.update(excludedDates).set({ endDate: '2026-06-19' }).where(eq(excludedDates.id, row.id));
const ex2 = await db.select().from(excludedDates).where(eq(excludedDates.botId, 173));
console.log(`bot 173 excluded: [${ex2.map(e => e.startDate + '->' + e.endDate).join(', ')}]  (1ra aceptable = 2026-06-20)`);
process.exit(0);

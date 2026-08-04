import { db } from '../src/db/client.js';
import { bots, rescheduleLogs, bookableEvents } from '../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';

const [bot] = await db.select().from(bots).where(eq(bots.id, 144));
console.log('=== BOT 144 state ===');
console.log(`  current consular: ${bot?.currentConsularDate} ${bot?.currentConsularTime}`);
console.log(`  current cas:      ${bot?.currentCasDate} ${bot?.currentCasTime}`);
console.log(`  rescheduleCount:  ${bot?.rescheduleCount}`);
console.log(`  maxReschedules:   ${bot?.maxReschedules}`);
console.log(`  targetDateBefore: ${bot?.targetDateBefore}`);
console.log(`  status:           ${bot?.status}`);
console.log(`  updatedAt:        ${bot?.updatedAt?.toISOString()}`);

console.log('\n=== Last 15 reschedule_logs ===');
const logs = await db.select().from(rescheduleLogs).where(eq(rescheduleLogs.botId, 144))
  .orderBy(desc(rescheduleLogs.createdAt)).limit(15);
for (const l of logs) {
  const old = `${l.oldConsularDate ?? 'null'} ${l.oldConsularTime ?? ''}`.trim();
  const next = `${l.newConsularDate ?? 'null'} ${l.newConsularTime ?? ''}`.trim();
  console.log(`  #${l.id} ${l.createdAt.toISOString()} success=${l.success} ${old} -> ${next} err=${l.error ?? '-'}`);
}

console.log('\n=== Last 15 bookable_events ===');
const ev = await db.select().from(bookableEvents).where(eq(bookableEvents.botId, 144))
  .orderBy(desc(bookableEvents.createdAt)).limit(15);
for (const e of ev) {
  console.log(`  #${e.id} ${e.createdAt.toISOString()} date=${e.date} outcome=${e.outcome} consularAtDetection=${e.consularDateAtDetection} daysImprovement=${e.daysImprovement}`);
}

process.exit(0);

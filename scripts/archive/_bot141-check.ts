import { db } from '../src/db/client.js';
import { bots, sessions, excludedDates, excludedTimes, rescheduleLogs } from '../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';

const [bot] = await db.select().from(bots).where(eq(bots.id, 141));
if (!bot) { console.error('Bot 141 not found'); process.exit(1); }

const [session] = await db.select().from(sessions).where(eq(sessions.botId, 141));
const exDates = await db.select().from(excludedDates).where(eq(excludedDates.botId, 141));
const exTimes = await db.select().from(excludedTimes).where(eq(excludedTimes.botId, 141));
const recentRs = await db.select().from(rescheduleLogs).where(eq(rescheduleLogs.botId, 141)).orderBy(desc(rescheduleLogs.createdAt)).limit(5);

console.log('Bot 141 facility config:');
console.log(`  scheduleId:          ${bot.scheduleId}`);
console.log(`  applicantIds:        ${bot.applicantIds}`);
console.log(`  consularFacilityId:  ${bot.consularFacilityId}`);
console.log(`  ascFacilityId:       ${bot.ascFacilityId}`);
console.log(`  userId:              ${bot.userId}`);
console.log(`  locale:              ${bot.locale}`);
console.log(`  minDaysFromToday:    ${bot.minDaysFromToday}`);
console.log(`  proxyProvider:       ${bot.proxyProvider}`);
console.log(`  rescheduleCount:     ${bot.rescheduleCount} / max ${bot.maxReschedules}`);
console.log(`\nSession: ${session ? `present, updatedAt=${session.updatedAt?.toISOString()}` : 'MISSING — need npm run login -- --bot-id=141'}`);
console.log(`Excluded dates: ${exDates.length}`);
exDates.forEach(e => console.log(`  ${e.startDate} → ${e.endDate}`));
console.log(`Excluded times: ${exTimes.length}`);
exTimes.forEach(e => console.log(`  ${e.date} ${e.timeStart}-${e.timeEnd}`));
console.log(`\nLast 5 reschedule_logs:`);
recentRs.forEach(r => console.log(`  ${r.createdAt?.toISOString()} ${r.success ? 'OK' : 'FAIL'} ${r.oldConsularDate} ${r.oldConsularTime} → ${r.newConsularDate} ${r.newConsularTime}`));
process.exit(0);

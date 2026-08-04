import { db } from '../src/db/client.js';
import { bots, pollLogs, rescheduleLogs } from '../src/db/schema.js';
import { eq, desc, and, gte, inArray, sql } from 'drizzle-orm';

const IDS = [178, 194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211];
const since = new Date(Date.now() - 10 * 60_000);

let polled = 0, blocked = 0;
for (const id of IDS) {
  const [last] = await db.select().from(pollLogs).where(eq(pollLogs.botId, id)).orderBy(desc(pollLogs.createdAt)).limit(1);
  const ageS = last ? Math.round((Date.now() - last.createdAt.getTime()) / 1000) : null;
  if (last && ageS! < 600) polled++;
  if (last && ['tcp_blocked','soft_ban','session_expired','error'].includes(last.status)) blocked++;
  console.log(`bot ${id}: ${last ? `${last.status} earliest=${last.earliestDate ?? '-'} (${ageS}s ago)` : 'NO POLL YET'}`);
}
// reschedules in window
const rs = await db.select({ botId: rescheduleLogs.botId }).from(rescheduleLogs).where(and(inArray(rescheduleLogs.botId, IDS), gte(rescheduleLogs.createdAt, since)));
const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(pollLogs).where(gte(pollLogs.createdAt, since));
console.log(`\npolled=${polled}/${IDS.length}  blocked/errored=${blocked}  reschedules(10m)=${rs.length}  totalPolls(10m,allbots)=${c} (~${Math.round((c as number)/10)}/min)`);
process.exit(0);

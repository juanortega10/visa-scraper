import { db } from '../src/db/client.js';
import { pollLogs } from '../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';

async function main() {
  const rows = await db.select({
    createdAt: pollLogs.createdAt, status: pollLogs.status,
    earliestDate: pollLogs.earliestDate, rawDatesCount: pollLogs.rawDatesCount,
    topDates: pollLogs.topDates, pollPhase: pollLogs.pollPhase,
  }).from(pollLogs).where(eq(pollLogs.botId, 222)).orderBy(desc(pollLogs.createdAt)).limit(8);
  for (const r of rows) {
    const t = new Date(r.createdAt).toLocaleString('en-US', { timeZone: 'America/Bogota' });
    console.log(`${t} | ${r.status} | earliest=${r.earliestDate} | raw=${r.rawDatesCount} | phase=${r.pollPhase} | top=${JSON.stringify(r.topDates)}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

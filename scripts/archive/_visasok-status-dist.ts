import { db } from '../src/db/client.js';
import { pollLogs } from '../src/db/schema.js';
import { gte, sql, and, inArray, notInArray } from 'drizzle-orm';

const since = new Date(Date.now() - 6 * 60_000);
const BATCH = [178,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211];

async function dist(label: string, where: any) {
  const rows = await db.select({ s: pollLogs.status, n: sql<number>`count(*)::int` }).from(pollLogs).where(where).groupBy(pollLogs.status);
  console.log(`${label}: ${rows.map(r=>`${r.s}=${r.n}`).join(' ') || 'none'}`);
}
await dist('ALL bots (6min)', gte(pollLogs.createdAt, since));
await dist('MY batch (6min)', and(gte(pollLogs.createdAt, since), inArray(pollLogs.botId, BATCH)));
await dist('OTHER fleet (6min)', and(gte(pollLogs.createdAt, since), notInArray(pollLogs.botId, BATCH)));
process.exit(0);

import { db } from '../src/db/client.js';
import { bots, pollLogs } from '../src/db/schema.js';
import { eq, desc, inArray } from 'drizzle-orm';

// Show last polls + spacing for batch bots that have any poll_logs
const IDS = [178,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211];
for (const id of IDS) {
  const ps = await db.select({ s: pollLogs.status, at: pollLogs.createdAt, rt: pollLogs.responseTimeMs }).from(pollLogs).where(eq(pollLogs.botId, id)).orderBy(desc(pollLogs.createdAt)).limit(6);
  if (ps.length === 0) continue;
  const gaps = ps.map((p, i) => i < ps.length - 1 ? Math.round((p.at.getTime() - ps[i + 1]!.at.getTime()) / 1000) + 's' : '').filter(Boolean);
  console.log(`bot ${id}: ${ps.length} polls | ${ps.map(p => `${p.s}(${p.rt}ms)@${p.at.toISOString().slice(11,19)}`).join('  ')}`);
  console.log(`   gaps between polls: ${gaps.join(', ')}`);
}
// what fields the bot row exposes for "blocked/backoff"
const [b] = await db.select().from(bots).where(eq(bots.id, 194));
console.log(`\nbot 194 row fields: status=${b?.status} consecutiveErrors=${b?.consecutiveErrors} activeRunId=${b?.activeRunId?.slice(0,16)} lastPollAt? (no such column on bots)`);
process.exit(0);

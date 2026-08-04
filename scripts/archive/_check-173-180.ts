import { db } from '../src/db/client.js';
import { pollLogs, bots } from '../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
for (const id of [173, 180]) {
  const [b] = await db.select({ activeRunId: bots.activeRunId, status: bots.status }).from(bots).where(eq(bots.id, id));
  const polls = await db.select().from(pollLogs).where(eq(pollLogs.botId, id)).orderBy(desc(pollLogs.createdAt)).limit(8);
  console.log(`\n=== bot ${id} status=${b!.status} activeRunId=${b!.activeRunId ?? 'null'} ===`);
  for (const p of polls) console.log(`  ${p.createdAt?.toISOString()} ${p.status} earliest=${p.earliestDate ?? '-'} ${p.banPhase ?? ''} ${p.error ? '| ' + String(p.error).slice(0,60) : ''}`);
}
process.exit(0);

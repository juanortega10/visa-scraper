import { db } from '../src/db/client.js';
import { bots, pollLogs } from '../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';

const id = parseInt(process.argv[2] ?? '0', 10);
if (!id) { console.log('Usage: _check-bot-status.ts <botId>'); process.exit(1); }

const [bot] = await db.select().from(bots).where(eq(bots.id, id));
if (!bot) { console.log(`Bot ${id} not found`); process.exit(1); }

console.log(`Bot ${id}:`);
console.log(`  status: ${bot.status}`);
console.log(`  activeRunId: ${bot.activeRunId}`);
console.log(`  currentConsular: ${bot.currentConsularDate} ${bot.currentConsularTime ?? ''}`);
console.log(`  currentCas: ${bot.currentCasDate} ${bot.currentCasTime ?? ''}`);
console.log(`  scheduleId: ${bot.scheduleId} locale: ${bot.locale} proxy: ${bot.proxyProvider}`);

const polls = await db.select().from(pollLogs).where(eq(pollLogs.botId, id)).orderBy(desc(pollLogs.createdAt)).limit(5);
console.log(`\nPoll logs (${polls.length}):`);
for (const p of polls) {
  console.log(`  ${p.createdAt?.toISOString()} | ${p.status} | earliest=${p.earliestDate ?? 'null'} | dates=${p.datesCount} | ${p.responseTimeMs}ms | ${p.provider}`);
}
process.exit(0);

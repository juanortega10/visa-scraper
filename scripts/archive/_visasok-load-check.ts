import { db } from '../src/db/client.js';
import { bots, pollLogs } from '../src/db/schema.js';
import { eq, and, gte, inArray, sql } from 'drizzle-orm';

// active es-co dev bots — current polling load
const active = await db.select().from(bots).where(and(eq(bots.status, 'active'), eq(bots.locale, 'es-co')));
console.log(`Active es-co bots: ${active.length}`);
for (const b of active) {
  console.log(`  bot ${b.id}: agency=${b.agencyId} interval=${b.pollIntervalSeconds ?? 'DEFAULT(10)'} targetPPM=${b.targetPollsPerMin ?? '-'} envs=${JSON.stringify(b.pollEnvironments)} provider=${b.proxyProvider}`);
}

// poll volume last 5 min across all dev bots (RPi IP load proxy)
const since = new Date(Date.now() - 5 * 60_000);
const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(pollLogs).where(gte(pollLogs.createdAt, since));
console.log(`\nTotal poll_logs last 5min (all bots): ${c}  (~${Math.round((c as number)/5)}/min)`);
process.exit(0);

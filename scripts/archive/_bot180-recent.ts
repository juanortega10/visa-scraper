import { db } from '../src/db/client.js';
import { pollLogs } from '../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
const polls = await db.select().from(pollLogs).where(eq(pollLogs.botId, 180)).orderBy(desc(pollLogs.createdAt)).limit(12);
for (const p of polls) console.log(`${p.createdAt?.toISOString()} status=${p.status} earliest=${p.earliestDate ?? '-'} count=${p.datesCount ?? '-'} provider=${p.provider ?? '-'} ${p.banPhase ?? ''}`);
process.exit(0);

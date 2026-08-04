import { db } from '../src/db/client.js';
import { authLogs, sessions } from '../src/db/schema.js';
import { desc, gte } from 'drizzle-orm';

const since = new Date(Date.now() - 8 * 60_000);
const al = await db.select().from(authLogs).where(gte(authLogs.createdAt, since)).orderBy(desc(authLogs.createdAt)).limit(30);
console.log(`auth_logs last 8min: ${al.length}`);
for (const a of al) console.log(`${a.createdAt.toISOString()} botId=${(a as any).botId ?? '-'} action=${a.action} result=${a.result} ${(a.errorMessage ?? '').slice(0,80)}`);
const ss = await db.select({ botId: sessions.botId, createdAt: sessions.createdAt }).from(sessions).orderBy(desc(sessions.createdAt)).limit(8);
console.log(`\nmost recent sessions:`);
for (const s of ss) console.log(`  bot ${s.botId}: ${s.createdAt.toISOString()}`);
process.exit(0);

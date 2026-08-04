import { db } from '../src/db/client.js';
import { bots, rescheduleLogs, pollLogs } from '../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
const [b] = await db.select().from(bots).where(eq(bots.id, 173));
console.log('current', b!.currentConsularDate, b!.currentConsularTime, '| cas', b!.currentCasDate, '| status', b!.status, '| rescheduleCount', b!.rescheduleCount, '| provider', b!.proxyProvider);
const rs = await db.select().from(rescheduleLogs).where(eq(rescheduleLogs.botId, 173)).orderBy(desc(rescheduleLogs.createdAt)).limit(6);
console.log('recent reschedules:', rs.length);
for (const r of rs) console.log('  ', r.createdAt?.toISOString(), r.success ? 'OK' : 'FAIL', r.oldConsularDate, '->', r.newConsularDate, r.error ?? '');
process.exit(0);

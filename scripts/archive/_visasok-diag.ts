import { db } from '../src/db/client.js';
import { bots, sessions, authLogs, pollLogs } from '../src/db/schema.js';
import { inArray, desc, gte, eq } from 'drizzle-orm';

const IDS = [194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211];
const since = new Date(Date.now() - 15 * 60_000);

const bs = await db.select({ id: bots.id, status: bots.status, activeRunId: bots.activeRunId, consecutiveErrors: bots.consecutiveErrors, userId: bots.userId, testMode: bots.testMode, scheduleId: bots.scheduleId }).from(bots).where(inArray(bots.id, IDS));
console.log('=== bot states ===');
for (const b of bs) console.log(`bot ${b.id}: status=${b.status} activeRunId=${b.activeRunId ?? 'null'} errs=${b.consecutiveErrors} userId=${b.userId ?? 'null'} testMode=${b.testMode} sched=${b.scheduleId}`);

const sess = await db.select({ botId: sessions.botId }).from(sessions).where(inArray(sessions.botId, IDS));
console.log(`\nsessions present for: ${sess.map(s=>s.botId).join(',') || 'NONE'}`);

const al = await db.select().from(authLogs).where(gte(authLogs.createdAt, since)).orderBy(desc(authLogs.createdAt)).limit(20);
console.log('\n=== recent auth_logs (15m) ===');
for (const a of al) console.log(`${a.createdAt.toISOString()} botId=${(a as any).botId ?? '-'} action=${a.action} result=${a.result} ${a.errorMessage ?? ''}`);

const pl = await db.select({ botId: pollLogs.botId }).from(pollLogs).where(inArray(pollLogs.botId, IDS));
console.log(`\npoll_logs EVER for new bots: ${pl.length}`);
process.exit(0);

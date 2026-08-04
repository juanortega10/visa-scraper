import { db } from '../src/db/client.js';
import { bots, pollLogs } from '../src/db/schema.js';
import { eq, and, inArray, sql, desc, gte } from 'drizzle-orm';

// active dev bots competing for the 4-slot queue
const active = await db.select({ id: bots.id, locale: bots.locale, provider: bots.proxyProvider }).from(bots)
  .where(and(eq(bots.status, 'active'), inArray(bots.testMode, [false])));
const dev = active.filter(b => true);
console.log(`Total active bots: ${active.length}`);

// 194 detail
const [b194] = await db.select().from(bots).where(eq(bots.id, 194));
console.log(`bot194: status=${b194?.status} activeRunId=${b194?.activeRunId ?? 'null'}`);
const p194 = await db.select({ s: pollLogs.status, at: pollLogs.createdAt }).from(pollLogs).where(eq(pollLogs.botId, 194)).orderBy(desc(pollLogs.createdAt)).limit(3);
console.log(`bot194 polls ever: ${p194.length}`, p194.map(p=>`${p.s}@${p.at.toISOString().slice(11,19)}`).join(', '));

// poll throughput + avg duration last 10min
const since = new Date(Date.now() - 10*60_000);
const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(pollLogs).where(gte(pollLogs.createdAt, since));
const [{ avg, max }] = await db.select({ avg: sql<number>`avg(response_time_ms)::int`, max: sql<number>`max(response_time_ms)::int` }).from(pollLogs).where(gte(pollLogs.createdAt, since));
console.log(`polls last 10min: ${c} (~${Math.round((c as number)/10)}/min), avgRespMs=${avg} maxRespMs=${max}`);

// distinct bots that polled in last 10min
const distinct = await db.select({ id: pollLogs.botId }).from(pollLogs).where(gte(pollLogs.createdAt, since)).groupBy(pollLogs.botId);
console.log(`distinct bots polling (10min): ${distinct.length} -> ${distinct.map(d=>d.id).sort((a,b)=>a-b).join(',')}`);
process.exit(0);

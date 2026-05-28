import { db } from '../src/db/client.js';
import { pollLogs } from '../src/db/schema.js';
import { gte, sql } from 'drizzle-orm';

const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000);
const since1h = new Date(Date.now() - 60 * 60 * 1000);

console.log('since24:', since24.toISOString());
console.log('since1h:', since1h.toISOString());

const rows = await db.select({
  botId: pollLogs.botId,
  total24h: sql<number>`count(*)::int`,
  total1h:  sql<number>`count(*) filter (where ${pollLogs.createdAt} > ${since1h})::int`,
}).from(pollLogs)
  .where(gte(pollLogs.createdAt, since24))
  .groupBy(pollLogs.botId);

const r94 = rows.find(r => r.botId === 94);
const r93 = rows.find(r => r.botId === 93);
console.log('Bot 94:', r94);
console.log('Bot 93:', r93);
process.exit(0);

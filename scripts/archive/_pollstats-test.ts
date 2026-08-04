import { db } from '../src/db/client.js';
import { pollLogs } from '../src/db/schema.js';
import { gte, sql } from 'drizzle-orm';

const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000);
const since1h  = new Date(Date.now() - 60 * 60 * 1000);

const rows = await db.select({
  botId:    pollLogs.botId,
  total24h: sql<number>`count(*)::int`,
  total1h:  sql<number>`count(*) filter (where ${pollLogs.createdAt} > ${since1h.toISOString()}::timestamptz)::int`,
}).from(pollLogs)
  .where(gte(pollLogs.createdAt, since24))
  .groupBy(pollLogs.botId);

for (const r of rows.filter(r => [93,94,7,95].includes(r.botId))) {
  const ppm1h = (r.total1h / 60).toFixed(1);
  const ppm24h = (r.total24h / 1440).toFixed(1);
  console.log(`Bot ${r.botId}: 1h=${r.total1h} (${ppm1h}/min)  24h=${r.total24h} (${ppm24h}/min)`);
}
process.exit(0);

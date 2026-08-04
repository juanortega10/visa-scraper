/** Read-only: ONLY active bots (the real RPi load source), with 1h + 24h poll volume. */
import { db } from '../src/db/client.js';
import { bots, pollLogs } from '../src/db/schema.js';
import { sql, gte, and, eq } from 'drizzle-orm';

const rows = await db
  .select({
    id: bots.id, locale: bots.locale, status: bots.status, cohort: bots.cohort,
    env: bots.pollEnvironments, provider: bots.proxyProvider,
    consular: bots.currentConsularDate,
  })
  .from(bots)
  .where(eq(bots.status, 'active'))
  .orderBy(bots.id);

console.log(`\nACTIVE bots: ${rows.length} (these are what load the RPi)\n`);
let total1h = 0;
for (const b of rows) {
  const [h] = await db
    .select({
      p1h: sql<number>`count(*) filter (where ${pollLogs.createdAt} >= now() - interval '1 hour')`,
      real1h: sql<number>`coalesce(sum(${pollLogs.pollsSincePrev}) filter (where ${pollLogs.createdAt} >= now() - interval '1 hour'),0)`,
      p24h: sql<number>`count(*)`,
    })
    .from(pollLogs)
    .where(and(eq(pollLogs.botId, b.id), gte(pollLogs.createdAt, sql`now() - interval '24 hours'`)));
  total1h += Number(h?.real1h ?? 0);
  const personal = [6, 7, 12, 15].includes(b.id) ? ' ⚠️PERSONAL' : '';
  console.log(
    `#${String(b.id).padStart(3)} ${(b.locale ?? '').padEnd(6)} cohort=${(b.cohort ?? '-').padEnd(6)} ` +
    `prov=${(b.provider ?? '-').padEnd(9)} env=${((b.env as string[])?.join('+') ?? '-').padEnd(9)} ` +
    `rows1h=${String(Number(h?.p1h ?? 0)).padStart(4)} realPolls1h=${String(Number(h?.real1h ?? 0)).padStart(5)} ` +
    `rows24h=${Number(h?.p24h ?? 0)} consular=${b.consular ?? '-'}${personal}`
  );
}
console.log(`\nTotal real polls last 1h across active fleet: ${total1h}`);
process.exit(0);

import 'dotenv/config';
import { db } from '../src/db/client.js';
import { rescheduleLogs, bots } from '../src/db/schema.js';
import { and, isNotNull, eq, gt, sql, desc } from 'drizzle-orm';

async function main() {
  // 1) Successful reschedule history — empirical CAS-consular gaps actually achieved
  const success = await db
    .select({
      botId: rescheduleLogs.botId,
      newConsularDate: rescheduleLogs.newConsularDate,
      newCasDate: rescheduleLogs.newCasDate,
      createdAt: rescheduleLogs.createdAt,
    })
    .from(rescheduleLogs)
    .where(
      and(
        eq(rescheduleLogs.success, true),
        isNotNull(rescheduleLogs.newCasDate),
        isNotNull(rescheduleLogs.newConsularDate),
        gt(rescheduleLogs.createdAt, new Date(Date.now() - 90 * 86400000)),
      ),
    )
    .orderBy(desc(rescheduleLogs.createdAt))
    .limit(500);

  type Row = (typeof success)[number];
  const gaps = success
    .map((r: Row) => {
      const c = new Date(r.newConsularDate as string).getTime();
      const a = new Date(r.newCasDate as string).getTime();
      return {
        botId: r.botId,
        consular: r.newConsularDate,
        cas: r.newCasDate,
        gap: Math.round((c - a) / 86400000),
        when: r.createdAt,
      };
    })
    .filter((g: { gap: number }) => g.gap >= 0 && g.gap <= 60);

  console.log(`\n=== SUCCESSFUL RESCHEDULES — last 90d (${gaps.length} samples) ===`);
  const dist = new Map<number, number>();
  for (const g of gaps) dist.set(g.gap, (dist.get(g.gap) ?? 0) + 1);
  const sorted = [...dist.entries()].sort((a, b) => a[0] - b[0]);
  console.log('gap_days | count | %');
  const total = gaps.length;
  for (const [gap, count] of sorted) {
    const pct = ((count / total) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round((count / total) * 50));
    console.log(`${String(gap).padStart(8)} | ${String(count).padStart(5)} | ${pct.padStart(5)}%  ${bar}`);
  }

  const sortedGaps = gaps.map((g: { gap: number }) => g.gap).sort((a: number, b: number) => a - b);
  const min = sortedGaps[0];
  const p10 = sortedGaps[Math.floor(sortedGaps.length * 0.1)];
  const p25 = sortedGaps[Math.floor(sortedGaps.length * 0.25)];
  const p50 = sortedGaps[Math.floor(sortedGaps.length * 0.5)];
  const p75 = sortedGaps[Math.floor(sortedGaps.length * 0.75)];
  const p90 = sortedGaps[Math.floor(sortedGaps.length * 0.9)];
  const max = sortedGaps[sortedGaps.length - 1];
  console.log(`\nmin=${min} p10=${p10} p25=${p25} p50=${p50} p75=${p75} p90=${p90} max=${max}`);

  // 2) Latest 10 examples
  console.log(`\n=== LATEST 10 SUCCESSFUL EXAMPLES ===`);
  for (const g of gaps.slice(0, 10)) {
    console.log(`bot ${g.botId}: consular ${g.consular} | cas ${g.cas} | gap=${g.gap}d | ${new Date(g.when).toISOString().slice(0, 10)}`);
  }

  // 3) Live casCache across all bots — what's currently available
  console.log(`\n=== LIVE casCache — gap between cached CAS dates and their forConsularDate ===`);
  const allBots = await db
    .select({ id: bots.id, locale: bots.locale, casCacheJson: bots.casCacheJson, maxCasGapDays: bots.maxCasGapDays })
    .from(bots)
    .where(sql`${bots.casCacheJson} IS NOT NULL`);

  const cacheGaps = new Map<number, number>();
  let cacheSamples = 0;
  type BotRow = (typeof allBots)[number];
  type CacheEntry = { date: string; slots: number; forConsularDate?: string | null };
  for (const b of allBots as BotRow[]) {
    const cache = b.casCacheJson as { entries?: CacheEntry[] } | null;
    if (!cache?.entries) continue;
    for (const e of cache.entries) {
      if (!e.forConsularDate) continue;
      if (e.slots <= 0) continue;
      const c = new Date(e.forConsularDate).getTime();
      const a = new Date(e.date).getTime();
      const gap = Math.round((c - a) / 86400000);
      if (gap < 0 || gap > 60) continue;
      cacheGaps.set(gap, (cacheGaps.get(gap) ?? 0) + 1);
      cacheSamples++;
    }
  }
  console.log(`bots with cache: ${allBots.length} | cache entries with gap data: ${cacheSamples}`);
  const cacheDist = [...cacheGaps.entries()].sort((a, b) => a[0] - b[0]);
  console.log('gap_days | count');
  for (const [gap, count] of cacheDist) {
    const bar = '█'.repeat(Math.min(50, count));
    console.log(`${String(gap).padStart(8)} | ${String(count).padStart(5)}  ${bar}`);
  }

  // 4) Bot 51 last 30 days: what CAS gaps were OFFERED across all attempts (extracted from reschedule_logs detail or other bots' cache entries that match bot 51's consular dates)
  console.log(`\n=== Bots with maxCasGapDays distribution ===`);
  const allBots2 = await db.select({ id: bots.id, locale: bots.locale, maxCasGapDays: bots.maxCasGapDays, status: bots.status }).from(bots);
  const cfgDist = new Map<string, number>();
  for (const b of allBots2 as { maxCasGapDays: number | null; status: string }[]) {
    const key = `${b.maxCasGapDays ?? 'NULL(default 8)'}`;
    cfgDist.set(key, (cfgDist.get(key) ?? 0) + 1);
  }
  console.log('maxCasGapDays | bots');
  for (const [k, v] of [...cfgDist.entries()].sort()) console.log(`${k.padStart(20)} | ${v}`);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

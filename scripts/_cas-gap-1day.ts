import 'dotenv/config';
import { db } from '../src/db/client.js';
import { rescheduleLogs, bots } from '../src/db/schema.js';
import { and, isNotNull, eq, gt, sql, desc } from 'drizzle-orm';

async function main() {
  const success = await db
    .select({
      id: rescheduleLogs.id,
      botId: rescheduleLogs.botId,
      oldConsularDate: rescheduleLogs.oldConsularDate,
      oldCasDate: rescheduleLogs.oldCasDate,
      newConsularDate: rescheduleLogs.newConsularDate,
      newConsularTime: rescheduleLogs.newConsularTime,
      newCasDate: rescheduleLogs.newCasDate,
      newCasTime: rescheduleLogs.newCasTime,
      provider: rescheduleLogs.provider,
      runId: rescheduleLogs.runId,
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
    .orderBy(desc(rescheduleLogs.createdAt));

  type Row = (typeof success)[number];
  const oneDay = success
    .map((r: Row) => ({
      ...r,
      gap: Math.round(
        (new Date(r.newConsularDate as string).getTime() - new Date(r.newCasDate as string).getTime()) / 86400000,
      ),
    }))
    .filter((r: { gap: number }) => r.gap === 1);

  console.log(`\n=== ALL gap=1 SUCCESSFUL RESCHEDULES (last 90d) — ${oneDay.length} cases ===\n`);
  for (const r of oneDay) {
    const bot = await db.select({ locale: bots.locale, maxCasGapDays: bots.maxCasGapDays }).from(bots).where(eq(bots.id, r.botId)).limit(1);
    const localeStr = bot[0]?.locale ?? '?';
    const maxGap = bot[0]?.maxCasGapDays ?? 'default(8)';
    console.log(
      `id=${r.id} bot=${r.botId} (${localeStr}, maxGap=${maxGap}) | consular ${r.newConsularDate} ${r.newConsularTime} | cas ${r.newCasDate} ${r.newCasTime} | created ${new Date(r.createdAt as Date).toISOString().slice(0, 16).replace('T', ' ')}Z | run ${r.runId}`,
    );
  }

  // Also check raw distribution including same-day (gap=0) and negative
  const all = success.map((r: Row) => ({
    consular: r.newConsularDate,
    cas: r.newCasDate,
    gap: Math.round(
      (new Date(r.newConsularDate as string).getTime() - new Date(r.newCasDate as string).getTime()) / 86400000,
    ),
  }));
  const byGap = new Map<number, number>();
  for (const r of all) byGap.set(r.gap, (byGap.get(r.gap) ?? 0) + 1);
  console.log(`\n=== RAW gap distribution (including <0 and >12) ===`);
  for (const [g, c] of [...byGap.entries()].sort((a, b) => a[0] - b[0])) console.log(`  gap=${g} -> ${c}`);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

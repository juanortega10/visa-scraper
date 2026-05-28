import 'dotenv/config';
import { db } from '../src/db/client.js';
import { rescheduleLogs, bots } from '../src/db/schema.js';
import { and, isNotNull, eq, gt, sql, desc, isNull } from 'drizzle-orm';

async function main() {
  const success = await db
    .select({
      id: rescheduleLogs.id,
      botId: rescheduleLogs.botId,
      newConsularDate: rescheduleLogs.newConsularDate,
      newConsularTime: rescheduleLogs.newConsularTime,
      newCasDate: rescheduleLogs.newCasDate,
      newCasTime: rescheduleLogs.newCasTime,
      runId: rescheduleLogs.runId,
      provider: rescheduleLogs.provider,
      sessionAgeMs: rescheduleLogs.sessionAgeMs,
      durationMs: rescheduleLogs.durationMs,
      detail: rescheduleLogs.detail,
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
  const rows = (success as Row[]).map((r) => ({
    ...r,
    gap: Math.round(
      (new Date(r.newConsularDate as string).getTime() - new Date(r.newCasDate as string).getTime()) / 86400000,
    ),
  }));

  // Dedup by (botId, consularDate, consularTime, casDate, casTime) — keep earliest
  const byKey = new Map<string, typeof rows[number]>();
  for (const r of rows) {
    const k = `${r.botId}|${r.newConsularDate}|${r.newConsularTime}|${r.newCasDate}|${r.newCasTime}`;
    const prev = byKey.get(k);
    if (!prev || new Date(r.createdAt as Date) < new Date(prev.createdAt as Date)) byKey.set(k, r);
  }
  const unique = [...byKey.values()];

  console.log(`Raw success rows: ${rows.length} | unique by (bot,consularDateTime,casDateTime): ${unique.length}\n`);

  const distRaw = new Map<number, number>();
  const distDedup = new Map<number, number>();
  for (const r of rows) distRaw.set(r.gap, (distRaw.get(r.gap) ?? 0) + 1);
  for (const r of unique) distDedup.set(r.gap, (distDedup.get(r.gap) ?? 0) + 1);

  const totalU = unique.length;
  console.log('gap | raw | unique | unique%');
  const allGaps = new Set<number>([...distRaw.keys(), ...distDedup.keys()]);
  for (const g of [...allGaps].sort((a, b) => a - b)) {
    const r = distRaw.get(g) ?? 0;
    const u = distDedup.get(g) ?? 0;
    const pct = ((u / totalU) * 100).toFixed(1);
    console.log(`${String(g).padStart(3)} | ${String(r).padStart(3)} | ${String(u).padStart(6)} | ${pct.padStart(5)}%`);
  }

  console.log(`\n=== UNIQUE gap=1 examples ===`);
  const gap1Unique = unique.filter((r) => r.gap === 1).sort((a, b) => new Date(a.createdAt as Date).getTime() - new Date(b.createdAt as Date).getTime());
  for (const r of gap1Unique) {
    const bot = await db.select({ locale: bots.locale, maxCasGapDays: bots.maxCasGapDays, scheduleId: bots.scheduleId }).from(bots).where(eq(bots.id, r.botId)).limit(1);
    const localeStr = bot[0]?.locale ?? '?';
    const maxGap = bot[0]?.maxCasGapDays ?? 'default(8)';
    const sid = bot[0]?.scheduleId ?? '?';
    const runIdStr = r.runId ? r.runId.slice(0, 12) + '...' : 'NULL(manual?)';
    console.log(
      `  bot=${r.botId} sid=${sid} ${localeStr} maxGap=${maxGap} | consular ${r.newConsularDate} ${r.newConsularTime} → cas ${r.newCasDate} ${r.newCasTime} | run=${runIdStr} | ${new Date(r.createdAt as Date).toISOString().slice(0, 16)}Z`,
    );
  }

  console.log(`\n=== gap=1 summary ===`);
  console.log(`  unique cases: ${gap1Unique.length}`);
  const withRunId = gap1Unique.filter((r) => r.runId !== null).length;
  console.log(`  with runId (real poll-visa): ${withRunId}`);
  console.log(`  null runId (likely manual scripts/snipers): ${gap1Unique.length - withRunId}`);

  // Same but for gap=8 baseline
  const gap8Unique = unique.filter((r) => r.gap === 8);
  const gap8withRun = gap8Unique.filter((r) => r.runId !== null).length;
  console.log(`\n  Comparison: gap=8 unique=${gap8Unique.length}, withRunId=${gap8withRun}`);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

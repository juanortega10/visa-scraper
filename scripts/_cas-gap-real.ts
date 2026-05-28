import 'dotenv/config';
import { db } from '../src/db/client.js';
import { rescheduleLogs, bots } from '../src/db/schema.js';
import { and, isNotNull, eq, gt, desc } from 'drizzle-orm';

async function main() {
  // Only reschedules with runId — i.e., real poll-visa / reschedule-visa task runs
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
      createdAt: rescheduleLogs.createdAt,
    })
    .from(rescheduleLogs)
    .where(
      and(
        eq(rescheduleLogs.success, true),
        isNotNull(rescheduleLogs.newCasDate),
        isNotNull(rescheduleLogs.newConsularDate),
        isNotNull(rescheduleLogs.runId),
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

  // Dedup: poll-visa can write multiple log rows during the secure-then-improve flow
  // (one per attempt within the same run). Keep only the FINAL state per (bot, runId).
  const byRun = new Map<string, typeof rows[number]>();
  for (const r of rows) {
    const k = `${r.botId}|${r.runId}`;
    const prev = byRun.get(k);
    if (!prev || new Date(r.createdAt as Date) > new Date(prev.createdAt as Date)) byRun.set(k, r);
  }
  const finals = [...byRun.values()];

  console.log(`Real success rows (runId not null): ${rows.length} | unique by run: ${finals.length}\n`);

  const dist = new Map<number, number>();
  for (const r of finals) dist.set(r.gap, (dist.get(r.gap) ?? 0) + 1);
  const total = finals.length;
  const sortedGaps = [...dist.keys()].sort((a, b) => a - b);

  console.log('gap_days | count | %     | acumulado');
  let acc = 0;
  for (const g of sortedGaps) {
    const c = dist.get(g)!;
    acc += c;
    const pct = ((c / total) * 100).toFixed(1);
    const accPct = ((acc / total) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round((c / total) * 50));
    console.log(`${String(g).padStart(8)} | ${String(c).padStart(5)} | ${pct.padStart(5)}% | ${accPct.padStart(5)}%  ${bar}`);
  }

  const arr = finals.map((r) => r.gap).sort((a, b) => a - b);
  const pct = (p: number) => arr[Math.floor(arr.length * p)];
  console.log(`\nmin=${arr[0]} p10=${pct(0.1)} p25=${pct(0.25)} p50=${pct(0.5)} p75=${pct(0.75)} p90=${pct(0.9)} max=${arr[arr.length - 1]}`);

  // Show all gap < 6 (potential "tight" wins)
  console.log(`\n=== ALL real wins with gap <= 6 ===`);
  const tight = finals.filter((r) => r.gap <= 6).sort((a, b) => a.gap - b.gap || +new Date(a.createdAt as Date) - +new Date(b.createdAt as Date));
  for (const r of tight) {
    const bot = await db.select({ locale: bots.locale, maxCasGapDays: bots.maxCasGapDays, scheduleId: bots.scheduleId }).from(bots).where(eq(bots.id, r.botId)).limit(1);
    const localeStr = bot[0]?.locale ?? '?';
    const maxGap = bot[0]?.maxCasGapDays ?? 'default(8)';
    const sid = bot[0]?.scheduleId ?? '?';
    console.log(
      `  gap=${r.gap}d bot=${r.botId} sid=${sid} ${localeStr} maxGap=${maxGap} | consular ${r.newConsularDate} ${r.newConsularTime} → cas ${r.newCasDate} ${r.newCasTime} | run=${(r.runId as string).slice(0, 16)} | ${new Date(r.createdAt as Date).toISOString().slice(0, 16)}Z`,
    );
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

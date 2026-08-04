/**
 * Apply VisasOK config for Yajaira (180) + luzayve (179):
 *  1. proxyProvider -> direct
 *  2. excluded_dates floor (today .. attend-after date)
 *  3. sync luzayve current appointment to live value
 * DB-only. Idempotent on excluded_dates (skips if identical range exists).
 */
import { db } from '../src/db/client.js';
import { bots, excludedDates } from '../src/db/schema.js';
import { and, eq } from 'drizzle-orm';

const PLAN = [
  { botId: 180, name: 'Yajaira', start: '2026-05-28', end: '2026-06-06', syncConsular: null as null | { date: string; time: string; casDate: string; casTime: string } },
  { botId: 179, name: 'luzayve', start: '2026-05-28', end: '2026-06-15', syncConsular: { date: '2027-02-08', time: '08:15', casDate: '2027-01-27', casTime: '11:30' } },
];

async function main() {
  for (const p of PLAN) {
    // 1. provider -> direct
    await db.update(bots).set({ proxyProvider: 'direct', updatedAt: new Date() }).where(eq(bots.id, p.botId));

    // 2. excluded_dates (idempotent)
    const existing = await db.select().from(excludedDates)
      .where(and(eq(excludedDates.botId, p.botId), eq(excludedDates.startDate, p.start), eq(excludedDates.endDate, p.end)));
    if (existing.length === 0) {
      await db.insert(excludedDates).values({ botId: p.botId, startDate: p.start, endDate: p.end });
    }

    // 3. sync live consular (luzayve only)
    if (p.syncConsular) {
      await db.update(bots).set({
        currentConsularDate: p.syncConsular.date,
        currentConsularTime: p.syncConsular.time,
        currentCasDate: p.syncConsular.casDate,
        currentCasTime: p.syncConsular.casTime,
        updatedAt: new Date(),
      }).where(eq(bots.id, p.botId));
    }

    const [b] = await db.select().from(bots).where(eq(bots.id, p.botId));
    const ex = await db.select().from(excludedDates).where(eq(excludedDates.botId, p.botId));
    console.log(`Bot ${p.botId} (${p.name}): provider=${b!.proxyProvider} current=${b!.currentConsularDate} ${b!.currentConsularTime} | excluded=[${ex.map((e) => e.startDate + '→' + e.endDate).join(', ')}]`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

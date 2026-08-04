// Arm bot 222 sniper mode: window [2026-06-01, 2026-07-21) = jun1..jul20 inclusive,
// CAS gap <= 7 days. Owner-authorized override of strictly-earlier protection.
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

async function main() {
  const [before] = await db.select({
    currentConsularDate: bots.currentConsularDate, currentCasDate: bots.currentCasDate,
    targetDateAfter: bots.targetDateAfter, targetDateBefore: bots.targetDateBefore,
    maxCasGapDays: bots.maxCasGapDays, sniperMode: bots.sniperMode,
  }).from(bots).where(eq(bots.id, 222));
  console.log('BEFORE:', before);

  await db.update(bots).set({
    targetDateAfter: '2026-06-01',
    targetDateBefore: '2026-07-21',
    maxCasGapDays: 7,
    sniperMode: true,
    updatedAt: new Date(),
  }).where(eq(bots.id, 222));

  const [after] = await db.select({
    currentConsularDate: bots.currentConsularDate, currentCasDate: bots.currentCasDate,
    targetDateAfter: bots.targetDateAfter, targetDateBefore: bots.targetDateBefore,
    maxCasGapDays: bots.maxCasGapDays, sniperMode: bots.sniperMode, status: bots.status,
  }).from(bots).where(eq(bots.id, 222));
  console.log('AFTER: ', after);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Set maxCasGapDays for bot 12.
 * Usage: npx tsx --env-file=.env scripts/set-bot12-cas-gap.ts
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

await db.update(bots).set({ maxCasGapDays: 3, updatedAt: new Date() }).where(eq(bots.id, 12));
console.log('Bot 12: maxCasGapDays set to 3');

const [bot] = await db.select({
  id: bots.id, maxCasGapDays: bots.maxCasGapDays, currentConsularDate: bots.currentConsularDate,
}).from(bots).where(eq(bots.id, 12));
console.log(bot);
process.exit(0);

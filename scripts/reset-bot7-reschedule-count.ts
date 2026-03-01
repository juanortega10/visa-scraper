import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const botId = 7;

const [before] = await db.select({
  rescheduleCount: bots.rescheduleCount,
  maxReschedules: bots.maxReschedules,
}).from(bots).where(eq(bots.id, botId));

console.log('Before:', before);

await db.update(bots).set({ rescheduleCount: 0 }).where(eq(bots.id, botId));

const [after] = await db.select({
  rescheduleCount: bots.rescheduleCount,
  maxReschedules: bots.maxReschedules,
}).from(bots).where(eq(bots.id, botId));

console.log('After:', after);
process.exit(0);

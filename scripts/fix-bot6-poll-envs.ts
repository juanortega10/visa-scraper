import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const [bot] = await db.select({ pollEnvironments: bots.pollEnvironments }).from(bots).where(eq(bots.id, 6));
console.log('Current pollEnvironments:', JSON.stringify(bot.pollEnvironments));

await db.update(bots).set({ pollEnvironments: ['dev', 'prod'], updatedAt: new Date() }).where(eq(bots.id, 6));

const [updated] = await db.select({ pollEnvironments: bots.pollEnvironments }).from(bots).where(eq(bots.id, 6));
console.log('Updated pollEnvironments:', JSON.stringify(updated.pollEnvironments));
process.exit(0);

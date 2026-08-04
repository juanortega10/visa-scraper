import { db } from '../src/db/client.ts';
import { bots } from '../src/db/schema.ts';
import { eq } from 'drizzle-orm';
const [bot] = await db.select({ id: bots.id, minDaysFromToday: bots.minDaysFromToday }).from(bots).where(eq(bots.id, 164));
console.log(bot);
process.exit(0);

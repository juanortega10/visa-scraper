import { db } from '../src/db/client.ts';
import { bots } from '../src/db/schema.ts';
import { eq } from 'drizzle-orm';
await db.update(bots).set({ minDaysFromToday: 28 }).where(eq(bots.id, 164));
console.log('done');
process.exit(0);

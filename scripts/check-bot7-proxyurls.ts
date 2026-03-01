import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
const [bot] = await db.select({ proxyUrls: bots.proxyUrls }).from(bots).where(eq(bots.id, 7));
console.log('DB proxyUrls:', JSON.stringify(bot?.proxyUrls));
process.exit(0);

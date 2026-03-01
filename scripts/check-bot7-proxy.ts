import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const [bot] = await db.select({ proxyUrls: bots.proxyUrls, proxyProvider: bots.proxyProvider }).from(bots).where(eq(bots.id, 7));
console.log('Bot 7 proxy config:', JSON.stringify(bot, null, 2));
process.exit(0);

/**
 * Set bot proxy provider to webshare directly in DB.
 * Usage: npx tsx --env-file=.env scripts/set-bot-provider-webshare.ts 12
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const botId = parseInt(process.argv[2] ?? '');
if (isNaN(botId)) { console.error('Usage: set-bot-provider-webshare.ts <botId>'); process.exit(1); }

const [bot] = await db.select({ id: bots.id, proxyProvider: bots.proxyProvider }).from(bots).where(eq(bots.id, botId));
if (!bot) { console.error(`Bot ${botId} not found`); process.exit(1); }

console.log(`Bot ${botId}: ${bot.proxyProvider} → webshare`);
await db.update(bots).set({ proxyProvider: 'webshare', updatedAt: new Date() }).where(eq(bots.id, botId));
console.log('Done.');
process.exit(0);

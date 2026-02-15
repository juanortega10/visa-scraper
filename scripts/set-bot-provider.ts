import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const botId = parseInt(process.argv.find(a => a.startsWith('--bot-id='))?.split('=')[1] ?? '5', 10);
const provider = process.argv.find(a => a.startsWith('--provider='))?.split('=')[1] ?? 'firecrawl';

await db.update(bots).set({ proxyProvider: provider, updatedAt: new Date() }).where(eq(bots.id, botId));
const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
console.log(`Bot ${botId} proxyProvider → ${bot?.proxyProvider}`);
process.exit(0);

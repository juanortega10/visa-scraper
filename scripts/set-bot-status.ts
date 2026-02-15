import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const botId = parseInt(process.argv.find(a => a.startsWith('--bot-id='))?.split('=')[1] ?? '5', 10);
const status = process.argv.find(a => a.startsWith('--status='))?.split('=')[1] ?? 'login_required';

await db.update(bots).set({ status, updatedAt: new Date() }).where(eq(bots.id, botId));
const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
console.log(`Bot ${botId} status → ${bot?.status}`);
process.exit(0);

import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const botId = parseInt(process.argv[2] || '12');
await db.update(bots).set({ status: 'active', activeRunId: null, activeCloudRunId: null, updatedAt: new Date() }).where(eq(bots.id, botId));
console.log(`Bot ${botId} set to active (no activeRunId — cron will pick up)`);
process.exit(0);

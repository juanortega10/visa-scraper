import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
// Clear zombie activeRunId so poll-cron-local re-triggers a fresh chain next tick
await db.update(bots).set({ activeRunId: null, updatedAt: new Date() }).where(eq(bots.id, 180));
const [b] = await db.select({ status: bots.status, activeRunId: bots.activeRunId }).from(bots).where(eq(bots.id, 180));
console.log(`bot 180: status=${b!.status} activeRunId=${b!.activeRunId ?? 'null'} (cron will re-trigger within ~2min)`);
process.exit(0);

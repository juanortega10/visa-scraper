import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
const id = parseInt(process.argv[2]!);
await db.update(bots).set({ status: 'active', activeRunId: null, activeCloudRunId: null, consecutiveErrors: 0, updatedAt: new Date() }).where(eq(bots.id, id));
console.log(`activated bot ${id}`);
process.exit(0);

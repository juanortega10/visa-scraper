import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const id = parseInt(process.argv[2] ?? '0', 10);
const [b] = await db.select().from(bots).where(eq(bots.id, id));
if (!b) { console.log('not found'); process.exit(1); }
console.log('pollEnvironments:', b.pollEnvironments);
console.log('cloudEnabled:', b.cloudEnabled);
console.log('activeRunId:', b.activeRunId);
console.log('activeCloudRunId:', b.activeCloudRunId);
process.exit(0);

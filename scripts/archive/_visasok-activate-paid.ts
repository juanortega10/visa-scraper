import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { inArray } from 'drizzle-orm';

const IDS = [178, 194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211];
await db.update(bots)
  .set({ status: 'active', activeRunId: null, activeCloudRunId: null, consecutiveErrors: 0, updatedAt: new Date() })
  .where(inArray(bots.id, IDS));
const rows = await db.select({ id: bots.id, status: bots.status }).from(bots).where(inArray(bots.id, IDS));
console.log(`Activated ${rows.filter(r => r.status === 'active').length}/${IDS.length} bots (cron will pick up):`);
console.log(rows.map(r => `${r.id}:${r.status}`).join('  '));
process.exit(0);

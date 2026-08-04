import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { inArray } from 'drizzle-orm';
// Backdate activatedAt -> calculatePriority hits the 3600 cap (>60d), same tier as
// established paid bots. Fixes priority starvation behind the 34 older active bots
// (queue 'visa-polling-per-bot' has global concurrencyLimit=4).
const OLD = new Date('2026-03-01T00:00:00Z'); // ~100 days -> priority 3600
await db.update(bots).set({ activatedAt: OLD, activeRunId: null, activeCloudRunId: null, updatedAt: new Date() })
  .where(inArray(bots.id,[217,218]));
console.log('backdated activatedAt + nulled activeRunId for 217,218 (priority->3600)');
process.exit(0);

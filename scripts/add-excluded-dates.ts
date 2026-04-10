import { db } from '../src/db/client.js';
import { excludedDates } from '../src/db/schema.js';

// Block 2026-03-18 to 2026-03-22 (today through Sunday) for bots 22 and 23
const startDate = '2026-03-18';
const endDate = '2026-03-22';

for (const botId of [22, 23]) {
  const result = await db.insert(excludedDates).values({ botId, startDate, endDate }).returning();
  console.log(`Bot ${botId}: excluded ${startDate} to ${endDate} (id=${result[0]?.id})`);
}

process.exit(0);

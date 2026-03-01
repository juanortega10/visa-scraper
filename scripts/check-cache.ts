import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
const [bot] = await db.select({ id: bots.id, casCacheJson: bots.casCacheJson }).from(bots).where(eq(bots.id, 12));
if (bot?.casCacheJson) {
  const cache = bot.casCacheJson as any;
  console.log('refreshedAt:', cache.refreshedAt);
  console.log('totalDates:', cache.totalDates);
  console.log('entries:', cache.entries?.length);
  for (const e of cache.entries) {
    console.log(`  ${e.date}: ${e.slots} slots`);
  }
} else {
  console.log('casCacheJson is NULL');
}
process.exit(0);

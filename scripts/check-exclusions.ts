import 'dotenv/config';
import { db } from '../src/db/client.js';
import { excludedDates, excludedTimes } from '../src/db/schema.js';

const dates = await db.select().from(excludedDates);
console.log('=== excluded_dates ===');
for (const r of dates) {
  console.log(`botId=${r.botId}  ${r.startDate} → ${r.endDate}`);
}

const times = await db.select().from(excludedTimes);
if (times.length > 0) {
  console.log('\n=== excluded_times ===');
  for (const r of times) {
    console.log(`botId=${r.botId}  date=${r.date}  ${r.timeStart}→${r.timeEnd}`);
  }
}

process.exit(0);

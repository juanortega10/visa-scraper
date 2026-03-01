import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

// Update Bot 6: new appointment dates + scout only + active
await db.update(bots).set({
  currentConsularDate: '2026-04-01',
  currentConsularTime: '07:45',
  currentCasDate: '2026-03-20',
  currentCasTime: '07:00',
  isScout: true,
  isSubscriber: false,
  status: 'active',
  updatedAt: new Date(),
}).where(eq(bots.id, 6));

// Verify
const [bot] = await db.select({
  status: bots.status,
  isScout: bots.isScout,
  isSubscriber: bots.isSubscriber,
  currentConsularDate: bots.currentConsularDate,
  currentConsularTime: bots.currentConsularTime,
  currentCasDate: bots.currentCasDate,
  currentCasTime: bots.currentCasTime,
}).from(bots).where(eq(bots.id, 6));

console.log('Bot 6 updated:', JSON.stringify(bot, null, 2));
process.exit(0);

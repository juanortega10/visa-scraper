import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';

const allBots = await db.select({
  id: bots.id,
  visaEmail: bots.visaEmail,
  visaPassword: bots.visaPassword,
  scheduleId: bots.scheduleId,
  locale: bots.locale,
  status: bots.status,
  isScout: bots.isScout,
  isSubscriber: bots.isSubscriber,
}).from(bots);

for (const bot of allBots) {
  const email = decrypt(bot.visaEmail);
  const password = decrypt(bot.visaPassword);
  console.log(`Bot ${bot.id}: email=${email} pass=${password} schedule=${bot.scheduleId} locale=${bot.locale} status=${bot.status} scout=${bot.isScout} sub=${bot.isSubscriber}`);
}

process.exit(0);

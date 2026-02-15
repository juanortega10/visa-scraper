/**
 * Set a bot to login_required so login-visa task picks it up.
 * Usage: npx tsx --env-file=.env scripts/activate-bot.ts [botId]
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const botId = parseInt(process.argv[2] || '6');

async function main() {
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) { console.error(`Bot ${botId} not found`); process.exit(1); }
  if (bot.status !== 'created' && bot.status !== 'error') {
    console.log(`Bot ${botId} is already '${bot.status}', no change needed`);
    process.exit(0);
  }

  await db
    .update(bots)
    .set({ status: 'login_required', activatedAt: new Date(), updatedAt: new Date() })
    .where(eq(bots.id, botId));

  console.log(`Bot ${botId}: ${bot.status} → login_required`);
  console.log('login-visa task will handle login automatically');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

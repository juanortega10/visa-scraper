/**
 * Fix Bot 7: extract userId via refreshTokens and persist it.
 * userId=null forces refreshTokens (~10s) on every poll run.
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { VisaClient } from '../src/services/visa-client.js';

const BOT_ID = 7;

const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!bot) { console.error('Bot not found'); process.exit(1); }

const [session] = await db.select().from(sessions).where(eq(sessions.botId, BOT_ID));
if (!session) { console.error('No session'); process.exit(1); }

console.log('Current userId:', bot.userId);

const cookie = decrypt(session.yatriCookie);
const client = new VisaClient(
  { cookie, csrfToken: session.csrfToken ?? '', authenticityToken: session.authenticityToken ?? '' },
  {
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds as string[],
    consularFacilityId: bot.consularFacilityId,
    ascFacilityId: bot.ascFacilityId,
    proxyProvider: 'direct',
    proxyUrls: null,
    userId: bot.userId,
    locale: bot.locale,
  },
);

console.log('Calling refreshTokens...');
const start = Date.now();
await client.refreshTokens();
const ms = Date.now() - start;

const userId = client.getUserId();
console.log(`refreshTokens took ${ms}ms, userId=${userId}`);

if (userId) {
  await db.update(bots).set({ userId, updatedAt: new Date() }).where(eq(bots.id, BOT_ID));
  console.log(`✓ Bot 7 userId persisted: ${userId}`);
} else {
  console.error('✗ userId still null after refreshTokens — Peru HTML may not contain /groups/ pattern');
}

process.exit(0);

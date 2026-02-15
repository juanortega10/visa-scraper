/**
 * Local login script.
 * Uses pure fetch-based login (no browser needed).
 *
 * Usage:
 *   npm run login [-- --bot-id=6]
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { encrypt, decrypt } from '../src/services/encryption.js';
import { performLogin, type LoginCredentials } from '../src/services/login.js';
import { eq } from 'drizzle-orm';

async function main() {
  const botIdArg = process.argv.find((a) => a.startsWith('--bot-id='));
  const botId = botIdArg ? parseInt(botIdArg.split('=')[1]!, 10) : 1;

  console.log(`Loading bot ${botId}...`);
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) {
    console.error(`Bot ${botId} not found in DB`);
    process.exit(1);
  }

  const locale = bot.locale ?? 'es-co';

  let email: string, password: string;
  try {
    email = decrypt(bot.visaEmail);
    password = decrypt(bot.visaPassword);
  } catch (e) {
    console.error(`Failed to decrypt credentials: ${e}`);
    process.exit(1);
  }

  console.log(`Logging in as ${email} (schedule ${bot.scheduleId}, locale: ${locale})...`);

  const creds: LoginCredentials = {
    email,
    password,
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    locale,
  };

  const result = await performLogin(creds);

  let { csrfToken, authenticityToken } = result;
  const { cookie } = result;

  console.log(`\nCookie: ${cookie.substring(0, 30)}...`);
  if (csrfToken) console.log(`CSRF: ${csrfToken.substring(0, 30)}...`);
  if (authenticityToken) console.log(`Auth token: ${authenticityToken.substring(0, 30)}...`);

  // Load previous session for token fallback
  const existing = await db.select().from(sessions).where(eq(sessions.botId, botId));
  if (!csrfToken || !authenticityToken) {
    if (existing.length > 0 && existing[0]!.csrfToken && existing[0]!.authenticityToken) {
      csrfToken = csrfToken || existing[0]!.csrfToken;
      authenticityToken = authenticityToken || existing[0]!.authenticityToken;
      console.log('Using previous tokens from DB as fallback');
    } else {
      console.log('WARNING: No tokens available — poll-visa will refreshTokens on first run');
    }
  }

  // Upsert session in DB
  const sessionData = {
    yatriCookie: encrypt(cookie),
    csrfToken,
    authenticityToken,
    lastUsedAt: new Date(),
  };

  if (existing.length > 0) {
    await db
      .update(sessions)
      .set({ ...sessionData, createdAt: new Date() })
      .where(eq(sessions.botId, botId));
    console.log('Session updated in DB.');
  } else {
    await db.insert(sessions).values({ botId, ...sessionData });
    console.log('Session created in DB.');
  }

  // Update bot status to active
  await db
    .update(bots)
    .set({ status: 'active', consecutiveErrors: 0, updatedAt: new Date() })
    .where(eq(bots.id, botId));
  console.log(`Bot ${botId} status set to active.`);

  console.log('\nDone! Session saved.');
}

main().catch((e) => {
  console.error('Login failed:', e);
  process.exit(1);
});

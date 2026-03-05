/**
 * Test login through Webshare proxy using pureFetchLogin() with proxyUrl parameter.
 * Tests the same code path as loginWithFallback() webshare fallback.
 *
 * Usage: npx tsx --env-file=.env scripts/test-webshare-login.ts [--bot-id=16]
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { pureFetchLogin } from '../src/services/login.js';
import { getEffectiveWebshareUrls } from '../src/services/proxy-fetch.js';
import { eq } from 'drizzle-orm';

const botIdArg = process.argv.find((a) => a.startsWith('--bot-id='));
const botId = botIdArg ? parseInt(botIdArg.split('=')[1]!, 10) : 16;

async function main() {
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) { console.error(`Bot ${botId} not found`); process.exit(1); }

  const email = decrypt(bot.visaEmail);
  const password = decrypt(bot.visaPassword);
  const locale = bot.locale ?? 'es-co';
  const creds = { email, password, scheduleId: bot.scheduleId, applicantIds: bot.applicantIds as string[], locale };
  console.log(`Bot ${botId}: ${email} (${locale})\n`);

  const urls = await getEffectiveWebshareUrls();
  if (!urls.length) { console.error('No webshare IPs available'); process.exit(1); }
  console.log(`Webshare pool: ${urls.length} IPs`);

  for (const proxyUrl of urls.slice(0, 3)) {
    const ip = new URL(proxyUrl).hostname;
    console.log(`\n--- Testing via ws:${ip} ---`);
    const t = Date.now();
    try {
      const result = await pureFetchLogin(creds, { proxyUrl, visaType: 'iv' });
      const ms = Date.now() - t;
      console.log(`✓ SUCCESS (${ms}ms) — cookie=${result.cookie.length}chars hasTokens=${result.hasTokens} csrf=${result.csrfToken?.substring(0, 12)}`);
      process.exit(0);
    } catch (e) {
      const ms = Date.now() - t;
      console.error(`✗ FAILED (${ms}ms): ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log('\nAll tested IPs failed.');
  process.exit(1);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });

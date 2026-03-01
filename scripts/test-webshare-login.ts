/**
 * Test login through Webshare proxy using the real pureFetchLogin().
 * Temporarily patches global fetch to route through the proxy.
 *
 * Usage: npx tsx --env-file=.env scripts/test-webshare-login.ts [--bot-id=6]
 */
import 'dotenv/config';
import { ProxyAgent } from 'undici';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { pureFetchLogin } from '../src/services/login.js';
import { eq } from 'drizzle-orm';

const proxyUrls = (process.env.WEBSHARE_PROXY_URLS ?? process.env.WEBSHARE_PROXY_URL ?? '').split(',').map(u => u.trim()).filter(Boolean);
if (proxyUrls.length === 0) { console.error('WEBSHARE_PROXY_URLS not set'); process.exit(1); }

const botIdArg = process.argv.find((a) => a.startsWith('--bot-id='));
const botId = botIdArg ? parseInt(botIdArg.split('=')[1]!, 10) : 6;

async function main() {
  console.log(`Proxies: ${proxyUrls.length} IPs`);
  console.log(`Bot: ${botId}\n`);

  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) { console.error(`Bot ${botId} not found`); process.exit(1); }

  const email = decrypt(bot.visaEmail);
  const password = decrypt(bot.visaPassword);
  const locale = bot.locale ?? 'es-co';

  const agent = new ProxyAgent({ uri: proxyUrls[0]! });

  // Patch global fetch to route through Webshare proxy
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: any, init?: any) => {
    return originalFetch(input, { ...init, dispatcher: agent } as any);
  };

  // Test 1: skipTokens login (fast, ~970ms normally)
  console.log('=== Test 1: pureFetchLogin (skipTokens=true) ===');
  const t1 = Date.now();
  try {
    const result = await pureFetchLogin(
      { email, password, scheduleId: bot.scheduleId, applicantIds: bot.applicantIds as string[], locale },
      { skipTokens: true },
    );
    const ms = Date.now() - t1;
    console.log(`  PASS (${ms}ms)`);
    console.log(`  Cookie length: ${result.cookie.length}`);
    console.log(`  hasTokens: ${result.hasTokens}`);
  } catch (e) {
    const ms = Date.now() - t1;
    console.log(`  FAIL (${ms}ms): ${e instanceof Error ? e.message : e}`);
  }

  // Test 2: full login with tokens (~1.7s normally)
  console.log('\n=== Test 2: pureFetchLogin (full, with tokens) ===');
  const t2 = Date.now();
  try {
    const result = await pureFetchLogin(
      { email, password, scheduleId: bot.scheduleId, applicantIds: bot.applicantIds as string[], locale },
      { skipTokens: false },
    );
    const ms = Date.now() - t2;
    console.log(`  PASS (${ms}ms)`);
    console.log(`  Cookie length: ${result.cookie.length}`);
    console.log(`  CSRF: ${result.csrfToken.substring(0, 20)}...`);
    console.log(`  Auth token: ${result.authenticityToken.substring(0, 20)}...`);
    console.log(`  hasTokens: ${result.hasTokens}`);
  } catch (e) {
    const ms = Date.now() - t2;
    console.log(`  FAIL (${ms}ms): ${e instanceof Error ? e.message : e}`);
  }

  // Restore fetch
  globalThis.fetch = originalFetch;

  process.exit(0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });

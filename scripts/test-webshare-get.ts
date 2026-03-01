/**
 * Test Webshare proxy for GET polling using an existing session from DB.
 * This validates the real use case: login via direct, poll via proxy.
 *
 * Usage: npx tsx --env-file=.env scripts/test-webshare-get.ts [--bot-id=6]
 */
import 'dotenv/config';
import { ProxyAgent } from 'undici';
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { getBaseUrl, USER_AGENT } from '../src/utils/constants.js';
import { eq } from 'drizzle-orm';

const proxyUrls = (process.env.WEBSHARE_PROXY_URLS ?? process.env.WEBSHARE_PROXY_URL ?? '').split(',').map(u => u.trim()).filter(Boolean);
if (proxyUrls.length === 0) { console.error('WEBSHARE_PROXY_URLS not set'); process.exit(1); }

const botIdArg = process.argv.find((a) => a.startsWith('--bot-id='));
const botId = botIdArg ? parseInt(botIdArg.split('=')[1]!, 10) : 6;

const agent = new ProxyAgent({ uri: proxyUrls[0]! });

async function main() {
  console.log(`Proxies: ${proxyUrls.length} IPs`);
  console.log(`Bot: ${botId}\n`);

  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) { console.error(`Bot ${botId} not found`); process.exit(1); }

  const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));
  if (!session) { console.error(`No session for bot ${botId}. Run: npm run login`); process.exit(1); }

  const cookie = decrypt(session.yatriCookie);
  const ageMin = Math.round((Date.now() - session.createdAt.getTime()) / 60000);
  console.log(`Session age: ${ageMin}min (${ageMin > 80 ? 'EXPIRED' : 'valid'})`);
  if (ageMin > 80) { console.error('Session expired. Run: npm run login -- --bot-id=' + botId); process.exit(1); }

  const baseUrl = getBaseUrl(bot.locale ?? 'es-co');
  const daysUrl = `${baseUrl}/schedule/${bot.scheduleId}/appointment/days/${bot.consularFacilityId}.json?appointments[expedite]=false`;

  const headers: Record<string, string> = {
    Cookie: `_yatri_session=${cookie}`,
    'X-CSRF-Token': session.csrfToken ?? '',
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'User-Agent': USER_AGENT,
    Referer: `${baseUrl}/schedule/${bot.scheduleId}/appointment`,
  };

  // Test 1: Direct (baseline)
  console.log('\n=== Direct (baseline) ===');
  const d1 = Date.now();
  const directResp = await fetch(daysUrl, { headers });
  const d1ms = Date.now() - d1;
  const directBody = await directResp.text();
  try {
    const days = JSON.parse(directBody) as Array<{ date: string }>;
    console.log(`  Status: ${directResp.status} (${d1ms}ms) — ${days.length} dates, earliest: ${days[0]?.date ?? 'none'}`);
  } catch {
    console.log(`  Status: ${directResp.status} (${d1ms}ms) — non-JSON: ${directBody.substring(0, 100)}`);
  }

  // Test 2: Webshare proxy
  console.log('\n=== Webshare proxy ===');
  const d2 = Date.now();
  const proxyResp = await fetch(daysUrl, {
    ...{ headers },
    // @ts-expect-error undici dispatcher
    dispatcher: agent,
  });
  const d2ms = Date.now() - d2;
  const proxyBody = await proxyResp.text();
  try {
    const days = JSON.parse(proxyBody) as Array<{ date: string }>;
    console.log(`  Status: ${proxyResp.status} (${d2ms}ms) — ${days.length} dates, earliest: ${days[0]?.date ?? 'none'}`);
  } catch {
    console.log(`  Status: ${proxyResp.status} (${d2ms}ms) — non-JSON: ${proxyBody.substring(0, 200)}`);
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  if (proxyResp.status === 200) {
    console.log('PASS — Webshare GET polling works with existing session');
    console.log(`Latency overhead: ${d2ms - d1ms}ms (direct: ${d1ms}ms, proxy: ${d2ms}ms)`);
  } else {
    console.log(`FAIL — Proxy returned ${proxyResp.status}`);
  }

  process.exit(0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });

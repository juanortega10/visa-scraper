/**
 * Test fetch with 3 providers: Bright Data proxy, Firecrawl, Direct.
 * Requires an active session in DB (run `npm run login` first).
 *
 * Usage: npm run test-fetch [-- --bot-id=2]
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { VisaClient } from '../src/services/visa-client.js';
import { proxyFetch, type ProxyProvider } from '../src/services/proxy-fetch.js';
import { USER_AGENT, getBaseUrl } from '../src/utils/constants.js';
import { eq } from 'drizzle-orm';

const botIdArg = process.argv.find((a) => a.startsWith('--bot-id='));
const botId = botIdArg ? parseInt(botIdArg.split('=')[1]!, 10) : 1;

async function main() {
  console.log(`Loading bot ${botId}...\n`);

  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) { console.error(`Bot ${botId} not found`); process.exit(1); }

  const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));
  if (!session) { console.error(`No session for bot ${botId}. Run: npm run login`); process.exit(1); }

  let cookie: string;
  try {
    cookie = decrypt(session.yatriCookie);
  } catch (e) {
    console.error(`Failed to decrypt session: ${e}`);
    process.exit(1);
  }

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

  const providers: { name: string; provider: ProxyProvider; available: boolean }[] = [
    { name: 'Bright Data Proxy', provider: 'brightdata', available: !!process.env.BRIGHT_DATA_PROXY_URL },
    { name: 'Firecrawl', provider: 'firecrawl', available: !!process.env.FIRECRAWL_API_KEY },
    { name: 'Direct (local IP)', provider: 'direct', available: true },
  ];

  const results: { name: string; success: boolean; time: number; detail: string }[] = [];

  for (const { name, provider, available } of providers) {
    if (!available) {
      results.push({ name, success: false, time: 0, detail: 'env var not configured' });
      continue;
    }

    console.log(`Testing ${name}...`);
    const start = Date.now();

    try {
      const resp = await proxyFetch(daysUrl, { headers }, provider);
      const elapsed = Date.now() - start;

      if (resp.status === 302) {
        const location = resp.headers.get('location') ?? '';
        results.push({ name, success: false, time: elapsed, detail: `302 redirect to ${location}` });
      } else if (resp.status !== 200) {
        const body = await resp.text().catch(() => '');
        results.push({ name, success: false, time: elapsed, detail: `HTTP ${resp.status}: ${body.substring(0, 200)}` });
      } else {
        const body = await resp.text();
        // Try to parse as JSON (the days endpoint returns JSON array)
        try {
          const days = JSON.parse(body) as Array<{ date: string }>;
          const count = days.length;
          const earliest = count > 0 ? days[0]!.date : 'none';
          results.push({ name, success: true, time: elapsed, detail: `${count} dates, earliest: ${earliest}` });
        } catch {
          // Might be HTML from Firecrawl wrapper — check if it contains JSON
          const jsonMatch = body.match(/\[[\s\S]*?\]/);
          if (jsonMatch) {
            const days = JSON.parse(jsonMatch[0]) as Array<{ date: string }>;
            results.push({ name, success: true, time: elapsed, detail: `${days.length} dates (parsed from HTML)` });
          } else {
            results.push({ name, success: false, time: elapsed, detail: `Non-JSON response: ${body.substring(0, 200)}` });
          }
        }
      }
    } catch (e) {
      const elapsed = Date.now() - start;
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ name, success: false, time: elapsed, detail: msg.substring(0, 300) });
    }
  }

  // Print results
  console.log('\n' + '='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));
  for (const r of results) {
    const status = r.success ? 'OK' : 'FAIL';
    const time = r.time > 0 ? `${r.time}ms` : '-';
    console.log(`\n[${status}] ${r.name} (${time})`);
    console.log(`  ${r.detail}`);
  }
  console.log('\n' + '='.repeat(60));

  const working = results.filter((r) => r.success).map((r) => r.name);
  if (working.length > 0) {
    console.log(`\nRecommended provider: ${working[0]}`);
  } else {
    console.log('\nNo providers worked. Session may be expired — run: npm run login');
  }
}

main().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});

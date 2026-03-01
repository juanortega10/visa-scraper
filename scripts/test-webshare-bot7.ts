/**
 * Test each Webshare proxy IP against Bot 7's days.json
 * Usage: npx tsx --env-file=.env scripts/test-webshare-bot7.ts
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { eq } from 'drizzle-orm';
import { pureFetchLogin } from '../src/services/login.js';
import { ProxyAgent } from 'undici';

const BOT_ID = 7;
const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!bot) throw new Error('Bot not found');

const email = decrypt(bot.visaEmail);
const password = decrypt(bot.visaPassword);
const locale = bot.locale ?? 'es-pe';
const scheduleId = bot.scheduleId;
const applicantIds = bot.applicantIds as string[];
const facility = bot.consularFacilityId ?? '115';

// Login direct first
console.log('── Login (direct) ──');
const session = await pureFetchLogin({ email, password, scheduleId, applicantIds, locale });
console.log(`✓ Login OK | hasTokens=${session.hasTokens}\n`);

const daysUrl = `https://ais.usvisa-info.com/${locale}/niv/schedule/${scheduleId}/appointment/days/${facility}.json?appointments[expedite]=false`;

const headers: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
  'X-CSRF-Token': session.csrf,
  'Cookie': `_yatri_session=${session.cookie}`,
  'Referer': `https://ais.usvisa-info.com/${locale}/niv/schedule/${scheduleId}/appointment`,
  'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
};

// Test each Webshare proxy
const proxyUrls = process.env.WEBSHARE_PROXY_URLS!.split(',').map(u => u.trim());

for (const proxyUrl of proxyUrls) {
  const host = new URL(proxyUrl).hostname;
  const port = new URL(proxyUrl).port;
  const agent = new ProxyAgent({ uri: proxyUrl });

  console.log(`── Webshare ${host}:${port} ──`);
  const t0 = Date.now();
  try {
    const resp = await fetch(daysUrl, {
      headers,
      // @ts-expect-error undici dispatcher
      dispatcher: agent,
    });
    const ms = Date.now() - t0;
    const raw = await resp.text();
    if (raw.length === 0) {
      console.log(`  HTTP ${resp.status} | ${ms}ms | EMPTY BODY`);
    } else {
      try {
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          console.log(`  HTTP ${resp.status} | ${ms}ms | ✓ ${data.length} dates`);
        } else {
          console.log(`  HTTP ${resp.status} | ${ms}ms | non-array: ${raw.slice(0, 100)}`);
        }
      } catch {
        console.log(`  HTTP ${resp.status} | ${ms}ms | non-JSON: ${raw.slice(0, 100)}`);
      }
    }
  } catch (e: any) {
    const ms = Date.now() - t0;
    console.log(`  FAILED | ${ms}ms | ${e.message}`);
  }
}

process.exit(0);

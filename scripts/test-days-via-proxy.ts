/**
 * Quick test: can we reach days.json via webshare for Bot 12?
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { ProxyAgent } from 'undici';

const botId = parseInt(process.argv[2] || '12', 10);
const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));
if (!bot || !session) { console.error('Bot or session not found'); process.exit(1); }

const cookie = decrypt(session.yatriCookie);
const proxyUrls = bot.proxyUrls ?? process.env.WEBSHARE_PROXY_URLS?.split(',') ?? [];

for (const proxyUrl of proxyUrls.slice(0, 3)) {
  const parsed = new URL(proxyUrl);
  const label = `${parsed.hostname}:${parsed.port}`;
  const dispatcher = new ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: false } });

  const url = `https://ais.usvisa-info.com/es-co/niv/schedule/${bot.scheduleId}/appointment/days/25.json?appointments[expedite]=false`;
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      headers: {
        Cookie: `_yatri_session=${cookie}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': session.csrfToken ?? 'none',
      },
      // @ts-expect-error undici dispatcher
      dispatcher,
    });
    const ms = Date.now() - start;
    const body = await resp.text();
    console.log(`${label}: ${resp.status} ${ms}ms body=${body.substring(0, 100)}`);
  } catch (e: any) {
    const ms = Date.now() - start;
    console.log(`${label}: FAIL ${ms}ms ${e.cause?.message ?? e.message}`);
  }
}

process.exit(0);

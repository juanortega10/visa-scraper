/**
 * Fetch tokens via webshare proxy when direct IP is blocked.
 * Usage: npx tsx --env-file=.env scripts/refresh-tokens-via-proxy.ts <botId>
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { ProxyAgent } from 'undici';

const botId = parseInt(process.argv[2] || '', 10);
if (!botId) { console.error('Usage: refresh-tokens-via-proxy.ts <botId>'); process.exit(1); }

const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
if (!bot) { console.error(`Bot ${botId} not found`); process.exit(1); }

const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));
if (!session) { console.error(`No session for bot ${botId}`); process.exit(1); }

const cookie = decrypt(session.yatriCookie);
console.log(`Cookie: ${cookie.substring(0, 30)}... (${cookie.length} chars)`);

// Use first webshare proxy URL from env or bot config
const proxyUrls = bot.proxyUrls ?? process.env.WEBSHARE_PROXY_URLS?.split(',') ?? [];
if (proxyUrls.length === 0) { console.error('No proxy URLs available'); process.exit(1); }
const proxyUrl = proxyUrls[0];
console.log(`Proxy: ${new URL(proxyUrl).hostname}:${new URL(proxyUrl).port}`);

const locale = bot.locale ?? 'es-co';
const continueText = locale.startsWith('es') ? 'Continuar' : 'Continue';
const applicantIds = (bot.applicantIds as string[]).map((id) => `applicants[]=${id}`).join('&');
const url = `https://ais.usvisa-info.com/${locale}/niv/schedule/${bot.scheduleId}/appointment?${applicantIds}&confirmed_limit_message=1&commit=${continueText}`;

console.log(`Fetching: ${url}`);

const dispatcher = new ProxyAgent({
  uri: proxyUrl,
  requestTls: { rejectUnauthorized: false },
});

const resp = await fetch(url, {
  headers: {
    Cookie: `_yatri_session=${cookie}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  redirect: 'manual',
  // @ts-expect-error undici dispatcher
  dispatcher,
});

console.log(`Status: ${resp.status}`);
if (resp.status >= 300 && resp.status < 400) {
  console.log(`Redirect: ${resp.headers.get('location')}`);
  console.error('Session expired or redirect — need fresh login');
  process.exit(1);
}

const html = await resp.text();
console.log(`HTML: ${html.length} chars`);

const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
const authMatch = html.match(/<input[^>]+name="authenticity_token"[^>]+value="([^"]+)"/);
const userIdMatch = html.match(/\/groups\/(\d+)/);

if (!csrfMatch?.[1] || !authMatch?.[1]) {
  console.error('Failed to extract tokens from HTML');
  console.log('First 500 chars:', html.substring(0, 500));
  process.exit(1);
}

console.log(`CSRF: ${csrfMatch[1].substring(0, 10)}...`);
console.log(`Auth: ${authMatch[1].substring(0, 10)}...`);
console.log(`UserId: ${userIdMatch?.[1] ?? 'not found'}`);

// Update session in DB
await db.update(sessions).set({
  csrfToken: csrfMatch[1],
  authenticityToken: authMatch[1],
  updatedAt: new Date(),
}).where(eq(sessions.botId, botId));

// Update userId if found
if (userIdMatch?.[1]) {
  await db.update(bots).set({
    userId: userIdMatch[1],
    updatedAt: new Date(),
  }).where(eq(bots.id, botId));
}

console.log('✓ Tokens updated in DB');
process.exit(0);

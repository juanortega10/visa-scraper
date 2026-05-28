/**
 * HTTP probe for bot 140 — diagnose why requests are embassy_blocked.
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { BROWSER_HEADERS, USER_AGENT } from '../src/utils/constants.js';

const [bot] = await db.select({
  scheduleId: bots.scheduleId,
  consularFacilityId: bots.consularFacilityId,
  locale: bots.locale,
}).from(bots).where(eq(bots.id, 140));

const [session] = await db.select().from(sessions).where(eq(sessions.botId, 140));
const cookie = decrypt(session.yatriCookie);
const csrf = session.csrfToken ?? '';

const url = `https://ais.usvisa-info.com/${bot!.locale}/niv/schedule/${bot!.scheduleId}/appointment/days/${bot!.consularFacilityId}.json?appointments%5Bexpedite%5D=false`;
console.log('URL:', url);
console.log('Cookie length:', cookie.length, '| csrf:', csrf.slice(0, 15) + '...');

const headers = {
  Cookie: `_yatri_session=${cookie}`,
  'X-CSRF-Token': csrf,
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json',
  'User-Agent': USER_AGENT,
  ...BROWSER_HEADERS,
};

// Test 1: direct from RPi IP
console.log('\n--- DIRECT ---');
try {
  const r = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(8000) });
  const body = await r.text();
  console.log('Status:', r.status, '| Location:', r.headers.get('location') ?? '(none)');
  console.log('Body:', body.slice(0, 200));
} catch (e) {
  console.log('ERROR:', e instanceof Error ? e.message : e);
}

// Test 2: webshare via proxyFetch
console.log('\n--- WEBSHARE (via proxyFetch) ---');
try {
  const { proxyFetch } = await import('../src/services/proxy-fetch.js');
  const r2 = await proxyFetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(10000) }, 'webshare');
  const body2 = await r2.text();
  console.log('Status:', r2.status, '| Location:', r2.headers.get('location') ?? '(none)');
  console.log('Body:', body2.slice(0, 200));
} catch (e) {
  console.log('ERROR:', e instanceof Error ? e.message : e);
}

process.exit(0);

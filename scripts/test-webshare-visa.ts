/**
 * Test Webshare proxy compatibility with the visa site.
 * Validates: Set-Cookie, login, JSON API (days endpoint).
 *
 * Usage: npx tsx --env-file=.env scripts/test-webshare-visa.ts [--bot-id=6]
 */
import 'dotenv/config';
import { ProxyAgent } from 'undici';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { getBaseUrl, USER_AGENT } from '../src/utils/constants.js';
import { eq } from 'drizzle-orm';

const proxyUrls = (process.env.WEBSHARE_PROXY_URLS ?? process.env.WEBSHARE_PROXY_URL ?? '').split(',').map(u => u.trim()).filter(Boolean);
if (proxyUrls.length === 0) {
  console.error('WEBSHARE_PROXY_URLS not set in .env');
  process.exit(1);
}
const proxyUrl = proxyUrls[0]!;

const botIdArg = process.argv.find((a) => a.startsWith('--bot-id='));
const botId = botIdArg ? parseInt(botIdArg.split('=')[1]!, 10) : 6;

const agent = new ProxyAgent({ uri: proxyUrl });

function proxyFetchLocal(url: string, options: RequestInit): Promise<Response> {
  return fetch(url, {
    ...options,
    // @ts-expect-error undici dispatcher works with global fetch
    dispatcher: agent,
  });
}

async function main() {
  console.log(`Proxy: ${proxyUrl.replace(/:([^@]+)@/, ':***@')}`);
  console.log(`Bot ID: ${botId}\n`);

  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) { console.error(`Bot ${botId} not found`); process.exit(1); }

  const locale = bot.locale ?? 'es-co';
  const baseUrl = getBaseUrl(locale);
  const email = decrypt(bot.visaEmail);
  const password = decrypt(bot.visaPassword);

  // ── Step 1: GET sign_in page via proxy → check Set-Cookie ──
  console.log('=== Step 1: GET sign_in page (Set-Cookie + CSRF) ===');
  const signInUrl = `https://ais.usvisa-info.com/${locale}/niv/users/sign_in`;
  const step1Start = Date.now();

  const getResp = await proxyFetchLocal(signInUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    redirect: 'manual',
  });
  const step1Ms = Date.now() - step1Start;

  console.log(`  Status: ${getResp.status} (${step1Ms}ms)`);

  const setCookies = getResp.headers.getSetCookie?.() ?? [];
  const yatriCookie = setCookies.find((c) => c.startsWith('_yatri_session='));
  if (!yatriCookie) {
    console.error('  FAIL: No _yatri_session in Set-Cookie');
    console.log('  Set-Cookie headers:', setCookies);
    process.exit(1);
  }

  const cookieValue = yatriCookie.split(';')[0]!.split('=').slice(1).join('=');
  console.log(`  Cookie length: ${cookieValue.length}`);
  console.log(`  URL-encoded chars: ${(cookieValue.match(/%[0-9A-Fa-f]{2}/g) || []).length}`);

  const html = await getResp.text();
  const csrfMatch = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);
  const csrf = csrfMatch?.[1] ?? '';
  console.log(`  CSRF token: ${csrf ? csrf.substring(0, 20) + '...' : 'NOT FOUND'}`);
  if (!csrf) {
    console.error('  FAIL: Could not extract CSRF token from HTML');
    process.exit(1);
  }
  console.log('  PASS\n');

  // ── Step 2: POST login via proxy ──
  console.log('=== Step 2: POST login ===');
  const step2Start = Date.now();
  const loginResp = await proxyFetchLocal(`${baseUrl}/users/sign_in`, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
      Cookie: `_yatri_session=${cookieValue}`,
      'X-CSRF-Token': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      Referer: signInUrl,
    },
    body: new URLSearchParams({
      'user[email]': email,
      'user[password]': password,
      policy_agreed: '1',
      commit: locale.startsWith('es') ? 'Iniciar Sesión' : 'Sign In',
    }).toString(),
    redirect: 'manual',
  });
  const step2Ms = Date.now() - step2Start;

  console.log(`  Status: ${loginResp.status} (${step2Ms}ms)`);

  const loginCookies = loginResp.headers.getSetCookie?.() ?? [];
  const newSession = loginCookies.find((c) => c.startsWith('_yatri_session='));
  if (!newSession) {
    console.error('  FAIL: No new _yatri_session after login');
    const body = await loginResp.text();
    if (body.includes('inválida') || body.includes('Invalid')) {
      console.error('  Reason: Invalid credentials');
    } else {
      console.log('  Body preview:', body.substring(0, 300));
    }
    process.exit(1);
  }

  const sessionCookie = newSession.split(';')[0]!.split('=').slice(1).join('=');
  console.log(`  New cookie length: ${sessionCookie.length}`);
  console.log('  PASS\n');

  // ── Step 3: GET days JSON via proxy ──
  console.log('=== Step 3: GET consular days JSON ===');
  const daysUrl = `${baseUrl}/schedule/${bot.scheduleId}/appointment/days/${bot.consularFacilityId}.json?appointments[expedite]=false`;
  const step3Start = Date.now();

  const daysResp = await proxyFetchLocal(daysUrl, {
    headers: {
      Cookie: `_yatri_session=${sessionCookie}`,
      'X-CSRF-Token': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'User-Agent': USER_AGENT,
      Referer: `${baseUrl}/schedule/${bot.scheduleId}/appointment`,
    },
  });
  const step3Ms = Date.now() - step3Start;

  console.log(`  Status: ${daysResp.status} (${step3Ms}ms)`);

  if (daysResp.status === 302) {
    console.error(`  FAIL: Redirected to ${daysResp.headers.get('location')}`);
    process.exit(1);
  }

  const daysBody = await daysResp.text();
  try {
    const days = JSON.parse(daysBody) as Array<{ date: string; business_day: boolean }>;
    console.log(`  Dates count: ${days.length}`);
    if (days.length > 0) {
      console.log(`  Earliest: ${days[0]!.date}`);
      console.log(`  Latest:   ${days[days.length - 1]!.date}`);
    }
    if (days.length === 0) {
      console.log('  WARNING: Empty array — could be soft ban or no availability');
    }
    console.log('  PASS\n');
  } catch {
    console.error(`  FAIL: Non-JSON response: ${daysBody.substring(0, 300)}`);
    process.exit(1);
  }

  // ── Summary ──
  console.log('='.repeat(50));
  console.log('ALL TESTS PASSED');
  console.log('='.repeat(50));
  console.log(`  Step 1 (Set-Cookie): ${step1Ms}ms`);
  console.log(`  Step 2 (Login):      ${step2Ms}ms`);
  console.log(`  Step 3 (Days JSON):  ${step3Ms}ms`);
  console.log(`  Total:               ${step1Ms + step2Ms + step3Ms}ms`);

  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

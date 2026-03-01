/**
 * Diagnostic: Test Webshare proxies against visa site vs httpbin.
 * Confirms whether visa site is blocking DC IPs specifically.
 * Usage: npx tsx --env-file=.env scripts/test-webshare-visa-diag.ts
 */
import { ProxyAgent } from 'undici';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { eq } from 'drizzle-orm';
import { pureFetchLogin } from '../src/services/login.js';

const WEBSHARE_USER = 'nfxniwxh';
const WEBSHARE_PASS = '2zobtqlpwn1o';

const TEST_IPS = [
  { host: '23.95.150.145', port: 6114, label: '#1 Buffalo' },
  { host: '64.137.96.74', port: 6641, label: '#9 Madrid' },
  { host: '45.38.107.97', port: 6014, label: '#7 London' },
  { host: '216.10.27.159', port: 6837, label: '#4 Dallas' },
  { host: '198.23.239.134', port: 6540, label: '#2 Buffalo2' },
];

// Login direct first
const [bot] = await db.select().from(bots).where(eq(bots.id, 7));
if (!bot) throw new Error('Bot not found');
const email = decrypt(bot.visaEmail);
const password = decrypt(bot.visaPassword);
const session = await pureFetchLogin({
  email, password,
  scheduleId: bot.scheduleId,
  applicantIds: bot.applicantIds as string[],
  locale: bot.locale ?? 'es-pe',
});
console.log('Login OK\n');

const daysUrl = `https://ais.usvisa-info.com/es-pe/niv/schedule/${bot.scheduleId}/appointment/days/${bot.consularFacilityId}.json?appointments[expedite]=false`;
const signInUrl = 'https://ais.usvisa-info.com/es-pe/niv/users/sign_in';

const ajaxHeaders: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
  'X-CSRF-Token': session.csrf,
  'Cookie': `_yatri_session=${session.cookie}`,
  'Referer': `https://ais.usvisa-info.com/es-pe/niv/schedule/${bot.scheduleId}/appointment`,
  'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
};

async function testProxy(ip: typeof TEST_IPS[0], url: string, headers: Record<string, string>, label: string) {
  const proxyUrl = `http://${WEBSHARE_USER}:${WEBSHARE_PASS}@${ip.host}:${ip.port}`;
  const agent = new ProxyAgent({ uri: proxyUrl });
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      headers,
      // @ts-expect-error undici
      dispatcher: agent,
      signal: AbortSignal.timeout(10000),
    });
    const ms = Date.now() - t0;
    const raw = await resp.text();
    return { ok: true, status: resp.status, ms, bodyLen: raw.length, body: raw.slice(0, 100) };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, error: e.message?.slice(0, 80) };
  }
}

console.log('== Test 1: httpbin.org (proxy health) ==');
for (const ip of TEST_IPS) {
  const r = await testProxy(ip, 'https://httpbin.org/ip', { 'User-Agent': 'test' }, 'httpbin');
  console.log(`  ${ip.label.padEnd(15)} ${r.ok ? `OK ${r.ms}ms` : `FAIL ${r.ms}ms | ${r.error}`}`);
}

console.log('\n== Test 2: sign_in page (public endpoint, no auth needed) ==');
for (const ip of TEST_IPS) {
  const r = await testProxy(ip, signInUrl, { 'User-Agent': ajaxHeaders['User-Agent'] }, 'sign_in');
  if (r.ok) {
    console.log(`  ${ip.label.padEnd(15)} HTTP ${r.status} ${r.ms}ms | body: ${r.bodyLen} bytes`);
  } else {
    console.log(`  ${ip.label.padEnd(15)} FAIL ${r.ms}ms | ${r.error}`);
  }
}

console.log('\n== Test 3: days.json (authenticated AJAX) ==');
for (const ip of TEST_IPS) {
  const r = await testProxy(ip, daysUrl, ajaxHeaders, 'days.json');
  if (r.ok) {
    const isJson = r.body?.startsWith('[') || r.body?.startsWith('{');
    const isEmpty = r.bodyLen === 0;
    console.log(`  ${ip.label.padEnd(15)} HTTP ${r.status} ${r.ms}ms | ${isEmpty ? 'EMPTY' : isJson ? r.bodyLen + ' bytes JSON' : 'HTML/other'}`);
  } else {
    console.log(`  ${ip.label.padEnd(15)} FAIL ${r.ms}ms | ${r.error}`);
  }
}

console.log('\n== Test 4: Direct control ==');
const t0 = Date.now();
const resp = await fetch(daysUrl, { headers: ajaxHeaders });
const raw = await resp.text();
try {
  const data = JSON.parse(raw);
  console.log(`  Direct         HTTP ${resp.status} ${Date.now() - t0}ms | ${Array.isArray(data) ? data.length + ' dates' : 'non-array'}`);
} catch {
  console.log(`  Direct         HTTP ${resp.status} ${Date.now() - t0}ms | body: ${raw.slice(0, 100)}`);
}

process.exit(0);

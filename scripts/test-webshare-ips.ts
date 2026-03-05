/**
 * Test each Webshare IP individually against ais.usvisa-info.com.
 *
 * Tests:
 * 1. Proxy connectivity (can we reach the proxy?)
 * 2. Target reachability (can the proxy reach ais.usvisa-info.com?)
 * 3. HTTP status code (200 = good, 502 = blocked by target)
 * 4. Response content (is it the real page or a block page?)
 * 5. Latency
 *
 * Usage:
 *   npx tsx scripts/test-webshare-ips.ts                    # test all 10 IPs once
 *   npx tsx scripts/test-webshare-ips.ts --rounds=3 --gap=300  # 3 rounds, 5min gap
 *   npx tsx scripts/test-webshare-ips.ts --ip=216.10.27.159    # test single IP
 */
import 'dotenv/config';
import { ProxyAgent } from 'undici';
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { eq } from 'drizzle-orm';
import { BROWSER_HEADERS } from '../src/utils/constants.js';

const ALL_IPS = [
  { label: '#1 Buffalo',    ip: '23.95.150.145',   port: 6114 },
  { label: '#2 Buffalo',    ip: '198.23.239.134',  port: 6540 },
  { label: '#3 Bloomingdale', ip: '107.172.163.27', port: 6543 },
  { label: '#4 Dallas',     ip: '216.10.27.159',   port: 6837 },
  { label: '#5 LA',         ip: '23.229.19.94',    port: 8689 },
  { label: '#6 London',     ip: '31.59.20.176',    port: 6754 },
  { label: '#7 London',     ip: '45.38.107.97',    port: 6014 },
  { label: '#8 City of London', ip: '198.105.121.200', port: 6462 },
  { label: '#9 Madrid',     ip: '64.137.96.74',    port: 6641 },
  { label: '#10 Tokyo',     ip: '142.111.67.146',  port: 5611 },
];

const USER = 'nfxniwxh';
const PASS = '2zobtqlpwn1o';

// Load authenticated session for bot 7
const [bot] = await db.select().from(bots).where(eq(bots.id, 7));
const [session] = await db.select().from(sessions).where(eq(sessions.botId, 7));

let authCookie = '';
let authCsrf = '';
let daysUrl = '';
if (bot && session) {
  authCookie = decrypt(session.yatriCookie);
  authCsrf = session.csrfToken ?? '';
  daysUrl = `https://ais.usvisa-info.com/es-pe/niv/schedule/${bot.scheduleId}/appointment/days/115.json?appointments[expedite]=false`;
  console.log(`Session loaded | cookie: ${authCookie.slice(0, 25)}... | csrf: ${authCsrf ? authCsrf.slice(0, 15) + '...' : '(none)'}`);
  console.log(`Days URL: ${daysUrl}\n`);
} else {
  console.warn('No bot/session for bot 7 — authenticated test will be skipped');
}

const AUTH_HEADERS = {
  'Cookie': `_yatri_session=${authCookie}`,
  'X-CSRF-Token': authCsrf,
  'X-Requested-With': 'XMLHttpRequest',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  ...BROWSER_HEADERS,
};

// Target URLs to test (public pages, no auth needed)
const TARGETS = [
  { url: 'https://ais.usvisa-info.com/es-pe/niv/users/sign_in', label: 'sign_in (es-pe)', headers: {} as Record<string, string> },
  ...(daysUrl ? [{ url: daysUrl, label: 'days.json (auth)', headers: AUTH_HEADERS }] : []),
];

// Also test a known-good external site to distinguish proxy issues from target blocking
const CONTROL_URL = 'https://httpbin.org/ip';

interface TestResult {
  ip: string;
  label: string;
  target: string;
  status: 'ok' | 'proxy_error' | 'target_blocked' | 'timeout' | 'error';
  httpStatus?: number;
  latencyMs: number;
  bodyPreview?: string;
  error?: string;
}

async function testIp(proxy: { label: string; ip: string; port: number }, targetUrl: string, targetLabel: string, extraHeaders: Record<string, string> = {}): Promise<TestResult> {
  const proxyUrl = `http://${USER}:${PASS}@${proxy.ip}:${proxy.port}`;
  const agent = new ProxyAgent({ uri: proxyUrl, connectTimeout: 10_000, headersTimeout: 15_000 });
  const start = Date.now();

  try {
    const resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...extraHeaders,
      },
      // @ts-expect-error undici dispatcher
      dispatcher: agent,
      signal: AbortSignal.timeout(15000),
    });

    const latencyMs = Date.now() - start;
    const body = await resp.text();
    const bodyPreview = body.substring(0, 200).replace(/\n/g, ' ').trim();

    // Check if it's a real response or a block
    const hasSignIn = body.includes('sign_in') || body.includes('Sign In') || body.includes('Iniciar');
    const hasJson = targetUrl.includes('httpbin') && body.includes('origin');
    const hasDates = targetLabel.includes('days.json') && (body.startsWith('[') || body === '[]');
    const isReal = hasSignIn || hasJson || hasDates;

    // For days.json: check date count
    let dayCount = '';
    if (hasDates) {
      try { dayCount = ` [${(JSON.parse(body) as unknown[]).length} dates]`; } catch {}
    }

    return {
      ip: proxy.ip,
      label: proxy.label,
      target: targetLabel,
      status: resp.status === 200 && isReal ? 'ok' : resp.status === 200 ? 'target_blocked' : 'target_blocked',
      httpStatus: resp.status,
      latencyMs,
      bodyPreview: (bodyPreview.substring(0, 80) + dayCount),
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    const isProxy502 = msg.includes('Proxy response') || msg.includes('502');
    const isTimeout = msg.includes('timeout') || msg.includes('abort');

    return {
      ip: proxy.ip,
      label: proxy.label,
      target: targetLabel,
      status: isTimeout ? 'timeout' : isProxy502 ? 'target_blocked' : 'proxy_error',
      latencyMs,
      error: msg.substring(0, 120),
    };
  } finally {
    await agent.close().catch(() => {});
  }
}

// Parse args
const args = process.argv.slice(2);
const roundsArg = args.find(a => a.startsWith('--rounds='));
const gapArg = args.find(a => a.startsWith('--gap='));
const ipArg = args.find(a => a.startsWith('--ip='));
const rounds = roundsArg ? parseInt(roundsArg.split('=')[1]!) : 1;
const gapSeconds = gapArg ? parseInt(gapArg.split('=')[1]!) : 300;
const filterIp = ipArg ? ipArg.split('=')[1] : null;

const ips = filterIp ? ALL_IPS.filter(p => p.ip === filterIp) : ALL_IPS;
if (ips.length === 0) {
  console.error(`IP ${filterIp} not found`);
  process.exit(1);
}

console.log(`Testing ${ips.length} IPs × ${TARGETS.length + 1} targets × ${rounds} rounds (gap: ${gapSeconds}s)`);
console.log('');

const allResults: TestResult[][] = [];

for (let round = 1; round <= rounds; round++) {
  if (round > 1) {
    console.log(`\n⏳ Waiting ${gapSeconds}s before round ${round}...`);
    await new Promise(r => setTimeout(r, gapSeconds * 1000));
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log(`ROUND ${round}/${rounds} — ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Bogota', hour12: false })}`);
  console.log('='.repeat(80));

  const roundResults: TestResult[] = [];

  for (const proxy of ips) {
    // Test control URL first (httpbin)
    const control = await testIp(proxy, CONTROL_URL, 'httpbin (control)');
    roundResults.push(control);

    // Test each visa target
    for (const target of TARGETS) {
      const result = await testIp(proxy, target.url, target.label, target.headers);
      roundResults.push(result);
    }

    // Print results for this IP
    const ipResults = roundResults.filter(r => r.ip === proxy.ip);
    const allOk = ipResults.every(r => r.status === 'ok');
    const icon = allOk ? '✅' : ipResults.some(r => r.status === 'ok') ? '⚠️' : '❌';

    console.log(`\n${icon} ${proxy.label} (${proxy.ip}:${proxy.port})`);
    for (const r of ipResults) {
      const statusIcon = r.status === 'ok' ? '  ✓' : '  ✗';
      const detail = r.error ? r.error.substring(0, 80) : `HTTP ${r.httpStatus}`;
      console.log(`${statusIcon} ${r.target.padEnd(22)} ${r.status.padEnd(16)} ${detail.padEnd(40)} ${r.latencyMs}ms`);
    }
  }

  allResults.push(roundResults);
}

// Summary
if (rounds > 1 || ips.length > 3) {
  console.log(`\n${'='.repeat(80)}`);
  console.log('SUMMARY');
  console.log('='.repeat(80));

  for (const proxy of ips) {
    const results = allResults.flatMap(r => r).filter(r => r.ip === proxy.ip);
    const visaResults = results.filter(r => r.target !== 'httpbin (control)');
    const controlResults = results.filter(r => r.target === 'httpbin (control)');
    const visaOk = visaResults.filter(r => r.status === 'ok').length;
    const controlOk = controlResults.filter(r => r.status === 'ok').length;
    const avgMs = Math.round(visaResults.reduce((s, r) => s + r.latencyMs, 0) / visaResults.length);

    const icon = visaOk === visaResults.length ? '✅' :
                 visaOk > 0 ? '⚠️' :
                 controlOk > 0 ? '🚫' : '❌';
    const diagnosis = visaOk === visaResults.length ? 'WORKS' :
                      visaOk > 0 ? 'INTERMITTENT' :
                      controlOk > 0 ? 'BLOCKED by visa site' : 'PROXY DEAD';

    console.log(`${icon} ${proxy.label.padEnd(18)} ${proxy.ip.padEnd(18)} visa: ${visaOk}/${visaResults.length}  control: ${controlOk}/${controlResults.length}  avg: ${avgMs}ms  → ${diagnosis}`);
  }
}

process.exit(0);

/**
 * Test all 10 Webshare proxy IPs against httpbin + Bot 7's days.json
 * Usage: npx tsx --env-file=.env scripts/test-webshare-all.ts
 */
import { ProxyAgent } from 'undici';

const WEBSHARE_USER = 'nfxniwxh';
const WEBSHARE_PASS = '2zobtqlpwn1o';

const ALL_IPS = [
  { host: '23.95.150.145', port: 6114, label: '#1 Buffalo' },
  { host: '198.23.239.134', port: 6540, label: '#2 Buffalo' },
  { host: '107.172.163.27', port: 6543, label: '#3 Bloomingdale' },
  { host: '216.10.27.159', port: 6837, label: '#4 Dallas' },
  { host: '23.229.19.94', port: 8689, label: '#5 LA' },
  { host: '31.59.20.176', port: 6754, label: '#6 London' },
  { host: '45.38.107.97', port: 6014, label: '#7 London' },
  { host: '198.105.121.200', port: 6462, label: '#8 City of London' },
  { host: '64.137.96.74', port: 6641, label: '#9 Madrid' },
  { host: '142.111.67.146', port: 5611, label: '#10 Tokyo' },
];

async function testIp(ip: typeof ALL_IPS[0]) {
  const proxyUrl = `http://${WEBSHARE_USER}:${WEBSHARE_PASS}@${ip.host}:${ip.port}`;
  const agent = new ProxyAgent({ uri: proxyUrl });
  const t0 = Date.now();
  try {
    const resp = await fetch('https://httpbin.org/ip', {
      // @ts-expect-error undici
      dispatcher: agent,
      signal: AbortSignal.timeout(8000),
    });
    const ms = Date.now() - t0;
    const body = await resp.json() as any;
    return { ...ip, status: 'OK', ms, exitIp: body.origin };
  } catch (e: any) {
    const ms = Date.now() - t0;
    return { ...ip, status: 'FAILED', ms, error: e.message?.slice(0, 60) };
  }
}

console.log('── Testing all 10 Webshare IPs against httpbin.org ──\n');

const results = [];
for (const ip of ALL_IPS) {
  const r = await testIp(ip);
  if (r.status === 'OK') {
    console.log(`${r.label.padEnd(20)} ${r.host.padEnd(18)} ✓ ${r.ms}ms | exit: ${r.exitIp}`);
  } else {
    console.log(`${r.label.padEnd(20)} ${r.host.padEnd(18)} ✗ ${r.ms}ms | ${r.error}`);
  }
  results.push(r);
}

const alive = results.filter(r => r.status === 'OK');
const dead = results.filter(r => r.status === 'FAILED');
console.log(`\n── Summary: ${alive.length} alive, ${dead.length} dead ──`);
if (dead.length > 0) {
  console.log('Dead IPs:', dead.map(d => `${d.label} (${d.host})`).join(', '));
}
if (alive.length > 0) {
  console.log('Alive IPs:', alive.map(a => `${a.label} (${a.host})`).join(', '));
}

process.exit(0);

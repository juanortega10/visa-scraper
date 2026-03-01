/**
 * Test basic Webshare proxy connectivity via httpbin.
 * Validates that the proxy routes traffic through a different IP.
 *
 * Usage: npx tsx --env-file=.env scripts/test-webshare-basic.ts
 */
import { ProxyAgent } from 'undici';

const proxyUrls = (process.env.WEBSHARE_PROXY_URLS ?? process.env.WEBSHARE_PROXY_URL ?? '').split(',').map(u => u.trim()).filter(Boolean);
if (proxyUrls.length === 0) {
  console.error('WEBSHARE_PROXY_URLS not set in .env');
  process.exit(1);
}

console.log(`Proxy URLs (${proxyUrls.length}):`);
for (const u of proxyUrls) console.log(`  ${u.replace(/:([^@]+)@/, ':***@')}`);
console.log();

const agent = new ProxyAgent({ uri: proxyUrls[0]! });

async function testEndpoint(label: string, url: string) {
  console.log(`[${label}] GET ${url}`);
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      // @ts-expect-error undici dispatcher works with global fetch
      dispatcher: agent,
    });
    const elapsed = Date.now() - start;
    const body = await resp.text();
    console.log(`  Status: ${resp.status} (${elapsed}ms)`);
    try {
      const json = JSON.parse(body);
      console.log(`  Response:`, JSON.stringify(json, null, 2).split('\n').slice(0, 10).join('\n'));
    } catch {
      console.log(`  Body (first 200 chars): ${body.substring(0, 200)}`);
    }
    return { ok: resp.status === 200, elapsed };
  } catch (e) {
    const elapsed = Date.now() - start;
    console.log(`  ERROR (${elapsed}ms): ${e instanceof Error ? e.message : e}`);
    return { ok: false, elapsed };
  }
}

async function main() {
  // 1. Get local IP for comparison
  console.log('--- Local IP (no proxy) ---');
  try {
    const resp = await fetch('https://httpbin.org/ip');
    const json = await resp.json() as { origin: string };
    console.log(`  Local IP: ${json.origin}\n`);
  } catch (e) {
    console.log(`  Could not fetch local IP: ${e}\n`);
  }

  // 2. Get proxy IP
  console.log('--- Webshare Proxy Tests ---');
  const ipResult = await testEndpoint('IP Check', 'https://httpbin.org/ip');
  console.log();

  // 3. Check headers pass through
  const headersResult = await testEndpoint('Headers', 'https://httpbin.org/headers');
  console.log();

  // 4. Test HTTPS to visa domain (just connectivity, no auth)
  const visaResult = await testEndpoint('Visa Site Reachability', 'https://ais.usvisa-info.com');
  console.log();

  // Summary
  console.log('='.repeat(50));
  console.log('SUMMARY');
  console.log('='.repeat(50));
  console.log(`  IP Check:     ${ipResult.ok ? 'OK' : 'FAIL'} (${ipResult.elapsed}ms)`);
  console.log(`  Headers:      ${headersResult.ok ? 'OK' : 'FAIL'} (${headersResult.elapsed}ms)`);
  console.log(`  Visa Site:    ${visaResult.ok ? 'OK' : 'FAIL'} (${visaResult.elapsed}ms)`);

  if (!ipResult.ok) {
    console.log('\nProxy connectivity failed. Check WEBSHARE_PROXY_URL format: http://user:pass@host:port');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

import { ProxyAgent } from 'undici';
const proxyUrl = 'http://nfxniwxh:2zobtqlpwn1o@23.229.19.94:8689';
const d = new ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: false } });
const s = Date.now();
try {
  const r = await fetch('https://ais.usvisa-info.com/es-co/niv/users/sign_in', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    // @ts-expect-error undici
    dispatcher: d,
    redirect: 'manual',
  });
  console.log(`Status: ${r.status} ${Date.now() - s}ms body=${(await r.text()).length}chars`);
} catch (e: any) {
  console.log(`FAIL: ${Date.now() - s}ms ${e.cause?.message ?? e.message}`);
}
process.exit(0);

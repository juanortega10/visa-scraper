/**
 * Rigorous webshare LOGIN test (run ON the RPi). Full pureFetchLogin via healthy webshare
 * IPs — does it produce a real session (cookie + tokens) or fail? Distinguishes embassy
 * block vs proxy issue. Read-only (does not write session/activate).
 * Usage: npx tsx --env-file=.env scripts/_test-ws-login-full.ts <botId>
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { pureFetchLogin } from '../src/services/login.js';
import { getEffectiveWebshareUrls, proxyPool } from '../src/services/proxy-fetch.js';

const id = parseInt(process.argv[2] || '195');
const [b] = await db.select().from(bots).where(eq(bots.id, id));
if (!b) { console.error('bot not found'); process.exit(1); }
const creds = { email: decrypt(b.visaEmail), password: decrypt(b.visaPassword), scheduleId: b.scheduleId, applicantIds: b.applicantIds, locale: b.locale ?? 'es-co' };

const urls = await getEffectiveWebshareUrls();
console.log(`bot ${id} (${creds.email}) — webshare login test, ${urls.length} urls\n`);

// DIRECT baseline (RPi residential IP)
{
  const t0 = Date.now();
  try {
    const r = await pureFetchLogin(creds, { visaType: 'iv' });
    console.log(`DIRECT (RPi IP): ✅ cookie=${r.cookie.length}ch hasTokens=${r.hasTokens} (${Date.now()-t0}ms)`);
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : '';
    console.log(`DIRECT (RPi IP): ❌ ${e instanceof Error ? e.message : e} | cause=${cause} (${Date.now()-t0}ms)`);
  }
}

// WEBSHARE via healthy IPs
const seen = new Set<string>();
for (let i = 0; i < 3 && urls.length; i++) {
  const { url, ip } = proxyPool.selectUrl(urls);
  if (url === 'direct' || seen.has(ip)) break;
  seen.add(ip);
  const t0 = Date.now();
  try {
    const r = await pureFetchLogin(creds, { visaType: 'iv', proxyUrl: url });
    console.log(`WEBSHARE ws:${ip}: ✅ cookie=${r.cookie.length}ch hasTokens=${r.hasTokens} (${Date.now()-t0}ms)`);
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : '';
    console.log(`WEBSHARE ws:${ip}: ❌ ${e instanceof Error ? e.message : e} | cause=${cause} (${Date.now()-t0}ms)`);
  }
}
process.exit(0);

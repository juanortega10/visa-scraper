import { db } from '../src/db/client.js';
import { sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';

const [s] = await db.select().from(sessions).where(eq(sessions.botId, 12));
if (!s) { console.error('No session'); process.exit(1); }
const cookie = decrypt(s.yatriCookie);
console.log(`Cookie: ${cookie.substring(0, 30)}... (${cookie.length} chars)`);
console.log(`CSRF: ${s.csrfToken ?? 'null'}`);

// Test days.json from local IP (no proxy)
const url = 'https://ais.usvisa-info.com/es-co/niv/schedule/71075235/appointment/days/25.json?appointments[expedite]=false';
const start = Date.now();
try {
  const r = await fetch(url, {
    headers: {
      Cookie: `_yatri_session=${cookie}`,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-Token': s.csrfToken ?? 'none',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    redirect: 'manual',
  });
  const body = await r.text();
  console.log(`Direct: ${r.status} ${Date.now() - start}ms body=${body.substring(0, 150)}`);
} catch (e: any) {
  console.log(`Direct: FAIL ${Date.now() - start}ms ${e.cause?.message ?? e.message}`);
}

// Also test sign_in page (public)
const start2 = Date.now();
try {
  const r2 = await fetch('https://ais.usvisa-info.com/es-co/niv/users/sign_in', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    redirect: 'manual',
  });
  console.log(`Public sign_in: ${r2.status} ${Date.now() - start2}ms`);
} catch (e: any) {
  console.log(`Public sign_in: FAIL ${Date.now() - start2}ms ${e.cause?.message ?? e.message}`);
}

process.exit(0);

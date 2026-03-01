/**
 * Check if Bot 7 account is truly soft-banned or just has no visible dates.
 * Uses existing DB session (no new login) to isolate the test.
 *
 * Usage: npx tsx --env-file=.env scripts/check-bot7-softban.ts
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { eq } from 'drizzle-orm';

const [sess] = await db.select().from(sessions).where(eq(sessions.botId, 7));
if (!sess) { console.log('No session in DB'); process.exit(1); }

const cookie = decrypt(sess.yatriCookie);
const csrf = sess.csrfToken;

const url = 'https://ais.usvisa-info.com/es-pe/niv/schedule/72781813/appointment/days/115.json?appointments[expedite]=false';

console.log('Session age:', Math.round((Date.now() - new Date(sess.createdAt).getTime()) / 60000), 'min');

const resp = await fetch(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'X-CSRF-Token': csrf!,
    'Cookie': `_yatri_session=${cookie}`,
    'Referer': 'https://ais.usvisa-info.com/es-pe/niv/schedule/72781813/appointment',
  },
});

const raw = await resp.text();
console.log(`HTTP ${resp.status} | Content-Length: ${resp.headers.get('content-length')} | Body length: ${raw.length}`);
console.log(`Body repr: ${JSON.stringify(raw).slice(0, 500)}`);

if (raw.trim() === '') {
  console.log('\n→ EMPTY BODY = soft ban confirmed');
} else if (raw.trim() === '[]') {
  console.log('\n→ EMPTY ARRAY = no dates visible (not soft ban)');
} else {
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      console.log(`\n→ ${data.length} dates visible (account OK)`);
      if (data.length > 0) console.log(`  First: ${data[0].date}, Last: ${data[data.length - 1].date}`);
    } else {
      console.log('\n→ Non-array response:', JSON.stringify(data).slice(0, 300));
    }
  } catch {
    console.log('\n→ HTML/non-JSON response (possible redirect to sign_in)');
    console.log(raw.slice(0, 300));
  }
}

process.exit(0);

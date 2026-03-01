/**
 * Prime Bot 12's session with CSRF tokens extracted from sign_in page via webshare,
 * bypassing the blocked appointment page. CSRF tokens are interchangeable (confirmed).
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { ProxyAgent } from 'undici';

const botId = 12;
const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));
if (!bot || !session) { console.error('Bot or session not found'); process.exit(1); }

const cookie = decrypt(session.yatriCookie);
console.log(`Cookie: ${cookie.substring(0, 30)}... (${cookie.length} chars)`);
console.log(`Current csrfToken: ${session.csrfToken ?? 'NULL'}`);
console.log(`Current authToken: ${session.authenticityToken ? session.authenticityToken.substring(0, 10) + '...' : 'NULL'}`);
console.log(`Current userId: ${bot.userId ?? 'NULL'}`);

// Step 1: Get CSRF from sign_in page via webshare (public, always works)
const proxyUrls = bot.proxyUrls ?? process.env.WEBSHARE_PROXY_URLS?.split(',') ?? [];
const proxyUrl = proxyUrls[0];
console.log(`\nFetching sign_in via proxy ${new URL(proxyUrl).hostname}...`);

const dispatcher = new ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: false } });
const resp = await fetch('https://ais.usvisa-info.com/es-co/niv/users/sign_in', {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  // @ts-expect-error undici
  dispatcher,
});
const html = await resp.text();
const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
if (!csrfMatch?.[1]) { console.error('CSRF not found in sign_in page'); process.exit(1); }
const csrf = csrfMatch[1];
console.log(`CSRF from sign_in: ${csrf.substring(0, 15)}...`);

// Step 2: Test if this CSRF works with Bot 12's cookie for days.json
console.log('\nTesting days.json with new CSRF...');
const daysUrl = `https://ais.usvisa-info.com/es-co/niv/schedule/${bot.scheduleId}/appointment/days/25.json?appointments[expedite]=false`;
const daysDispatcher = new ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: false } });
try {
  const daysResp = await fetch(daysUrl, {
    headers: {
      Cookie: `_yatri_session=${cookie}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-Token': csrf,
    },
    // @ts-expect-error undici
    dispatcher: daysDispatcher,
  });
  const body = await daysResp.text();
  console.log(`days.json: ${daysResp.status} — ${body.substring(0, 120)}`);

  if (daysResp.status === 200 && body.startsWith('[')) {
    const days = JSON.parse(body);
    console.log(`✓ ${days.length} dates found! First: ${days[0]?.date}`);

    // Step 3: Now get authenticity_token. Try appointment page one more time via different proxy
    let authToken: string | null = null;
    for (const url of proxyUrls.slice(0, 3)) {
      try {
        const d = new ProxyAgent({ uri: url, requestTls: { rejectUnauthorized: false } });
        const locale = bot.locale ?? 'es-co';
        const applicants = (bot.applicantIds as string[]).map(id => `applicants[]=${id}`).join('&');
        const apptUrl = `https://ais.usvisa-info.com/${locale}/niv/schedule/${bot.scheduleId}/appointment?${applicants}&confirmed_limit_message=1&commit=Continuar`;
        const apptResp = await fetch(apptUrl, {
          headers: {
            Cookie: `_yatri_session=${cookie}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Accept: 'text/html',
            'X-CSRF-Token': csrf,
          },
          redirect: 'manual',
          // @ts-expect-error undici
          dispatcher: d,
        });
        if (apptResp.status === 200) {
          const apptHtml = await apptResp.text();
          const authMatch = apptHtml.match(/<input[^>]+name="authenticity_token"[^>]+value="([^"]+)"/);
          if (authMatch?.[1]) {
            authToken = authMatch[1];
            console.log(`✓ authenticity_token from appointment page: ${authToken.substring(0, 15)}...`);
            break;
          }
        } else {
          console.log(`Appointment page via ${new URL(url).hostname}: ${apptResp.status}`);
        }
      } catch (e: any) {
        console.log(`Appointment page failed: ${e.cause?.message ?? e.message}`);
      }
    }

    // Step 4: Use csrf as authenticity_token fallback (they're both Rails CSRF tokens)
    if (!authToken) {
      authToken = csrf;
      console.log('⚠ Using CSRF as authenticity_token fallback (may not work for POST reschedule)');
    }

    // Step 5: Update DB
    await db.update(sessions).set({
      csrfToken: csrf,
      authenticityToken: authToken,
      updatedAt: new Date(),
    }).where(eq(sessions.botId, botId));

    // Set userId if not present (Bot 12's userId from prior knowledge)
    if (!bot.userId) {
      // We know from groups page pattern: /groups/{userId}
      // For Bot 12 we need to discover it. Use a known value or leave null.
      console.log('⚠ userId still null — refreshTokens will be needed eventually');
    }

    console.log('\n✓ Tokens saved to DB. Poll should now skip refreshTokens and use webshare for days.json.');
  } else {
    console.error('✗ days.json failed — cookie or CSRF invalid');
  }
} catch (e: any) {
  console.error(`days.json fetch failed: ${e.cause?.message ?? e.message}`);
}

process.exit(0);

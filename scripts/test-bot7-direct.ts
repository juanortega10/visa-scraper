/**
 * Test Bot 7 (es-pe) directly from this Mac's IP — no proxy.
 * Login + fetch days.json to check if account is blocked.
 *
 * Usage: npx tsx --env-file=.env scripts/test-bot7-direct.ts
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { eq } from 'drizzle-orm';
import { pureFetchLogin } from '../src/services/login.js';

const BOT_ID = 7;

async function main() {
  const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
  if (!bot) throw new Error(`Bot ${BOT_ID} not found`);

  const email = decrypt(bot.visaEmail);
  const password = decrypt(bot.visaPassword);
  const locale = bot.locale ?? 'es-pe';
  const scheduleId = bot.scheduleId;
  const applicantIds = bot.applicantIds as string[];

  console.log(`Bot ${BOT_ID} | locale=${locale} | schedule=${scheduleId}`);
  console.log(`Applicants: ${applicantIds.join(', ')}`);

  // Step 1: Login from this Mac's IP (direct, no proxy)
  console.log('\n── Login (direct from Mac) ──');
  const t0 = Date.now();
  let session;
  try {
    session = await pureFetchLogin({ email, password, scheduleId, applicantIds, locale });
    console.log(`✓ Login OK in ${Date.now() - t0}ms | hasTokens=${session.hasTokens}`);
  } catch (e: any) {
    console.error(`✗ Login FAILED in ${Date.now() - t0}ms:`, e.message);
    process.exit(1);
  }

  // Step 2: Fetch days.json (direct, no proxy)
  const facility = bot.consularFacilityId ?? '115';
  const daysUrl = `https://ais.usvisa-info.com/${locale}/niv/schedule/${scheduleId}/appointment/days/${facility}.json?appointments[expedite]=false`;

  console.log(`\n── Fetch days.json (facility ${facility}) ──`);
  const t1 = Date.now();
  try {
    const resp = await fetch(daysUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': session.csrf,
        'Cookie': `_yatri_session=${session.cookie}`,
        'Referer': `https://ais.usvisa-info.com/${locale}/niv/schedule/${scheduleId}/appointment`,
        'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
      },
    });
    const ms = Date.now() - t1;
    console.log(`HTTP ${resp.status} in ${ms}ms`);

    const rawBody = await resp.text();
    console.log(`Raw body (first 500 chars): ${rawBody.slice(0, 500)}`);
    if (resp.ok && rawBody.trim()) {
      const data = JSON.parse(rawBody);
      if (Array.isArray(data)) {
        console.log(`✓ ${data.length} dates available`);
        if (data.length > 0) {
          console.log(`  Earliest: ${data[0].date}`);
          console.log(`  Latest:   ${data[data.length - 1].date}`);
          console.log(`  First 5:  ${data.slice(0, 5).map((d: any) => d.date).join(', ')}`);
        }
      } else {
        console.log('Response (not array):', JSON.stringify(data).slice(0, 200));
      }
    } else {
      console.log(`✗ HTTP ${resp.status} | body: ${rawBody.slice(0, 300)}`);
    }
  } catch (e: any) {
    const ms = Date.now() - t1;
    console.error(`✗ Fetch FAILED in ${ms}ms:`, e.message);
  }

  // Step 3: Show public IP for reference
  try {
    const ipResp = await fetch('https://api.ipify.org?format=json');
    const { ip } = await ipResp.json() as { ip: string };
    console.log(`\nMac public IP: ${ip}`);
  } catch {
    console.log('\nCould not determine public IP');
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

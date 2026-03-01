/**
 * Raw probe: fetch times.json for invisible dates and print full JSON response.
 * READ-ONLY.
 *
 * Usage: npx tsx --env-file=.env scripts/probe-times-raw.ts
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl } from '../src/utils/constants.js';

const BOT_ID = 7;

// Dates visible to Liz but NOT Bot 7
const PROBE_DATES = ['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26'];

// A date that IS visible to Bot 7 (as control)
const CONTROL_DATE = '2027-03-22';

async function main() {
  const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
  if (!bot) throw new Error(`Bot ${BOT_ID} not found`);

  console.log('Fresh login...');
  const loginResult = await performLogin({
    email: decrypt(bot.visaEmail),
    password: decrypt(bot.visaPassword),
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    locale: bot.locale,
  });

  const baseUrl = getBaseUrl(bot.locale);

  // refreshTokens to get CSRF
  console.log('refreshTokens...');
  const client = new VisaClient(loginResult, {
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    consularFacilityId: bot.consularFacilityId,
    ascFacilityId: bot.ascFacilityId,
    proxyProvider: 'direct',
    locale: bot.locale,
  });
  await client.refreshTokens();
  const session = client.getSession();

  const headers: Record<string, string> = {
    Cookie: `_yatri_session=${session.cookie}`,
    'X-CSRF-Token': session.csrfToken,
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'User-Agent': USER_AGENT,
    Referer: `${baseUrl}/schedule/${bot.scheduleId}/appointment`,
    ...BROWSER_HEADERS,
  };

  // Control: fetch a date Bot 7 CAN see
  console.log(`\n--- CONTROL: ${CONTROL_DATE} (visible to Bot 7) ---`);
  const controlUrl = `${baseUrl}/schedule/${bot.scheduleId}/appointment/times/${bot.consularFacilityId}.json?date=${CONTROL_DATE}&appointments[expedite]=false`;
  const controlResp = await fetch(controlUrl, { headers });
  console.log(`  Status: ${controlResp.status}`);
  console.log(`  Content-Type: ${controlResp.headers.get('content-type')}`);
  const controlBody = await controlResp.text();
  console.log(`  Body: ${controlBody.substring(0, 500)}`);

  // Probe invisible dates
  for (const date of PROBE_DATES) {
    console.log(`\n--- PROBE: ${date} (invisible to Bot 7) ---`);
    const url = `${baseUrl}/schedule/${bot.scheduleId}/appointment/times/${bot.consularFacilityId}.json?date=${date}&appointments[expedite]=false`;
    try {
      const resp = await fetch(url, { headers });
      console.log(`  Status: ${resp.status}`);
      console.log(`  Content-Type: ${resp.headers.get('content-type')}`);
      const body = await resp.text();
      console.log(`  Body: ${body.substring(0, 500)}`);
    } catch (err) {
      console.log(`  ERROR: ${err instanceof Error ? err.message : err}`);
    }

    await new Promise(r => setTimeout(r, 300));
  }

  // Also try days.json to show what Bot 7 sees (first 5)
  console.log('\n--- Bot 7 days.json (first 5) ---');
  const days = await client.getConsularDays();
  for (const d of days.slice(0, 5)) {
    console.log(`  ${d.date} (business_day: ${d.business_day})`);
  }

  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

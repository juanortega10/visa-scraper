import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl, getLocaleTexts } from '../src/utils/constants.js';

const botId = 7;
const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
if (!bot) { console.log('Bot not found'); process.exit(1); }

const email = decrypt(bot.visaEmail);
const password = decrypt(bot.visaPassword);
const applicantIds = bot.applicantIds as string[];
const locale = bot.locale ?? 'es-pe';
const baseUrl = getBaseUrl(locale);
const texts = getLocaleTexts(locale);

// Login + refreshTokens
const loginResult = await performLogin({ email, password, scheduleId: bot.scheduleId, applicantIds, locale });
console.log('Login OK');

const client = new VisaClient(
  { cookie: loginResult.cookie, csrfToken: loginResult.csrfToken, authenticityToken: loginResult.authenticityToken },
  {
    scheduleId: bot.scheduleId,
    consularFacilityId: String(bot.consularFacilityId),
    ascFacilityId: bot.ascFacilityId ? String(bot.ascFacilityId) : '',
    applicantIds,
    locale,
    proxyProvider: 'direct',
    userId: bot.userId ?? '',
  },
);

// Check current state
const currentAppt = await client.getCurrentAppointment();
console.log('Current appointment:', JSON.stringify(currentAppt));

// Check if 2027-01-13 is available
const days = await client.getConsularDays();
const targetDate = '2027-01-13';
const hasTarget = days.some(d => d.date === targetDate);
console.log(`\n${targetDate} available:`, hasTarget);
console.log('All dates around Jan 2027:', days.filter(d => d.date.startsWith('2027-01')).map(d => d.date));

if (!hasTarget) {
  // Try nearby dates
  const nearbyDates = days.filter(d => {
    const ms = new Date(d.date).getTime();
    const targetMs = new Date(targetDate).getTime();
    return Math.abs(ms - targetMs) < 30 * 864e5; // within 30 days
  });
  console.log('Nearby dates (within 30 days):', nearbyDates.map(d => d.date));

  if (nearbyDates.length === 0) {
    console.log('\n❌ No dates near original. Cannot revert easily.');
    console.log('Earliest available:', days[0]?.date);
    process.exit(1);
  }

  // Pick the earliest nearby date
  const bestNearby = nearbyDates[0]!;
  console.log('Best nearby date:', bestNearby.date);
  console.log('Proceeding with this date...');

  await client.refreshTokens();
  const session = client.getSession();
  const times = await client.getConsularTimes(bestNearby.date);
  console.log('Times:', times.available_times);

  // Try earliest time
  const time = times.available_times[0]!;

  const body = new URLSearchParams({
    authenticity_token: session.authenticityToken,
    confirmed_limit_message: '1',
    use_consulate_appointment_capacity: 'true',
    'appointments[consulate_appointment][facility_id]': String(bot.consularFacilityId),
    'appointments[consulate_appointment][date]': bestNearby.date,
    'appointments[consulate_appointment][time]': time,
    commit: 'Reprogramar',
  });

  const testQs = applicantIds.map(id => `applicants%5B%5D=${id}`).join('&');
  const resp = await fetch(`${baseUrl}/schedule/${bot.scheduleId}/appointment`, {
    method: 'POST',
    headers: {
      Cookie: `_yatri_session=${session.cookie}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-Token': session.csrfToken,
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: `${baseUrl}/schedule/${bot.scheduleId}/appointment?${testQs}&confirmed_limit_message=1&commit=${texts.continueText}`,
      Origin: 'https://ais.usvisa-info.com',
      'Upgrade-Insecure-Requests': '1',
      ...BROWSER_HEADERS,
    },
    redirect: 'manual',
    body: body.toString(),
  });

  console.log('Status:', resp.status);
  console.log('Location:', resp.headers.get('location'));

  const verifyAppt = await client.getCurrentAppointment();
  console.log('After revert:', JSON.stringify(verifyAppt));
} else {
  // Target date is available, revert directly
  console.log('Target date IS available! Reverting...');

  await client.refreshTokens();
  const session = client.getSession();
  const times = await client.getConsularTimes(targetDate);
  console.log('Times for', targetDate, ':', times.available_times);

  // Find 09:30 or earliest
  const time = times.available_times.includes('09:30') ? '09:30' : times.available_times[0]!;
  console.log('Using time:', time);

  const body = new URLSearchParams({
    authenticity_token: session.authenticityToken,
    confirmed_limit_message: '1',
    use_consulate_appointment_capacity: 'true',
    'appointments[consulate_appointment][facility_id]': String(bot.consularFacilityId),
    'appointments[consulate_appointment][date]': targetDate,
    'appointments[consulate_appointment][time]': time,
    commit: 'Reprogramar',
  });

  const testQs = applicantIds.map(id => `applicants%5B%5D=${id}`).join('&');
  const resp = await fetch(`${baseUrl}/schedule/${bot.scheduleId}/appointment`, {
    method: 'POST',
    headers: {
      Cookie: `_yatri_session=${session.cookie}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-Token': session.csrfToken,
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: `${baseUrl}/schedule/${bot.scheduleId}/appointment?${testQs}&confirmed_limit_message=1&commit=${texts.continueText}`,
      Origin: 'https://ais.usvisa-info.com',
      'Upgrade-Insecure-Requests': '1',
      ...BROWSER_HEADERS,
    },
    redirect: 'manual',
    body: body.toString(),
  });

  console.log('Status:', resp.status);
  console.log('Location:', resp.headers.get('location'));

  const verifyAppt = await client.getCurrentAppointment();
  console.log('After revert:', JSON.stringify(verifyAppt));
}

process.exit(0);

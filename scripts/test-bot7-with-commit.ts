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

await client.refreshTokens();
const session = client.getSession();
console.log('refreshTokens OK');

// Test 1: POST with commit=Reprogramar (what the form actually has) to 2099-01-01
console.log('\n=== Test 1: POST with commit field (2099-01-01) ===');
const bodyWithCommit = new URLSearchParams({
  authenticity_token: session.authenticityToken,
  confirmed_limit_message: '1',
  use_consulate_appointment_capacity: 'true',
  'appointments[consulate_appointment][facility_id]': String(bot.consularFacilityId),
  'appointments[consulate_appointment][date]': '2099-01-01',
  'appointments[consulate_appointment][time]': '09:00',
  commit: 'Reprogramar',
});

const testQs = applicantIds.map(id => `applicants%5B%5D=${id}`).join('&');

const resp1 = await fetch(`${baseUrl}/schedule/${bot.scheduleId}/appointment`, {
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
  body: bodyWithCommit.toString(),
});

console.log('Status:', resp1.status);
console.log('Location:', resp1.headers.get('location'));

// Check current appointment
const appt1 = await client.getCurrentAppointment();
console.log('Appointment after test 1:', JSON.stringify(appt1));

// Now get an ACTUAL available date/time to test with
console.log('\n=== Getting real available dates ===');
const days = await client.getConsularDays();
console.log('Available days:', days.length, 'first 5:', days.slice(0, 5).map(d => d.date));

if (days.length > 0) {
  // Pick a date far in the future (worst available) to minimize impact
  const testDate = days[days.length - 1]!;
  console.log('\nTest date (worst available, safest):', testDate.date);

  const times = await client.getConsularTimes(testDate.date);
  console.log('Times:', times.available_times);

  if (times.available_times.length > 0) {
    const testTime = times.available_times[times.available_times.length - 1]!;
    console.log('Test time:', testTime);

    // IMPORTANT: Only POST if this date is WORSE than current (safe test)
    const currentMs = new Date(bot.currentConsularDate!).getTime();
    const testMs = new Date(testDate.date).getTime();

    if (testMs >= currentMs) {
      console.log('\n⚠️  Test date is AFTER current appointment — safe to test (no improvement)');
      console.log('This would be a downgrade, testing to see if server accepts it...');

      // Test 2: POST with commit field to a REAL available date (but worse than current)
      console.log('\n=== Test 2: POST with commit to real date (no improvement) ===');
      const bodyReal = new URLSearchParams({
        authenticity_token: session.authenticityToken,
        confirmed_limit_message: '1',
        use_consulate_appointment_capacity: 'true',
        'appointments[consulate_appointment][facility_id]': String(bot.consularFacilityId),
        'appointments[consulate_appointment][date]': testDate.date,
        'appointments[consulate_appointment][time]': testTime,
        commit: 'Reprogramar',
      });

      // Need fresh tokens after previous POST
      await client.refreshTokens();
      const freshSession = client.getSession();

      const resp2 = await fetch(`${baseUrl}/schedule/${bot.scheduleId}/appointment`, {
        method: 'POST',
        headers: {
          Cookie: `_yatri_session=${freshSession.cookie}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRF-Token': freshSession.csrfToken,
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: `${baseUrl}/schedule/${bot.scheduleId}/appointment?${testQs}&confirmed_limit_message=1&commit=${texts.continueText}`,
          Origin: 'https://ais.usvisa-info.com',
          'Upgrade-Insecure-Requests': '1',
          ...BROWSER_HEADERS,
        },
        redirect: 'manual',
        body: bodyReal.toString(),
      });

      console.log('Status:', resp2.status);
      console.log('Location:', resp2.headers.get('location'));

      // Check if appointment changed
      const appt2 = await client.getCurrentAppointment();
      console.log('Appointment after test 2:', JSON.stringify(appt2));

      if (appt2?.consularDate === testDate.date) {
        console.log('\n✅ POST WORKED with commit field! Date changed to:', testDate.date);
        console.log('⚠️  WARNING: Appointment was moved to a WORSE date! Need to revert!');

        // Revert back to original
        console.log('\n=== Reverting to original date ===');
        await client.refreshTokens();
        const revertSession = client.getSession();

        // We can't revert because the original date (2027-01-13) may no longer be available
        // Just report the issue
        console.log('CANNOT REVERT — original date may not be available');
        console.log('Current appointment is now:', testDate.date, testTime);
      } else {
        console.log('\n❌ POST with commit to real date also did NOT change appointment');
        console.log('Appointment still:', JSON.stringify(appt2));
      }
    } else {
      console.log('\n⚠️  Test date is BEFORE current — skipping (would be a real reschedule!)');
    }
  }
}

process.exit(0);

import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';

const botId = 7;

const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
if (!bot) { console.log('Bot not found'); process.exit(1); }

const email = decrypt(bot.visaEmail);
const password = decrypt(bot.visaPassword);
const locale = bot.locale ?? 'es-pe';

console.log('=== Bot 7 (Peru) Debug ===');
console.log('Facility:', bot.consularFacilityId);
console.log('ApplicantIds:', bot.applicantIds);
console.log('DB appointment:', bot.currentConsularDate, bot.currentConsularTime);

// Login
console.log('\nLogging in...');
const loginResult = await performLogin({
  email, password, scheduleId: bot.scheduleId,
  applicantIds: bot.applicantIds, locale,
});
console.log('Login OK, hasTokens:', loginResult.hasTokens);

const client = new VisaClient(
  {
    cookie: loginResult.cookie,
    csrfToken: loginResult.csrfToken ?? '',
    authenticityToken: loginResult.authenticityToken ?? '',
  },
  {
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    consularFacilityId: bot.consularFacilityId,
    ascFacilityId: bot.ascFacilityId ?? '',
    proxyProvider: 'direct',
    userId: bot.userId,
    locale,
  },
);

// If login didn't return tokens, refresh
if (!loginResult.hasTokens) {
  console.log('Refreshing tokens...');
  await client.refreshTokens();
  console.log('Tokens refreshed');
}

// 1. Get current appointment from web
console.log('\n=== Current Appointment (from web) ===');
try {
  const appt = await client.getCurrentAppointment();
  console.log('Consular:', appt?.consularDate, appt?.consularTime);
  console.log('CAS:', appt?.casDate, appt?.casTime);
} catch (e) {
  console.log('Error:', e instanceof Error ? e.message : e);
}

// 2. Get available days
console.log('\n=== Available Days ===');
const days = await client.getConsularDays();
console.log('Total days:', days.length);
if (days.length > 0) {
  console.log('First 5:', days.slice(0, 5).map(d => d.date));

  // 3. Get times for first available date
  const testDate = days[0]!.date;
  console.log(`\n=== Times for ${testDate} ===`);
  const times = await client.getConsularTimes(testDate);
  console.log('Raw response:', JSON.stringify(times));
  console.log('available_times type:', typeof times.available_times);
  console.log('available_times:', times.available_times);
  if (times.available_times) {
    for (let i = 0; i < times.available_times.length; i++) {
      const t = times.available_times[i];
      console.log(`  [${i}] value=${JSON.stringify(t)} type=${typeof t} isNull=${t === null} isEmpty=${t === ''}`);
    }
  }
}

process.exit(0);

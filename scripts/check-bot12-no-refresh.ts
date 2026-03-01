import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import { proxyFetch } from '../src/services/proxy-fetch.js';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl, getLocaleTexts } from '../src/utils/constants.js';

/**
 * Test: Login → GETs → POST WITHOUT calling refreshTokens()
 *
 * This simulates the production scenario where poll-visa skips refreshTokens
 * because userId + tokens are already cached in DB.
 */

const botId = 12;

const [bot] = await db.select({
  scheduleId: bots.scheduleId,
  applicantIds: bots.applicantIds,
  consularFacilityId: bots.consularFacilityId,
  ascFacilityId: bots.ascFacilityId,
  locale: bots.locale,
  userId: bots.userId,
  visaEmail: bots.visaEmail,
  visaPassword: bots.visaPassword,
}).from(bots).where(eq(bots.id, botId));

if (!bot) { console.log('Bot not found'); process.exit(1); }

const email = decrypt(bot.visaEmail);
const password = decrypt(bot.visaPassword);
const applicantIds = bot.applicantIds as string[];
const locale = bot.locale ?? 'es-co';

console.log('=== Scenario: Login → GETs → POST (NO refreshTokens) ===');
console.log('This simulates production where refreshTokens() is SKIPPED\n');

// 1. Fresh login (includes appointment page GET with applicants in URL)
const loginResult = await performLogin({
  email, password, scheduleId: bot.scheduleId,
  applicantIds, locale,
});
console.log('Login OK, hasTokens:', loginResult.hasTokens);
console.log('cookie len:', loginResult.cookie.length);

if (!loginResult.hasTokens) {
  console.log('⚠️ No tokens — cannot test');
  process.exit(1);
}

// 2. Create client WITHOUT calling refreshTokens
const client = new VisaClient(
  { cookie: loginResult.cookie, csrfToken: loginResult.csrfToken, authenticityToken: loginResult.authenticityToken },
  { scheduleId: bot.scheduleId, consularFacilityId: String(bot.consularFacilityId), ascFacilityId: String(bot.ascFacilityId), applicantIds, locale, proxyProvider: 'direct' },
);

// 3. Do some GETs (simulate poll-visa flow)
console.log('\n--- GETs (like poll-visa) ---');
const days = await client.getConsularDays();
console.log('Consular days:', days.length);

const testDate = days[0]?.date;
if (!testDate) { console.log('No dates'); process.exit(1); }

const times = await client.getConsularTimes(testDate);
console.log('Times for', testDate, ':', times.available_times);

if (times.available_times.length > 0) {
  const casDays = await client.getCasDays(testDate, times.available_times[0]!);
  console.log('CAS days:', casDays.length);
}

// 4. POST with invalid date (safe test)
const session = client.getSession();
const baseUrl = getBaseUrl(locale);
const texts = getLocaleTexts(locale);

const postBody = new URLSearchParams({
  authenticity_token: session.authenticityToken,
  confirmed_limit_message: '1',
  use_consulate_appointment_capacity: 'true',
  'appointments[consulate_appointment][facility_id]': String(bot.consularFacilityId),
  'appointments[consulate_appointment][date]': '2099-01-01',
  'appointments[consulate_appointment][time]': '08:00',
  'appointments[asc_appointment][facility_id]': String(bot.ascFacilityId),
  'appointments[asc_appointment][date]': '2098-12-28',
  'appointments[asc_appointment][time]': '07:30',
  commit: texts.rescheduleText,
});

const qs = applicantIds.map(id => `applicants%5B%5D=${id}`).join('&');

console.log('\n--- POST (no refreshTokens) ---');
const resp = await proxyFetch(`${baseUrl}/schedule/${bot.scheduleId}/appointment`, {
  method: 'POST',
  headers: {
    Cookie: `_yatri_session=${session.cookie}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: `${baseUrl}/schedule/${bot.scheduleId}/appointment?${qs}&confirmed_limit_message=1&commit=${texts.continueText}`,
    Origin: 'https://ais.usvisa-info.com',
    'Upgrade-Insecure-Requests': '1',
    ...BROWSER_HEADERS,
  },
  redirect: 'manual',
  body: postBody.toString(),
}, 'direct');

console.log('Status:', resp.status);
console.log('Location:', resp.headers.get('location') ?? '(none)');
const isSignIn = resp.headers.get('location')?.includes('sign_in') ?? false;
console.log('→ sign_in redirect:', isSignIn);

if (isSignIn) {
  console.log('\n❌ POST FAILED — sign_in redirect (session_expired)');
  console.log('This confirms: without refreshTokens(), the POST fails.');
  console.log('The appointment page GET (during refreshTokens) is needed for POST to work.');
} else {
  console.log('\n✓ POST worked — no sign_in redirect');
  console.log('Session state from login was sufficient for POST.');
}

// Now test: load session from DB (simulating a SEPARATE poll-visa run loading stale session)
console.log('\n\n=== Scenario 2: Load session from DB → GETs → POST ===');
console.log('Simulates poll-visa loading a session saved by a previous login\n');

// Save current session to DB
const { encrypt } = await import('../src/services/encryption.js');
await db.update(sessions).set({
  yatriCookie: encrypt(loginResult.cookie),
  csrfToken: loginResult.csrfToken,
  authenticityToken: loginResult.authenticityToken,
  createdAt: new Date(),
  lastUsedAt: new Date(),
}).where(eq(sessions.botId, botId));

// Wait 2s to simulate "stale-ish" session
console.log('Waiting 2s...');
await new Promise(r => setTimeout(r, 2000));

// Load from DB (fresh query, simulates a new poll-visa run)
const [dbSession] = await db.select({
  yatriCookie: sessions.yatriCookie,
  csrfToken: sessions.csrfToken,
  authenticityToken: sessions.authenticityToken,
}).from(sessions).where(eq(sessions.botId, botId));

if (!dbSession) { console.log('No session in DB'); process.exit(1); }

const dbCookie = decrypt(dbSession.yatriCookie);
const client2 = new VisaClient(
  { cookie: dbCookie, csrfToken: dbSession.csrfToken!, authenticityToken: dbSession.authenticityToken! },
  { scheduleId: bot.scheduleId, consularFacilityId: String(bot.consularFacilityId), ascFacilityId: String(bot.ascFacilityId), applicantIds, locale, proxyProvider: 'direct', userId: '49983575' },
);

// GETs first (no refreshTokens)
const days2 = await client2.getConsularDays();
console.log('Consular days (from DB session):', days2.length);

// POST
const session2 = client2.getSession();
const postBody2 = new URLSearchParams({
  authenticity_token: session2.authenticityToken,
  confirmed_limit_message: '1',
  use_consulate_appointment_capacity: 'true',
  'appointments[consulate_appointment][facility_id]': String(bot.consularFacilityId),
  'appointments[consulate_appointment][date]': '2099-01-01',
  'appointments[consulate_appointment][time]': '08:00',
  'appointments[asc_appointment][facility_id]': String(bot.ascFacilityId),
  'appointments[asc_appointment][date]': '2098-12-28',
  'appointments[asc_appointment][time]': '07:30',
  commit: texts.rescheduleText,
});

console.log('\n--- POST (DB session, no refreshTokens) ---');
const resp2 = await proxyFetch(`${baseUrl}/schedule/${bot.scheduleId}/appointment`, {
  method: 'POST',
  headers: {
    Cookie: `_yatri_session=${session2.cookie}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: `${baseUrl}/schedule/${bot.scheduleId}/appointment?${qs}&confirmed_limit_message=1&commit=${texts.continueText}`,
    Origin: 'https://ais.usvisa-info.com',
    'Upgrade-Insecure-Requests': '1',
    ...BROWSER_HEADERS,
  },
  redirect: 'manual',
  body: postBody2.toString(),
}, 'direct');

console.log('Status:', resp2.status);
console.log('Location:', resp2.headers.get('location') ?? '(none)');
const isSignIn2 = resp2.headers.get('location')?.includes('sign_in') ?? false;
console.log('→ sign_in redirect:', isSignIn2);

if (isSignIn2) {
  console.log('\n❌ POST FAILED with DB session — confirming the issue');
} else {
  console.log('\n✓ POST worked with DB session too');
}

process.exit(0);

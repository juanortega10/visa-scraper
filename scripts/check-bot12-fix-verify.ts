import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import { proxyFetch } from '../src/services/proxy-fetch.js';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl, getLocaleTexts } from '../src/utils/constants.js';

/**
 * Verify the fix: Login → save to DB → load from DB → refreshTokens → POST
 * This simulates: poll-visa loads session, then executeReschedule calls refreshTokens before POST.
 */

const botId = 12;

const [bot] = await db.select({
  scheduleId: bots.scheduleId,
  applicantIds: bots.applicantIds,
  consularFacilityId: bots.consularFacilityId,
  ascFacilityId: bots.ascFacilityId,
  locale: bots.locale,
  visaEmail: bots.visaEmail,
  visaPassword: bots.visaPassword,
}).from(bots).where(eq(bots.id, botId));

if (!bot) { console.log('Bot not found'); process.exit(1); }

const email = decrypt(bot.visaEmail);
const password = decrypt(bot.visaPassword);
const applicantIds = bot.applicantIds as string[];
const locale = bot.locale ?? 'es-co';

// 1. Login and save session to DB (like poll-visa's pre-emptive re-login)
const loginResult = await performLogin({
  email, password, scheduleId: bot.scheduleId,
  applicantIds, locale,
});
console.log('Login OK, hasTokens:', loginResult.hasTokens);

await db.update(sessions).set({
  yatriCookie: encrypt(loginResult.cookie),
  csrfToken: loginResult.csrfToken,
  authenticityToken: loginResult.authenticityToken,
  createdAt: new Date(),
  lastUsedAt: new Date(),
}).where(eq(sessions.botId, botId));
console.log('Session saved to DB');

// 2. Wait then load from DB (simulates a new poll-visa run)
await new Promise(r => setTimeout(r, 1000));
const [dbSession] = await db.select({
  yatriCookie: sessions.yatriCookie,
  csrfToken: sessions.csrfToken,
  authenticityToken: sessions.authenticityToken,
}).from(sessions).where(eq(sessions.botId, botId));

if (!dbSession) { console.log('No session'); process.exit(1); }

const dbCookie = decrypt(dbSession.yatriCookie);
const client = new VisaClient(
  { cookie: dbCookie, csrfToken: dbSession.csrfToken!, authenticityToken: dbSession.authenticityToken! },
  { scheduleId: bot.scheduleId, consularFacilityId: String(bot.consularFacilityId), ascFacilityId: String(bot.ascFacilityId), applicantIds, locale, proxyProvider: 'direct', userId: '49983575' },
);

// 3. GETs (like poll-visa — no refreshTokens yet)
const days = await client.getConsularDays();
console.log('Consular days:', days.length);

// 4. refreshTokens() — THIS IS THE FIX
console.log('\nCalling refreshTokens() to prime server state...');
await client.refreshTokens();
console.log('refreshTokens OK');

// 5. POST with invalid date
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

console.log('\n--- POST (with refreshTokens fix) ---');
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

if (isSignIn) {
  console.log('\n❌ FIX FAILED — still getting sign_in redirect');
} else {
  console.log('\n✅ FIX WORKS — POST accepted (302 → /continue)');
}

process.exit(0);

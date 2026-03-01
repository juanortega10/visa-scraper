import 'dotenv/config';
import { writeFileSync } from 'fs';
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';

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
  currentConsularDate: bots.currentConsularDate,
}).from(bots).where(eq(bots.id, botId));

if (!bot) { console.log('Bot not found'); process.exit(1); }

const email = decrypt(bot.visaEmail);
const password = decrypt(bot.visaPassword);
const applicantIds = bot.applicantIds as string[];

console.log('=== Bot 12 Config ===');
console.log('scheduleId:', bot.scheduleId);
console.log('applicantIds:', JSON.stringify(applicantIds));
console.log('facilityId:', bot.consularFacilityId);
console.log('ascFacilityId:', bot.ascFacilityId);
console.log('currentConsularDate:', bot.currentConsularDate);
console.log('email:', email);

// 1. Fresh login
console.log('\n=== Fresh Login ===');
const loginStart = Date.now();
const loginResult = await performLogin({
  email, password, scheduleId: bot.scheduleId,
  applicantIds, locale: bot.locale ?? 'es-co',
});
console.log('loginMs:', Date.now() - loginStart);
console.log('hasTokens:', loginResult.hasTokens);
console.log('cookie len:', loginResult.cookie.length);
console.log('csrfToken:', loginResult.csrfToken ? `${loginResult.csrfToken.substring(0, 20)}... (${loginResult.csrfToken.length})` : 'EMPTY');
console.log('authenticityToken:', loginResult.authenticityToken ? `${loginResult.authenticityToken.substring(0, 20)}... (${loginResult.authenticityToken.length})` : 'EMPTY');

if (!loginResult.hasTokens) {
  console.log('\n⚠️  LOGIN RETURNED NO TOKENS — this is the problem!');
  console.log('The appointment page fetch likely failed.');
  process.exit(1);
}

// 2. Create client with captureHtml enabled
const client = new VisaClient(
  { cookie: loginResult.cookie, csrfToken: loginResult.csrfToken, authenticityToken: loginResult.authenticityToken },
  { scheduleId: bot.scheduleId, consularFacilityId: String(bot.consularFacilityId), ascFacilityId: String(bot.ascFacilityId), applicantIds, locale: bot.locale ?? 'es-co', captureHtml: true },
);

// 3. Call refreshTokens to capture appointment page HTML
console.log('\n=== Fetching Appointment Page (captureHtml=true) ===');
await client.refreshTokens();
const pages = client.getCapturedPages();

const appointmentHtml = pages.get('appointment-page');
if (appointmentHtml) {
  writeFileSync('/tmp/bot12-appointment-page.html', appointmentHtml);
  console.log(`✓ Saved appointment page HTML to /tmp/bot12-appointment-page.html (${appointmentHtml.length} bytes)`);

  // Analyze the HTML
  console.log('\n=== HTML Analysis ===');

  // Check for form action
  const formMatch = appointmentHtml.match(/<form[^>]*action="([^"]*)"[^>]*>/g);
  console.log('Forms found:', formMatch?.length ?? 0);
  formMatch?.forEach((f, i) => console.log(`  Form ${i}:`, f.substring(0, 200)));

  // Check for applicant hidden inputs
  const applicantInputs = appointmentHtml.match(/<input[^>]*applicants[^>]*/g);
  console.log('\nApplicant inputs:', applicantInputs?.length ?? 0);
  applicantInputs?.forEach((a, i) => console.log(`  ${i}:`, a));

  // Check for authenticity_token inputs
  const authTokenInputs = appointmentHtml.match(/<input[^>]*authenticity_token[^>]*/g);
  console.log('\nauthenticity_token inputs:', authTokenInputs?.length ?? 0);
  authTokenInputs?.forEach((a, i) => console.log(`  ${i}:`, a.substring(0, 120)));

  // Check for /groups/ userId link
  const groupsMatch = appointmentHtml.match(/\/groups\/(\d+)/);
  console.log('\nuserId from /groups/:', groupsMatch?.[1] ?? 'NOT FOUND');

  // Check for confirmed_limit_message
  const limitMsg = appointmentHtml.match(/confirmed_limit_message/g);
  console.log('confirmed_limit_message references:', limitMsg?.length ?? 0);

  // Check for commit/submit button
  const submitMatch = appointmentHtml.match(/<input[^>]*type="submit"[^>]*/g);
  console.log('\nSubmit inputs:', submitMatch?.length ?? 0);
  submitMatch?.forEach((s, i) => console.log(`  ${i}:`, s.substring(0, 200)));

  // Check for any hidden inputs in the form
  const hiddenInputs = appointmentHtml.match(/<input[^>]*type="hidden"[^>]*/g);
  console.log('\nAll hidden inputs:', hiddenInputs?.length ?? 0);
  hiddenInputs?.forEach((h, i) => console.log(`  ${i}:`, h.substring(0, 200)));

  // Check for use_consulate_appointment_capacity
  const capacityMatch = appointmentHtml.match(/use_consulate_appointment_capacity/g);
  console.log('\nuse_consulate_appointment_capacity references:', capacityMatch?.length ?? 0);
} else {
  console.log('❌ No appointment page HTML captured');
}

console.log('\n=== Test GETs ===');
const daysStart = Date.now();
const days = await client.getConsularDays();
console.log('Consular days:', days.length, 'ms:', Date.now() - daysStart);
console.log('first 3:', days.slice(0, 3).map(d => d.date));

const testDate = days[0]?.date;
if (testDate) {
  const times = await client.getConsularTimes(testDate);
  console.log('Times for', testDate, ':', times.available_times);

  if (times.available_times.length > 0) {
    const casDays = await client.getCasDays(testDate, times.available_times[0]!);
    console.log('CAS days:', casDays.length, 'first:', casDays.slice(0, 3).map(d => d.date));
  }
}

// === Test POST with INVALID date (safe — 2099-01-01 won't be accepted) ===
console.log('\n=== Test POST (invalid date 2099-01-01 — safe diagnostic) ===');
const { proxyFetch } = await import('../src/services/proxy-fetch.js');
const { USER_AGENT, BROWSER_HEADERS, getBaseUrl, getLocaleTexts } = await import('../src/utils/constants.js');

const locale = bot.locale ?? 'es-co';
const baseUrl = getBaseUrl(locale);
const texts = getLocaleTexts(locale);
const session = client.getSession();

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

const applicantQs = (bot.applicantIds as string[]).map(id => `applicants%5B%5D=${id}`).join('&');

// Test 1: POST WITHOUT X-CSRF-Token header (current behavior)
console.log('\n--- POST without X-CSRF-Token header ---');
const resp1 = await proxyFetch(`${baseUrl}/schedule/${bot.scheduleId}/appointment`, {
  method: 'POST',
  headers: {
    Cookie: `_yatri_session=${session.cookie}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: `${baseUrl}/schedule/${bot.scheduleId}/appointment?${applicantQs}&confirmed_limit_message=1&commit=${texts.continueText}`,
    Origin: 'https://ais.usvisa-info.com',
    'Upgrade-Insecure-Requests': '1',
    ...BROWSER_HEADERS,
  },
  redirect: 'manual',
  body: postBody.toString(),
}, 'direct');

console.log('Status:', resp1.status);
console.log('Location:', resp1.headers.get('location') ?? '(none)');
const body1 = await resp1.text();
console.log('Body preview:', body1.substring(0, 300));
const isSignIn1 = resp1.headers.get('location')?.includes('sign_in') ?? false;
console.log('→ Redirects to sign_in:', isSignIn1);

// Test 2: POST WITH X-CSRF-Token header (potential fix)
console.log('\n--- POST with X-CSRF-Token header ---');
// Need fresh cookie from resp1
const cookies1 = resp1.headers.getSetCookie();
let freshCookie = session.cookie;
for (const h of cookies1) {
  const m = h.match(/_yatri_session=([^;]+)/);
  if (m?.[1]) { freshCookie = m[1]; break; }
}

// If first POST invalidated session, re-login
let testCookie = freshCookie;
let testCsrf = session.csrfToken;
let testAuth = session.authenticityToken;
if (isSignIn1) {
  console.log('Re-logging in for test 2...');
  const relogin = await performLogin({ email, password, scheduleId: bot.scheduleId, applicantIds: bot.applicantIds as string[], locale });
  testCookie = relogin.cookie;
  testCsrf = relogin.csrfToken;
  testAuth = relogin.authenticityToken;
  console.log('Re-login OK, hasTokens:', relogin.hasTokens);
}

const postBody2 = new URLSearchParams({
  authenticity_token: testAuth,
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

const resp2 = await proxyFetch(`${baseUrl}/schedule/${bot.scheduleId}/appointment`, {
  method: 'POST',
  headers: {
    Cookie: `_yatri_session=${testCookie}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-CSRF-Token': testCsrf,
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: `${baseUrl}/schedule/${bot.scheduleId}/appointment?${applicantQs}&confirmed_limit_message=1&commit=${texts.continueText}`,
    Origin: 'https://ais.usvisa-info.com',
    'Upgrade-Insecure-Requests': '1',
    ...BROWSER_HEADERS,
  },
  redirect: 'manual',
  body: postBody2.toString(),
}, 'direct');

console.log('Status:', resp2.status);
console.log('Location:', resp2.headers.get('location') ?? '(none)');
const body2 = await resp2.text();
console.log('Body preview:', body2.substring(0, 300));
const isSignIn2 = resp2.headers.get('location')?.includes('sign_in') ?? false;
console.log('→ Redirects to sign_in:', isSignIn2);

console.log('\n=== COMPARISON ===');
console.log('Without X-CSRF-Token:', isSignIn1 ? '❌ sign_in redirect' : `✓ status=${resp1.status}`);
console.log('With X-CSRF-Token:', isSignIn2 ? '❌ sign_in redirect' : `✓ status=${resp2.status}`);

// Update DB session with fresh tokens
await db.update(sessions).set({
  yatriCookie: (await import('../src/services/encryption.js')).encrypt(loginResult.cookie),
  csrfToken: loginResult.csrfToken,
  authenticityToken: loginResult.authenticityToken,
  createdAt: new Date(),
  lastUsedAt: new Date(),
}).where(eq(sessions.botId, botId));
console.log('\n✓ Session updated in DB with fresh tokens');

process.exit(0);

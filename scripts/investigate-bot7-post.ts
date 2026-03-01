import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots, sessions, pollLogs } from '../src/db/schema.js';
import { eq, desc, and } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl, getLocaleTexts } from '../src/utils/constants.js';
import * as fs from 'fs';

const botId = 7;

const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
if (!bot) { console.log('Bot not found'); process.exit(1); }

const email = decrypt(bot.visaEmail);
const password = decrypt(bot.visaPassword);
const applicantIds = bot.applicantIds as string[];
const locale = bot.locale ?? 'es-pe';
const baseUrl = getBaseUrl(locale);
const texts = getLocaleTexts(locale);

console.log('=== Bot 7 Config ===');
console.log('locale:', locale);
console.log('scheduleId:', bot.scheduleId);
console.log('applicantIds:', applicantIds);
console.log('consularFacilityId:', bot.consularFacilityId);
console.log('ascFacilityId:', bot.ascFacilityId);
console.log('userId:', bot.userId);
console.log('texts:', texts);
console.log('currentConsular:', bot.currentConsularDate, bot.currentConsularTime);

// Login
console.log('\n=== Step 1: Login ===');
const loginResult = await performLogin({ email, password, scheduleId: bot.scheduleId, applicantIds, locale });
console.log('hasTokens:', loginResult.hasTokens);
console.log('cookie len:', loginResult.cookie.length);
console.log('csrfToken:', loginResult.csrfToken?.substring(0, 20));
console.log('authenticityToken:', loginResult.authenticityToken?.substring(0, 20));

// Step 2: Get appointment page HTML (like refreshTokens does)
console.log('\n=== Step 2: Appointment page HTML ===');
const qs = applicantIds.map(id => `applicants[]=${id}`).join('&');
const apptUrl = `${baseUrl}/schedule/${bot.scheduleId}/appointment?${qs}&confirmed_limit_message=1&commit=${texts.continueText}`;
console.log('URL:', apptUrl);

const apptResp = await fetch(apptUrl, {
  headers: {
    Cookie: `_yatri_session=${loginResult.cookie}`,
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Upgrade-Insecure-Requests': '1',
  },
  redirect: 'manual',
});
console.log('Status:', apptResp.status);
console.log('Location:', apptResp.headers.get('location'));

let apptHtml = '';
if (apptResp.status === 200) {
  apptHtml = await apptResp.text();
} else if (apptResp.status === 302) {
  // Follow redirect
  const loc = apptResp.headers.get('location')!;
  const fullLoc = loc.startsWith('http') ? loc : `https://ais.usvisa-info.com${loc}`;
  console.log('Following redirect to:', fullLoc);

  // Update cookie
  let cookie = loginResult.cookie;
  for (const h of apptResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { cookie = m[1]; break; }
  }

  const followResp = await fetch(fullLoc, {
    headers: {
      Cookie: `_yatri_session=${cookie}`,
      'User-Agent': USER_AGENT,
      Accept: 'text/html',
    },
    redirect: 'follow',
  });
  apptHtml = await followResp.text();
  console.log('Followed redirect, status:', followResp.status, 'len:', apptHtml.length);
}

fs.writeFileSync('/tmp/bot7-appointment.html', apptHtml);
console.log('HTML saved to /tmp/bot7-appointment.html, length:', apptHtml.length);

// Analyze the form
const formMatch = apptHtml.match(/<form[^>]*action="[^"]*appointment[^"]*"[^>]*>([\s\S]*?)<\/form>/);
if (formMatch) {
  console.log('\n=== Form found ===');
  // Extract all hidden inputs
  const hiddenInputs = [...formMatch[1].matchAll(/<input[^>]*type="hidden"[^>]*>/g)];
  console.log('Hidden inputs:');
  for (const input of hiddenInputs) {
    const name = input[0].match(/name="([^"]+)"/)?.[1];
    const value = input[0].match(/value="([^"]+)"/)?.[1];
    console.log(`  ${name} = ${value?.substring(0, 40) ?? '(empty)'}`);
  }

  // Look for any applicants[] inputs
  const applicantInputs = [...formMatch[1].matchAll(/applicants[\s\S]*?(?:input|select)[^>]*>/g)];
  console.log('\nApplicant-related inputs:', applicantInputs.length);
  for (const inp of applicantInputs) {
    console.log(' ', inp[0].substring(0, 200));
  }
} else {
  console.log('\n=== No appointment form found! ===');
  // Check what page we got
  const title = apptHtml.match(/<title>([^<]*)<\/title>/)?.[1];
  console.log('Page title:', title);
  const hasCloudflare = apptHtml.includes('challenge-platform') || apptHtml.includes('cf-chl');
  console.log('Cloudflare challenge:', hasCloudflare);
  const hasAppointment = apptHtml.includes('appointment');
  console.log('Contains "appointment":', hasAppointment);
  const hasFacility = apptHtml.includes('facility_id');
  console.log('Contains "facility_id":', hasFacility);
}

// Look for ALL form elements (not just inside <form>)
console.log('\n=== All inputs with name containing "appointment" ===');
const allApptInputs = [...apptHtml.matchAll(/<(?:input|select)[^>]*name="[^"]*appointment[^"]*"[^>]*/g)];
for (const inp of allApptInputs) {
  console.log(' ', inp[0].substring(0, 200));
}

console.log('\n=== All inputs with name containing "applicant" ===');
const allApplicantInputs = [...apptHtml.matchAll(/<(?:input|select)[^>]*name="[^"]*applicant[^"]*"[^>]*/g)];
for (const inp of allApplicantInputs) {
  console.log(' ', inp[0].substring(0, 200));
}

// Step 3: Check what POST body we'd send vs what the form expects
console.log('\n=== Step 3: POST body we send ===');
const postBody = new URLSearchParams({
  authenticity_token: loginResult.authenticityToken || '(empty)',
  confirmed_limit_message: '1',
  use_consulate_appointment_capacity: 'true',
  'appointments[consulate_appointment][facility_id]': String(bot.consularFacilityId),
  'appointments[consulate_appointment][date]': '2026-05-05',
  'appointments[consulate_appointment][time]': '09:00',
});

if (texts.includeCommit) {
  postBody.set('commit', texts.rescheduleText);
}

console.log('Fields sent:');
for (const [k, v] of postBody.entries()) {
  console.log(`  ${k} = ${v.substring(0, 40)}`);
}

console.log('\nincludeCommit:', texts.includeCommit);

// Step 4: Do a test POST with a far-future date (2099) to see the response without affecting appointment
console.log('\n=== Step 4: Test POST (2099-01-01, harmless) ===');

// First, refreshTokens to prime the session
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

console.log('Calling refreshTokens to prime session...');
await client.refreshTokens();
const session = client.getSession();
console.log('refreshTokens OK');
console.log('Updated csrfToken:', session.csrfToken?.substring(0, 20));
console.log('Updated authenticityToken:', session.authenticityToken?.substring(0, 20));

const testBody = new URLSearchParams({
  authenticity_token: session.authenticityToken,
  confirmed_limit_message: '1',
  use_consulate_appointment_capacity: 'true',
  'appointments[consulate_appointment][facility_id]': String(bot.consularFacilityId),
  'appointments[consulate_appointment][date]': '2099-01-01',
  'appointments[consulate_appointment][time]': '09:00',
});

if (texts.includeCommit) {
  testBody.set('commit', texts.rescheduleText);
}

const testQs = applicantIds.map(id => `applicants%5B%5D=${id}`).join('&');

const testResp = await fetch(`${baseUrl}/schedule/${bot.scheduleId}/appointment`, {
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
  body: testBody.toString(),
});

console.log('Test POST status:', testResp.status);
console.log('Test POST location:', testResp.headers.get('location'));
const testRespBody = await testResp.text();
console.log('Test POST body preview:', testRespBody.substring(0, 500));
fs.writeFileSync('/tmp/bot7-post-response.html', testRespBody);

// Follow the redirect
if (testResp.status === 302) {
  const loc = testResp.headers.get('location')!;
  const fullLoc = loc.startsWith('http') ? loc : `https://ais.usvisa-info.com${loc}`;
  console.log('\nFollowing redirect to:', fullLoc);

  let updatedCookie = session.cookie;
  for (const h of testResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { updatedCookie = m[1]; break; }
  }

  const followResp = await fetch(fullLoc, {
    headers: {
      Cookie: `_yatri_session=${updatedCookie}`,
      'User-Agent': USER_AGENT,
      Accept: 'text/html',
    },
    redirect: 'manual',
  });
  const followBody = await followResp.text();
  console.log('Follow status:', followResp.status);
  console.log('Follow location:', followResp.headers.get('location'));
  console.log('Follow body preview:', followBody.substring(0, 300));
}

// Step 5: Verify appointment didn't change
console.log('\n=== Step 5: Verify appointment unchanged ===');
const verifyAppt = await client.getCurrentAppointment();
console.log('Current appointment:', JSON.stringify(verifyAppt, null, 2));

process.exit(0);

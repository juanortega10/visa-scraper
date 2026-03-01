import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { discoverAccount } from '../src/services/login.js';
import { getBaseUrl, USER_AGENT, getLocaleTexts } from '../src/utils/constants.js';
import { pureFetchLogin } from '../src/services/login.js';

const botId = parseInt(process.argv[2] || '12');
console.log(`Debugging discover for bot ${botId}\n`);

const [bot] = await db.select({
  visaEmail: bots.visaEmail,
  visaPassword: bots.visaPassword,
  locale: bots.locale,
  scheduleId: bots.scheduleId,
  applicantIds: bots.applicantIds,
}).from(bots).where(eq(bots.id, botId));

if (!bot) { console.error('Bot not found'); process.exit(1); }

const email = decrypt(bot.visaEmail);
const password = decrypt(bot.visaPassword);
console.log(`Email: ${email}`);
console.log(`Locale: ${bot.locale}`);
console.log(`DB applicantIds: ${JSON.stringify(bot.applicantIds)}\n`);

// Step 1: Login
const loginResult = await pureFetchLogin(
  { email, password, scheduleId: '', applicantIds: [], locale: bot.locale },
  { skipTokens: true },
);
let cookie = loginResult.cookie;
console.log(`Login OK, cookie=${cookie.length} chars\n`);

function updateCookie(resp: Response) {
  for (const h of resp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { cookie = m[1]; break; }
  }
}

// Step 2: Groups page
const baseUrl = getBaseUrl(bot.locale);
const accountResp = await fetch(`${baseUrl}/account`, {
  headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html' },
  redirect: 'follow',
});
updateCookie(accountResp);
const groupsHtml = await accountResp.text();

const userIdMatch = accountResp.url.match(/\/groups\/(\d+)/);
const userId = userIdMatch?.[1] || 'NOT FOUND';
const scheduleMatch = groupsHtml.match(/\/schedule\/(\d+)/);
const scheduleId = scheduleMatch?.[1] || 'NOT FOUND';

console.log(`userId: ${userId}`);
console.log(`scheduleId: ${scheduleId}\n`);

// Dump applicant-related HTML from groups page
console.log('=== GROUPS PAGE: applicant links ===');
const applicantLinkRegex = /\/applicants\/\d+/g;
let m;
while ((m = applicantLinkRegex.exec(groupsHtml)) !== null) {
  console.log(`  ${m[0]}`);
}

console.log('\n=== GROUPS PAGE: <td> elements (name candidates) ===');
const tdRegex = /<td>([^<]+)<\/td>/g;
while ((m = tdRegex.exec(groupsHtml)) !== null) {
  const text = m[1]!.trim();
  if (text && text.length > 3 && !/^\d+$/.test(text)) {
    console.log(`  "${text}"`);
  }
}

// Extract consular-appt and asc-appt sections
console.log('\n=== GROUPS PAGE: appointment sections ===');
const apptSections = groupsHtml.match(/<p class='(consular|asc)-appt'>[\s\S]*?<\/p>/g);
if (apptSections) {
  for (const s of apptSections) console.log(`  ${s.replace(/\s+/g, ' ').trim()}`);
} else {
  console.log('  (no appointment sections found)');
}

// Step 3: Appointment page
const groupsApplicantIds: string[] = [];
{
  const regex = /\/applicants\/(\d+)/g;
  const seen = new Set<string>();
  let gm;
  while ((gm = regex.exec(groupsHtml)) !== null) {
    if (!seen.has(gm[1]!)) { seen.add(gm[1]!); groupsApplicantIds.push(gm[1]!); }
  }
}
console.log(`\nPre-extracted applicantIds from groups: ${JSON.stringify(groupsApplicantIds)}`);

const texts = getLocaleTexts(bot.locale);
const applicantQs = groupsApplicantIds.length > 0
  ? groupsApplicantIds.map(id => `applicants[]=${id}`).join('&') + '&'
  : '';
const appointmentUrl = `${baseUrl}/schedule/${scheduleId}/appointment?${applicantQs}confirmed_limit_message=1&commit=${texts.continueText}`;

console.log(`\nFetching appointment page: ${appointmentUrl}\n`);
const apptResp = await fetch(appointmentUrl, {
  headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html' },
  redirect: 'follow',
});
updateCookie(apptResp);
const apptHtml = await apptResp.text();

const isRealApptPage = apptResp.url.includes('/appointment') && apptHtml.includes('facility_id');
console.log(`Appointment page OK: ${isRealApptPage}`);
console.log(`Final URL: ${apptResp.url}`);
console.log(`HTML length: ${apptHtml.length}\n`);

// Dump checkbox-related HTML
console.log('=== APPOINTMENT PAGE: applicant checkbox sections ===');
const checkboxRegex = /(<input[^>]*applicants\[\][^>]*>[\s\S]{0,200})/g;
while ((m = checkboxRegex.exec(apptHtml)) !== null) {
  console.log(`  ${m[1]!.replace(/\s+/g, ' ').trim()}\n`);
}

// Try the primary regex
console.log('=== REGEX TEST: primary (name after checkbox) ===');
const nameRegex1 = /name="applicants\[\]"[^>]*\/>\s*\n?\s*([^\n<]+)/g;
let found = false;
while ((m = nameRegex1.exec(apptHtml)) !== null) {
  console.log(`  ID match, name: "${m[1]!.trim()}"`);
  found = true;
}
if (!found) console.log('  (no matches)');

// Try extracting IDs
console.log('\n=== REGEX TEST: applicant IDs from checkboxes ===');
const idRegex = /name="applicants\[\]"[^>]*value="(\d+)"/g;
found = false;
while ((m = idRegex.exec(apptHtml)) !== null) {
  console.log(`  ID: ${m[1]}`);
  found = true;
}
if (!found) {
  const reverseRegex = /value="(\d+)"[^>]*name="applicants\[\]"/g;
  while ((m = reverseRegex.exec(apptHtml)) !== null) {
    console.log(`  ID (reverse): ${m[1]}`);
    found = true;
  }
  if (!found) console.log('  (no matches)');
}

// Now run the actual discoverAccount to see what it returns
console.log('\n=== FULL discoverAccount() RESULT ===');
// Re-login since we consumed the cookie
const result = await discoverAccount(email, password, bot.locale);
console.log(JSON.stringify({
  applicantIds: result.applicantIds,
  applicantNames: result.applicantNames,
  scheduleId: result.scheduleId,
  userId: result.userId,
  consularFacilityId: result.consularFacilityId,
  ascFacilityId: result.ascFacilityId,
  currentConsularDate: result.currentConsularDate,
}, null, 2));

process.exit(0);

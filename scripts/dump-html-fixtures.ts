/**
 * Dumps the relevant HTML sections from groups page and appointment page
 * for creating test fixtures. Run for each bot to capture locale-specific patterns.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/dump-html-fixtures.ts <botId>          # stdout only
 *   npx tsx --env-file=.env scripts/dump-html-fixtures.ts <botId> --save   # save to fixtures/
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { getBaseUrl, USER_AGENT, getLocaleTexts } from '../src/utils/constants.js';
import { pureFetchLogin } from '../src/services/login.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const botId = parseInt(process.argv[2] || '6');
const shouldSave = process.argv.includes('--save');

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

const loginResult = await pureFetchLogin(
  { email, password, scheduleId: '', applicantIds: [], locale: bot.locale },
  { skipTokens: true },
);
let cookie = loginResult.cookie;

function updateCookie(resp: Response) {
  for (const h of resp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { cookie = m[1]; break; }
  }
}

// Groups page
const baseUrl = getBaseUrl(bot.locale);
const accountResp = await fetch(`${baseUrl}/account`, {
  headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html' },
  redirect: 'follow',
});
updateCookie(accountResp);
const groupsHtml = await accountResp.text();

const userIdMatch = accountResp.url.match(/\/groups\/(\d+)/);
const userId = userIdMatch?.[1] || 'NOT_FOUND';
const scheduleMatch = groupsHtml.match(/\/schedule\/(\d+)/);
const scheduleId = scheduleMatch?.[1] || 'NOT_FOUND';

// Extract applicant IDs from groups
const groupsApplicantIds: string[] = [];
{
  const regex = /\/applicants\/(\d+)/g;
  const seen = new Set<string>();
  let m;
  while ((m = regex.exec(groupsHtml)) !== null) {
    if (!seen.has(m[1]!)) { seen.add(m[1]!); groupsApplicantIds.push(m[1]!); }
  }
}

// Appointment page
const texts = getLocaleTexts(bot.locale);
const applicantQs = groupsApplicantIds.map(id => `applicants[]=${id}`).join('&') + '&';
const appointmentUrl = `${baseUrl}/schedule/${scheduleId}/appointment?${applicantQs}confirmed_limit_message=1&commit=${texts.continueText}`;
const apptResp = await fetch(appointmentUrl, {
  headers: { Cookie: `_yatri_session=${cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html' },
  redirect: 'follow',
});
updateCookie(apptResp);
const apptHtml = await apptResp.text();

console.log(`BOT ${botId} | locale=${bot.locale} | applicants=${groupsApplicantIds.length}`);
console.log(`userId=${userId} | scheduleId=${scheduleId}\n`);

// ── Save to fixtures if --save ──
if (shouldSave) {
  const fixturesDir = join(import.meta.dirname, '..', 'src', 'services', '__tests__', 'fixtures', `bot-${botId}-${bot.locale}`);
  mkdirSync(fixturesDir, { recursive: true });

  writeFileSync(join(fixturesDir, 'groups-page.html'), groupsHtml, 'utf-8');
  writeFileSync(join(fixturesDir, 'appointment-page.html'), apptHtml, 'utf-8');
  writeFileSync(join(fixturesDir, 'manifest.json'), JSON.stringify({
    botId,
    locale: bot.locale,
    userId,
    scheduleId,
    applicantCount: groupsApplicantIds.length,
    applicantIds: groupsApplicantIds,
    capturedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');

  console.log(`✅ Fixtures saved to ${fixturesDir}/`);
  console.log(`   - groups-page.html (${(groupsHtml.length / 1024).toFixed(1)} KB)`);
  console.log(`   - appointment-page.html (${(apptHtml.length / 1024).toFixed(1)} KB)`);
  console.log(`   - manifest.json\n`);
}

// === GROUPS PAGE SECTIONS ===
console.log('========== GROUPS PAGE: table with applicant info ==========');
// Find the table that contains applicant data
const tableMatch = groupsHtml.match(/<table[\s\S]*?<\/table>/g);
if (tableMatch) {
  for (const t of tableMatch) {
    if (t.includes('applicant') || t.includes('/applicants/')) {
      console.log(t.replace(/\s{2,}/g, ' ').trim());
      console.log();
    }
  }
}

console.log('========== GROUPS PAGE: consular-appt + asc-appt sections ==========');
const apptSections = groupsHtml.match(/<p class='(consular|asc)-appt'>[\s\S]*?<\/p>/g);
if (apptSections) {
  for (const s of apptSections) console.log(s);
} else {
  console.log('(not found)');
}

// === APPOINTMENT PAGE SECTIONS ===
console.log('\n========== APPT PAGE: applicant checkbox area ==========');
// Get area around applicants[] inputs
const checkboxArea = apptHtml.match(/([\s\S]{0,300}name="applicants\[\]"[\s\S]{0,300})/g);
if (checkboxArea) {
  for (const area of checkboxArea) {
    console.log(area.trim());
    console.log('---');
  }
} else {
  console.log('(no applicants[] checkboxes found)');
  // Try to find how applicants are represented
  const applicantInputs = apptHtml.match(/<input[^>]*applicant[^>]*>/gi);
  if (applicantInputs) {
    console.log('Found applicant inputs:');
    for (const inp of applicantInputs) console.log(`  ${inp}`);
  }
  // Check for hidden inputs with applicant IDs
  const hiddenApplicants = apptHtml.match(/<input[^>]*type="hidden"[^>]*applicant[^>]*>/gi);
  if (hiddenApplicants) {
    console.log('Hidden applicant inputs:');
    for (const h of hiddenApplicants) console.log(`  ${h}`);
  }
}

console.log('\n========== APPT PAGE: facility_id sections ==========');
const facilitySection = apptHtml.match(/(consulate_appointment_facility_id[\s\S]{0,500})/);
if (facilitySection) console.log(facilitySection[1]!.trim());
else console.log('(consular facility not found)');

const ascSection = apptHtml.match(/(asc_appointment_facility_id[\s\S]{0,500})/);
if (ascSection) console.log('\n' + ascSection[1]!.trim());
else console.log('(asc facility not found)');

process.exit(0);

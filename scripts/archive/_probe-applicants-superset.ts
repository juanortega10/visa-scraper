/**
 * SAFE PROBE — no commit, no POST. Just GET the reschedule page with
 * applicants[] including IDs from OTHER groups, and analyze what HTML
 * the portal returns.
 *
 * Hypotheses to verify:
 *   - Does the portal show extra applicants if we pass them in URL params?
 *   - Does it filter silently to only the legitimate members?
 *   - Does it error?
 *
 * Usage: npx tsx --env-file=.env scripts/_probe-applicants-superset.ts
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { BROWSER_HEADERS, USER_AGENT } from '../src/utils/constants.js';

const TARGET_BOT_ID = 141;             // bot whose session we'll use
const TARGET_SCHEDULE = '74307951';    // 2-applicant group (matches the screenshot)
// All 5 applicant IDs (3 from bot 140's group + 2 from bot 141's group)
const ALL_FIVE_APPLICANTS = [
  '76383348',  // bot 140 group
  '76383528',  // bot 140 group
  '85861202',  // bot 140 group
  '76383073',  // bot 141 group
  '76383182',  // bot 141 group
];

const [bot] = await db.select({
  id: bots.id,
  locale: bots.locale,
}).from(bots).where(eq(bots.id, TARGET_BOT_ID));
if (!bot) { console.error(`Bot ${TARGET_BOT_ID} not found`); process.exit(1); }

const [session] = await db.select().from(sessions).where(eq(sessions.botId, TARGET_BOT_ID));
if (!session) { console.error(`No session for bot ${TARGET_BOT_ID}`); process.exit(1); }

const cookie = decrypt(session.yatriCookie);
const baseUrl = `https://ais.usvisa-info.com/${bot.locale}/niv`;

const applicantParams = ALL_FIVE_APPLICANTS.map(id => `applicants[]=${id}`).join('&');
const url = `${baseUrl}/schedule/${TARGET_SCHEDULE}/appointment?${applicantParams}&confirmed_limit_message=1&commit=Continue`;
// NOTE: WITH commit=Continue this time — simulating the "Continuar" button press
// from the "Select applicants" intermediate page.

console.log('=== PROBE: superset applicants[] WITH commit=Continue ===');
console.log(`URL: ${url}\n`);

const resp = await fetch(url, {
  headers: {
    Cookie: `_yatri_session=${cookie}`,
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    ...BROWSER_HEADERS,
  },
  redirect: 'manual',
});

console.log('Status:    ', resp.status);
console.log('Location:  ', resp.headers.get('location') ?? '(none)');
console.log('Set-Cookie:', resp.headers.get('set-cookie') ? '(cookie rotated)' : '(no rotation)');

if (resp.status >= 300 && resp.status < 400) {
  console.log('\n⚠️ Server redirected (no body to analyze). Inspect Location header above.');
  process.exit(0);
}

const html = await resp.text();
console.log('HTML size: ', html.length, 'bytes');

// Look for applicant names — the screenshot shows checkboxes labeled with applicant names
const checkboxPattern = /<input[^>]*type="checkbox"[^>]*name="applicants?\[\]"[^>]*value="(\d+)"[^>]*>/gi;
const checkboxIds: string[] = [];
for (const m of html.matchAll(checkboxPattern)) {
  checkboxIds.push(m[1]!);
}
console.log('\nApplicant checkbox values found in page:', checkboxIds.length > 0 ? checkboxIds.join(', ') : '(none)');

// Look for applicant names in cells/labels
const nameMatches = html.match(/[A-ZÑÁÉÍÓÚ][A-ZÑÁÉÍÓÚ\s]+[A-ZÑÁÉÍÓÚ]/g) ?? [];
const candidateNames = nameMatches.filter(n => n.length >= 10 && n.split(/\s+/).length >= 2 && !n.includes('CSRF') && !n.includes('TOKEN') && !n.includes('COOKIE'));
const uniqueNames = [...new Set(candidateNames)].slice(0, 15);
console.log('Possible applicant names (heuristic):', uniqueNames.join(' | ') || '(none found)');

// Error markers
const errorMarkers = [
  'unauthorized', 'not authorized', 'no autorizado',
  'error', 'invalid', 'inválid',
  'no permitido', 'Limit Reached', 'Limite alcanzado',
];
const foundErrors = errorMarkers.filter(e => html.toLowerCase().includes(e.toLowerCase()));
console.log('Error markers in HTML:', foundErrors.length ? foundErrors.join(', ') : '(none)');

// Look for the "Reprogramar cita" heading
console.log('Contains "Reprogramar cita":', /Reprogramar\s+cita/i.test(html) ? 'yes' : 'no');
console.log('Contains "Continuar" button:', /Continuar/i.test(html) ? 'yes' : 'no');

// Save HTML for manual review
const { writeFileSync } = await import('fs');
const outFile = '/tmp/probe-superset-response.html';
writeFileSync(outFile, html);
console.log(`\nFull HTML saved to: ${outFile}`);

process.exit(0);

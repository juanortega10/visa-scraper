import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';
import { USER_AGENT, getBaseUrl } from '../src/utils/constants.js';

const botId = 7;

const [bot] = await db.select({
  scheduleId: bots.scheduleId,
  applicantIds: bots.applicantIds,
  locale: bots.locale,
  visaEmail: bots.visaEmail,
  visaPassword: bots.visaPassword,
  userId: bots.userId,
}).from(bots).where(eq(bots.id, botId));

if (!bot) { console.log('Bot not found'); process.exit(1); }

const email = decrypt(bot.visaEmail);
const password = decrypt(bot.visaPassword);
const applicantIds = bot.applicantIds as string[];
const locale = bot.locale ?? 'es-pe';
const baseUrl = getBaseUrl(locale);

console.log('Logging in...');
const loginResult = await performLogin({
  email, password, scheduleId: bot.scheduleId,
  applicantIds, locale,
});
console.log('Login OK');

// Fetch groups page (where appointment info lives)
const userId = bot.userId;
const groupsUrl = userId
  ? `${baseUrl}/groups/${userId}`
  : `${baseUrl}/account`;

console.log(`\nFetching ${groupsUrl}...`);
const resp = await fetch(groupsUrl, {
  headers: {
    Cookie: `_yatri_session=${loginResult.cookie}`,
    'User-Agent': USER_AGENT,
    Accept: 'text/html',
  },
  redirect: 'follow',
});

console.log('Status:', resp.status);
console.log('Final URL:', resp.url);

const html = await resp.text();

// Look for appointment-related content
const consularMatch = html.match(/consular-appt[\s\S]*?<\/p>/);
const ascMatch = html.match(/asc-appt[\s\S]*?<\/p>/);

console.log('\n=== Consular appointment section ===');
console.log(consularMatch ? consularMatch[0] : '(not found)');

console.log('\n=== ASC appointment section ===');
console.log(ascMatch ? ascMatch[0] : '(not found)');

// Broader search for date patterns
const datePatterns = html.match(/\d{1,2}\s+\w+,?\s+\d{4}/g);
if (datePatterns) {
  console.log('\n=== Date patterns found ===');
  for (const d of datePatterns) console.log(d);
}

// Look for "No hay cita" or "No appointment" patterns
const noApptPatterns = ['No hay cita', 'No Appointment', 'no appointment', 'sin cita'];
for (const p of noApptPatterns) {
  if (html.includes(p)) console.log(`\nFound: "${p}"`);
}

// Save HTML for manual inspection
const fs = await import('fs');
fs.writeFileSync('/tmp/bot7-groups.html', html);
console.log('\nFull HTML saved to /tmp/bot7-groups.html');
console.log('HTML length:', html.length);

process.exit(0);

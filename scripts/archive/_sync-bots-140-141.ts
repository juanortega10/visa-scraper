/**
 * Read the actual current appointments from /groups/{userId} and sync DB.
 * No reschedule, no POST. Just reads HTML, parses groups, writes DB.
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { extractGroups } from '../src/services/html-parsers.js';
import { BROWSER_HEADERS, USER_AGENT } from '../src/utils/constants.js';

const BOT_IDS = [140, 141];
// Use bot 141's session (fresher — was used recently)
const SESSION_BOT_ID = 141;

const botRows = await db.select({
  id: bots.id,
  scheduleId: bots.scheduleId,
  userId: bots.userId,
  locale: bots.locale,
  currentConsularDate: bots.currentConsularDate,
  currentConsularTime: bots.currentConsularTime,
  currentCasDate: bots.currentCasDate,
  currentCasTime: bots.currentCasTime,
}).from(bots).where(inArray(bots.id, BOT_IDS));

const userId = botRows[0]?.userId;
const locale = botRows[0]?.locale;
if (!userId) { console.error('No userId on bot rows'); process.exit(1); }

const [session] = await db.select().from(sessions).where(eq(sessions.botId, SESSION_BOT_ID));
if (!session) { console.error(`No session for bot ${SESSION_BOT_ID}`); process.exit(1); }
const cookie = decrypt(session.yatriCookie);

const url = `https://ais.usvisa-info.com/${locale}/niv/groups/${userId}`;
console.log(`Fetching ${url}\n`);

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

console.log('Status:', resp.status);
if (resp.status !== 200) {
  console.error('Failed to fetch groups page'); process.exit(1);
}
const html = await resp.text();
const groups = extractGroups(html);

console.log(`\nFound ${groups.length} groups on portal:`);
for (const g of groups) {
  console.log(`  schedule=${g.scheduleId} | consular ${g.currentConsularDate} ${g.currentConsularTime} | CAS ${g.currentCasDate} ${g.currentCasTime}`);
}

console.log('\n=== Comparing DB vs Portal ===\n');
for (const b of botRows.sort((a, z) => a.id - z.id)) {
  const portalGroup = groups.find(g => g.scheduleId === b.scheduleId);
  if (!portalGroup) {
    console.log(`Bot ${b.id} (schedule ${b.scheduleId}): NOT FOUND on portal`);
    continue;
  }
  const dbStr = `${b.currentConsularDate} ${b.currentConsularTime} | CAS ${b.currentCasDate} ${b.currentCasTime}`;
  const portalStr = `${portalGroup.currentConsularDate} ${portalGroup.currentConsularTime} | CAS ${portalGroup.currentCasDate} ${portalGroup.currentCasTime}`;
  const same = dbStr === portalStr;
  console.log(`Bot ${b.id}:`);
  console.log(`  DB:     ${dbStr}`);
  console.log(`  Portal: ${portalStr}`);
  console.log(`  ${same ? '✓ already in sync' : '✗ DIFFERS — will update'}`);

  if (!same) {
    await db.update(bots).set({
      currentConsularDate: portalGroup.currentConsularDate,
      currentConsularTime: portalGroup.currentConsularTime,
      currentCasDate: portalGroup.currentCasDate,
      currentCasTime: portalGroup.currentCasTime,
      updatedAt: new Date(),
    }).where(eq(bots.id, b.id));
    console.log(`  ✓ DB updated`);
  }
}

process.exit(0);

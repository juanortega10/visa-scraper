/**
 * Compare direct fetch for bot 140 vs 141 to isolate whether the block
 * is on the RPi IP, on the schedule ID, or on the session.
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { inArray } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { BROWSER_HEADERS, USER_AGENT } from '../src/utils/constants.js';

const botRows = await db.select({
  id: bots.id, scheduleId: bots.scheduleId,
  consularFacilityId: bots.consularFacilityId, locale: bots.locale,
}).from(bots).where(inArray(bots.id, [140, 141]));

const sesRows = await db.select().from(sessions).where(inArray(sessions.botId, [140, 141]));

for (const bot of botRows.sort((a, b) => a.id - b.id)) {
  const session = sesRows.find(s => s.botId === bot.id);
  if (!session) { console.log(`Bot ${bot.id}: no session`); continue; }
  const cookie = decrypt(session.yatriCookie);
  const csrf = session.csrfToken ?? '';

  const url = `https://ais.usvisa-info.com/${bot.locale}/niv/schedule/${bot.scheduleId}/appointment/days/${bot.consularFacilityId}.json?appointments%5Bexpedite%5D=false`;

  console.log(`\n=== Bot ${bot.id} (schedule ${bot.scheduleId}) DIRECT ===`);
  console.log('Cookie length:', cookie.length, '| csrf:', csrf.slice(0, 12) + '...');
  try {
    const r = await fetch(url, {
      headers: {
        Cookie: `_yatri_session=${cookie}`,
        'X-CSRF-Token': csrf,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...BROWSER_HEADERS,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    const body = await r.text();
    console.log('Status:', r.status, '| Location:', r.headers.get('location') ?? '(none)');
    console.log('Body (150 chars):', body.slice(0, 150));
  } catch (e) {
    console.log('ERROR:', e instanceof Error ? e.message : e);
  }
}

// Cross test: bot 140 schedule + bot 141 session (isolates if block is on session vs schedule)
const bot140 = botRows.find(b => b.id === 140)!;
const session141 = sesRows.find(s => s.botId === 141);
if (session141 && bot140) {
  const cookie141 = decrypt(session141.yatriCookie);
  const csrf141 = session141.csrfToken ?? '';
  const url140 = `https://ais.usvisa-info.com/${bot140.locale}/niv/schedule/${bot140.scheduleId}/appointment/days/${bot140.consularFacilityId}.json?appointments%5Bexpedite%5D=false`;
  console.log('\n=== Bot 140 schedule + Bot 141 session (cross test) ===');
  try {
    const r = await fetch(url140, {
      headers: {
        Cookie: `_yatri_session=${cookie141}`,
        'X-CSRF-Token': csrf141,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...BROWSER_HEADERS,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    const body = await r.text();
    console.log('Status:', r.status, '| Location:', r.headers.get('location') ?? '(none)');
    console.log('Body (150 chars):', body.slice(0, 150));
  } catch (e) {
    console.log('ERROR:', e instanceof Error ? e.message : e);
  }
}

process.exit(0);

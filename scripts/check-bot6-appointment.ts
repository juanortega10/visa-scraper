import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { VisaClient } from '../src/services/visa-client.js';

const [bot] = await db.select().from(bots).where(eq(bots.id, 6));
const [session] = await db.select().from(sessions).where(eq(sessions.botId, 6));

if (!bot || !session) { console.error('Bot or session not found'); process.exit(1); }

const client = new VisaClient(
  {
    cookie: decrypt(session.yatriCookie),
    csrfToken: session.csrfToken ?? '',
    authenticityToken: session.authenticityToken ?? '',
  },
  {
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    consularFacilityId: bot.consularFacilityId,
    ascFacilityId: bot.ascFacilityId,
    proxyProvider: 'direct',
    proxyUrls: null,
    userId: bot.userId,
    locale: bot.locale,
  },
);

const appt = await client.getCurrentAppointment();
console.log('Current appointment from website:');
console.log(JSON.stringify(appt, null, 2));

console.log('\nDB values:');
console.log(`  consular: ${bot.currentConsularDate} ${bot.currentConsularTime}`);
console.log(`  CAS: ${bot.currentCasDate} ${bot.currentCasTime}`);

process.exit(0);

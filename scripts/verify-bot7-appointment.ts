/**
 * Verify Bot 7's current appointment by fetching the groups page.
 * READ-ONLY.
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';

const BOT_ID = 7;

async function main() {
  const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
  if (!bot) throw new Error(`Bot ${BOT_ID} not found`);

  console.log(`DB state: ${bot.currentConsularDate} ${bot.currentConsularTime} (rescheduleCount=${bot.rescheduleCount})`);

  const login = await performLogin({
    email: decrypt(bot.visaEmail),
    password: decrypt(bot.visaPassword),
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    locale: bot.locale,
  });

  const client = new VisaClient(login, {
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    consularFacilityId: bot.consularFacilityId,
    ascFacilityId: bot.ascFacilityId,
    proxyProvider: 'direct',
    locale: bot.locale,
  });

  await client.refreshTokens();
  const appt = await client.getCurrentAppointment();

  if (appt) {
    console.log(`\nLIVE appointment from portal:`);
    console.log(`  Consular: ${appt.consularDate} ${appt.consularTime}`);
    console.log(`  CAS: ${appt.casDate ?? 'N/A'} ${appt.casTime ?? ''}`);

    if (appt.consularDate !== bot.currentConsularDate) {
      console.log(`\n✅ CONFIRMED: Portal shows ${appt.consularDate} — different from DB (${bot.currentConsularDate})`);
      console.log('   The reschedule DID work. DB needs sync.');
    } else {
      console.log(`\n⚠️  Portal matches DB (${bot.currentConsularDate}) — reschedule may not have taken effect.`);
    }
  } else {
    console.log('\n❌ Could not fetch appointment from portal');
  }

  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

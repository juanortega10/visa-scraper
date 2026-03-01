import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';

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
  currentConsularTime: bots.currentConsularTime,
  currentCasDate: bots.currentCasDate,
  currentCasTime: bots.currentCasTime,
}).from(bots).where(eq(bots.id, 12));

if (!bot) { console.log('Bot not found'); process.exit(1); }

console.log('DB state:', {
  consularDate: bot.currentConsularDate,
  consularTime: bot.currentConsularTime,
  casDate: bot.currentCasDate,
  casTime: bot.currentCasTime,
});

const email = decrypt(bot.visaEmail);
const password = decrypt(bot.visaPassword);
const loginResult = await performLogin({
  email, password, scheduleId: bot.scheduleId,
  applicantIds: bot.applicantIds as string[], locale: bot.locale ?? 'es-co',
});

const client = new VisaClient(
  { cookie: loginResult.cookie, csrfToken: loginResult.csrfToken, authenticityToken: loginResult.authenticityToken },
  { scheduleId: bot.scheduleId, consularFacilityId: String(bot.consularFacilityId), ascFacilityId: String(bot.ascFacilityId), applicantIds: bot.applicantIds as string[], locale: bot.locale ?? 'es-co', userId: '49983575' },
);

const appt = await client.getCurrentAppointment();
console.log('Web appointment:', appt);
process.exit(0);

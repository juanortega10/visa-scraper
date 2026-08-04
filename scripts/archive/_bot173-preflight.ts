import { db } from '../src/db/client.js';
import { bots, excludedDates } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { performLogin, type LoginCredentials } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import { eq } from 'drizzle-orm';

const [b] = await db.select().from(bots).where(eq(bots.id, 173));
const ex = await db.select().from(excludedDates).where(eq(excludedDates.botId, 173));
console.log('FLAGS:', JSON.stringify({
  status: b!.status, provider: b!.proxyProvider, skipCas: b!.skipCas,
  current: `${b!.currentConsularDate} ${b!.currentConsularTime}`, cas: b!.currentCasDate,
  targetDateBefore: b!.targetDateBefore, minDaysFromToday: b!.minDaysFromToday,
  maxReschedules: b!.maxReschedules, rescheduleCount: b!.rescheduleCount,
  pollEnvironments: b!.pollEnvironments, cloudEnabled: b!.cloudEnabled,
  speculativeTimeFallback: b!.speculativeTimeFallback,
  excluded: ex.map(e => `${e.startDate}->${e.endDate}`),
}, null, 2));

const creds: LoginCredentials = { email: decrypt(b!.visaEmail), password: decrypt(b!.visaPassword), scheduleId: b!.scheduleId, applicantIds: b!.applicantIds, locale: b!.locale ?? 'es-co' };
const r = await performLogin(creds);
const client = new VisaClient({ cookie: r.cookie, csrfToken: r.csrfToken ?? '', authenticityToken: r.authenticityToken ?? '' }, {
  scheduleId: b!.scheduleId, applicantIds: b!.applicantIds, consularFacilityId: b!.consularFacilityId, ascFacilityId: b!.ascFacilityId,
  proxyProvider: 'direct', userId: b!.userId, locale: b!.locale ?? 'es-co',
});
const appt = await client.getCurrentAppointment().catch(e => { console.log('appt err', e.message); return null; });
console.log('LIVE current appt:', JSON.stringify(appt));
const days = (await client.getConsularDays()).map(d => d.date).sort();
console.log(`LIVE days: ${days.length}, earliest ${days[0]}, sample ${days.slice(0,5).join(', ')}`);
// check bookable times on earliest
if (days[0]) {
  const t = await client.getConsularTimes(days[0]);
  console.log(`Times on earliest ${days[0]}: ${t.available_times.length} -> ${t.available_times.slice(0,4).join(', ')}`);
}
process.exit(0);

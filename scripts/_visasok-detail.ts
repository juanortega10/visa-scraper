import { db } from '../src/db/client.js';
import { bots, excludedDates, excludedTimes, botCredentialAttempts } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { eq, inArray } from 'drizzle-orm';

const AGENCY_ID = 5;

async function main() {
  const ab = await db.select().from(bots).where(eq(bots.agencyId, AGENCY_ID));
  const ids = ab.map((b) => b.id);
  const exDates = ids.length
    ? await db.select().from(excludedDates).where(inArray(excludedDates.botId, ids))
    : [];
  const exTimes = ids.length
    ? await db.select().from(excludedTimes).where(inArray(excludedTimes.botId, ids))
    : [];

  for (const b of ab.sort((a, z) => a.id - z.id)) {
    let email = '?';
    try { email = decrypt(b.visaEmail); } catch { email = '(decrypt fail)'; }
    console.log(JSON.stringify({
      id: b.id,
      visaEmail: email,
      ownerEmail: b.ownerEmail,
      notificationEmail: b.notificationEmail,
      notificationPhone: b.notificationPhone,
      locale: b.locale,
      scheduleId: b.scheduleId,
      applicantIds: b.applicantIds,
      status: b.status,
      currentConsularDate: b.currentConsularDate,
      currentConsularTime: b.currentConsularTime,
      currentCasDate: b.currentCasDate,
      currentCasTime: b.currentCasTime,
      targetDateBefore: b.targetDateBefore,
      maxReschedules: b.maxReschedules,
      rescheduleCount: b.rescheduleCount,
      minDaysFromToday: b.minDaysFromToday,
      pollEnvironments: b.pollEnvironments,
      cloudEnabled: b.cloudEnabled,
      skipCas: b.skipCas,
      excludedDates: exDates.filter((e) => e.botId === b.id).map((e) => ({ id: e.id, start: e.startDate, end: e.endDate })),
      excludedTimes: exTimes.filter((e) => e.botId === b.id).map((e) => ({ id: e.id, date: e.date, start: e.timeStart, end: e.timeEnd })),
    }, null, 2));
    console.log('---');
  }

  // Credential attempts (have applicant names)
  const att = await db.select().from(botCredentialAttempts).where(eq(botCredentialAttempts.agencyId, AGENCY_ID));
  console.log('\n=== CREDENTIAL ATTEMPTS (applicant names) ===');
  for (const a of att) {
    let email = '?';
    try { email = decrypt(a.visaEmail); } catch { email = '(fail)'; }
    console.log(JSON.stringify({
      id: a.id, visaEmail: email, status: a.status, botId: a.botId,
      names: a.discoveredData?.applicantNames,
      consular: a.discoveredData?.currentConsularDate,
    }));
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

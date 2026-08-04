/**
 * One-shot FORWARD move for bot 173 (no CAS): Jun 10 2026 -> far holding date,
 * so the normal bot can later improve earlier into the post-Jun-16 window.
 * FORWARD move loses the current slot — user explicitly authorized ("mandémoslo lejos").
 * Dry-run by default; pass --commit to POST.
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { performLogin, type LoginCredentials } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import { eq } from 'drizzle-orm';

const commit = process.argv.includes('--commit');
const [b] = await db.select().from(bots).where(eq(bots.id, 173));
if (!b) { console.error('bot 173 not found'); process.exit(1); }

const creds: LoginCredentials = { email: decrypt(b.visaEmail), password: decrypt(b.visaPassword), scheduleId: b.scheduleId, applicantIds: b.applicantIds, locale: b.locale ?? 'es-co' };
const r = await performLogin(creds);
const client = new VisaClient({ cookie: r.cookie, csrfToken: r.csrfToken ?? '', authenticityToken: r.authenticityToken ?? '' }, {
  scheduleId: b.scheduleId, applicantIds: b.applicantIds, consularFacilityId: b.consularFacilityId, ascFacilityId: b.ascFacilityId,
  proxyProvider: 'direct', userId: b.userId, locale: b.locale ?? 'es-co',
});

await client.refreshTokens(); // prime server-side state before POST

const appt = await client.getCurrentAppointment();
console.log('LIVE current:', JSON.stringify(appt));
if (!appt || appt.consularDate !== '2026-06-10') {
  console.error(`Aborting: expected current 2026-06-10, got ${appt?.consularDate}. Re-check before moving.`);
  process.exit(1);
}

const days = (await client.getConsularDays()).map(d => d.date).sort();
const target = days[0]; // earliest available = farthest-needed holding slot (currently Dec 2026)
if (!target) { console.error('No available days'); process.exit(1); }
if (target <= appt.consularDate) {
  console.error(`Earliest available ${target} is NOT later than current ${appt.consularDate} — this would not be a forward move. Abort.`);
  process.exit(1);
}
const times = await client.getConsularTimes(target);
const time = times.available_times[0];
if (!time) { console.error(`No bookable times on ${target}`); process.exit(1); }

console.log(`\nFORWARD MOVE (loses current slot): ${appt.consularDate} ${appt.consularTime} -> ${target} ${time}  [no CAS]`);
if (!commit) { console.log('DRY-RUN — no POST. Re-run with --commit to execute.'); process.exit(0); }

const ok = await client.reschedule(target, time); // no casDate/casTime => ASC omitted
console.log(`POST result: ${ok ? 'SUCCESS' : 'FAILED'}`);
if (ok) {
  const verify = await client.getCurrentAppointment();
  console.log('VERIFY new current:', JSON.stringify(verify));
  if (verify?.consularDate === target) {
    await db.update(bots).set({ currentConsularDate: target, currentConsularTime: time, currentCasDate: null, currentCasTime: null, updatedAt: new Date() }).where(eq(bots.id, 173));
    console.log('DB updated to new current.');
  } else {
    console.log('WARNING: portal did not confirm target — DB NOT updated. Investigate.');
  }
}
process.exit(0);

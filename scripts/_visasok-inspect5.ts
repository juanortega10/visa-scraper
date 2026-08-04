import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
const all = await db.select().from(bots);
console.log('total bots:', all.length);
for (const b of all) {
  let email = '?';
  try { email = decrypt(b.visaEmail).toLowerCase(); } catch {}
  if (email.includes('carlose') || email.includes('lopezos') || b.scheduleId === '75147778' || b.scheduleId === 75147778 as any) {
    console.log(`MATCH carlos: id=${b.id} email=${email} sched=${b.scheduleId} status=${b.status} cohort=${b.cohort} agency=${b.agencyId} createdAt=${b.createdAt?.toISOString?.()} activatedAt=${b.activatedAt?.toISOString?.()}`);
  }
  if (email.includes('ejpinilla') || email.includes('pinillah') || String(b.scheduleId) === '62812711') {
    console.log(`MATCH pinilla: id=${b.id} email=${email} sched=${b.scheduleId} status=${b.status} cohort=${b.cohort} agency=${b.agencyId} createdAt=${b.createdAt?.toISOString?.()}`);
  }
}
process.exit(0);

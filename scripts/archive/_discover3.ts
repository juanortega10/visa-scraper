/** Discover the 3 corrected special-case accounts (read-only). Run on the RPi. */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { discoverAccount } from '../src/services/login.js';

const ACCOUNTS = [
  { email: 'maycolsduranv@hotmail.com',     password: 'Visausapersonal2025' },
  { email: 'anamilenapagara@hotmail.com',   password: 'Visadopersonalusa25' },
  { email: 'edgarcamparradoc@hotmail.com',  password: 'Visadofamiliarusa2026.*' },
];

const existing = await db.select({ id: bots.id, scheduleId: bots.scheduleId }).from(bots);
const bySched = new Map(existing.map(b => [b.scheduleId, b.id]));

for (const a of ACCOUNTS) {
  console.log(`\n=== ${a.email} ===`);
  try {
    const r = await discoverAccount(a.email, a.password, 'es-co');
    const casOnly = !r.currentConsularDate && !!r.currentCasDate;
    console.log(`sched=${r.scheduleId} userId=${r.userId} appls=${r.applicantIds.length} cat=${r.primaryVisaCategory ?? '?'}`);
    console.log(`  names: ${r.applicantNames.join(', ')}`);
    console.log(`  consular=${r.currentConsularDate ?? '-'} ${r.currentConsularTime ?? ''}  cas=${r.currentCasDate ?? '-'}`);
    console.log(`  facilities: consular=${r.consularFacilityId} asc=${r.ascFacilityId}  ${casOnly?'⚠ CAS-ONLY':''} ${bySched.get(r.scheduleId)?'⚠ DUP bot '+bySched.get(r.scheduleId):''}`);
    if ((r.groups?.length ?? 1) > 1) {
      console.log(`  GROUPS (${r.groups!.length}):`);
      for (const g of r.groups!) console.log(`    sched=${g.scheduleId} consular=${g.currentConsularDate ?? '-'} ${g.currentConsularTime ?? ''} cas=${g.currentCasDate ?? '-'}`);
    }
  } catch (e) {
    console.log(`  ❌ ${e instanceof Error ? e.message : e}`);
  }
}
process.exit(0);

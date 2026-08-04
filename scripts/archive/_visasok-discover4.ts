import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { discoverAccount } from '../src/services/login.js';

const ACCOUNTS = [
  { email: 'jhonfrgomen@hotmail.com',        password: 'Visadopersonalusa2026.*' },
  { email: 'joselitopancom@hotmail.com',     password: 'Visadopersonalusa2026.*' },
  { email: 'edgaralbpirateque@hotmail.com',  password: 'Visadopersonalusa2026.*' },
  { email: 'yamithsolanobacca@hotmail.com',  password: 'Visadopersonalusa2026.*' },
];

// existing bots to check duplicates (by scheduleId)
const existing = await db.select({ id: bots.id, scheduleId: bots.scheduleId, visaEmail: bots.visaEmail }).from(bots);
const existingSchedules = new Map(existing.map(b => [b.scheduleId, b.id]));

for (const a of ACCOUNTS) {
  process.stdout.write(`\n=== ${a.email} ===\n`);
  try {
    const r = await discoverAccount(a.email, a.password, 'es-co');
    const casOnly = !r.currentConsularDate && !!r.currentCasDate;
    const dupId = existingSchedules.get(r.scheduleId);
    console.log(JSON.stringify({
      scheduleId: r.scheduleId,
      userId: r.userId,
      applicants: r.applicantNames,
      applicantIds: r.applicantIds,
      visaCategory: r.primaryVisaCategory,
      consular: r.currentConsularDate ? `${r.currentConsularDate} ${r.currentConsularTime}` : null,
      cas: r.currentCasDate ? `${r.currentCasDate} ${r.currentCasTime}` : null,
      consularFacilityId: r.consularFacilityId,
      ascFacilityId: r.ascFacilityId,
      collectsBiometrics: r.collectsBiometrics,
      groupsCount: r.groups?.length,
      FLAG_casOnly_INVALID: casOnly,
      FLAG_duplicate_botId: dupId ?? null,
    }, null, 2));
    if (r.groups && r.groups.length > 1) {
      console.log(`  NOTE: ${r.groups.length} groups in account:`);
      for (const g of r.groups) console.log(`    schedule=${g.scheduleId} consular=${g.currentConsularDate ?? '-'} cas=${g.currentCasDate ?? '-'}`);
    }
  } catch (e) {
    console.log(`  DISCOVER FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
}
process.exit(0);

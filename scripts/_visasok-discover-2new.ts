/**
 * READ-ONLY discovery for 2 new VisasOK paid accounts.
 * Validates creds via discoverAccount, prints current appt, and checks if a bot already exists.
 * Does NOT write anything.
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { discoverAccount } from '../src/services/login.js';

const ACCOUNTS = [
  { email: 'carloselopezos@hotmail.com', pass: 'Visadopersonalusa2026.*', note: 'sin fecha limite' },
  { email: 'ejpinillah@gmail.com',       pass: '3232892547',              note: 'desde 1 agosto' },
];

const existing = await db.select().from(bots);
const byEmail = new Map<string, number>();
for (const b of existing) { try { byEmail.set(decrypt(b.visaEmail).toLowerCase(), b.id); } catch {} }

for (const a of ACCOUNTS) {
  const exId = byEmail.get(a.email.toLowerCase());
  console.log(`\n=== ${a.email} (${a.note}) ===`);
  if (exId) console.log(`  ⚠️  ALREADY has bot id=${exId}`);
  try {
    const r = await discoverAccount(a.email, a.pass, 'es-co');
    console.log(`  ✓ login OK`);
    console.log(`    userId=${r.userId} scheduleId=${r.scheduleId}`);
    console.log(`    applicants=${r.applicantNames?.join(', ')} (ids=${r.applicantIds?.join(',')})`);
    console.log(`    consularFacilityId=${r.consularFacilityId} ascFacilityId=${r.ascFacilityId}`);
    console.log(`    CURRENT consular=${r.currentConsularDate} ${r.currentConsularTime ?? ''}`);
    console.log(`    CURRENT cas     =${r.currentCasDate} ${r.currentCasTime ?? ''}`);
    console.log(`    visaCategory=${r.primaryVisaCategory} raw=${r.primaryVisaTypeRaw}`);
    const schedTaken = existing.some(b => b.scheduleId === r.scheduleId);
    if (schedTaken) console.log(`    ⚠️  schedule ${r.scheduleId} already used by another bot`);
    if (!r.currentConsularDate && r.currentCasDate) console.log(`    ⚠️  CAS-only account (invalid per rules)`);
  } catch (e) {
    console.log(`  ✗ login FAILED: ${e instanceof Error ? e.message : e}`);
  }
}
process.exit(0);

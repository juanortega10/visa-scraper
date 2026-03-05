import { db } from '../src/db/client.ts';
import { bots } from '../src/db/schema.ts';
import { decrypt } from '../src/services/encryption.ts';
import { asc } from 'drizzle-orm';

async function main() {
  const rows = await db.select({
    id: bots.id,
    visaEmail: bots.visaEmail,
    applicantIds: bots.applicantIds,
    ownerEmail: bots.ownerEmail,
    locale: bots.locale,
    status: bots.status,
  }).from(bots).orderBy(asc(bots.id));

  for (const r of rows) {
    let email = '?';
    try { email = decrypt(r.visaEmail); } catch {}
    console.log(`Bot ${r.id} | ${r.locale} | ${r.status} | email=${email} | owner=${r.ownerEmail ?? '-'} | applicants=${JSON.stringify(r.applicantIds)}`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

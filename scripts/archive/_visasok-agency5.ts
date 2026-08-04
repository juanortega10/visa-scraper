import { db } from '../src/db/client.js';
import { bots, agencies } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';

const [ag] = await db.select().from(agencies).where(eq(agencies.id, 5));
const list = await db.select().from(bots).where(eq(bots.agencyId, 5));
console.log('Agency 5:', JSON.stringify({ name: ag?.name, maxBots: ag?.maxBots, ownerEmail: (ag as any)?.ownerEmail }));
console.log(`Current bots in agency 5: ${list.length}`);
for (const b of list) {
  let email = '';
  try { email = decrypt(b.visaEmail); } catch {}
  console.log(`  ${b.id}\t${b.status}\tcohort=${b.cohort}\t${email}\tconsular=${b.currentConsularDate}`);
}
process.exit(0);

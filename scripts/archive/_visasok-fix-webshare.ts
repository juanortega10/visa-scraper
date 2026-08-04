import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { inArray, eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';

const IDS = [178, 194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211];
await db.update(bots)
  .set({ proxyProvider: 'webshare', agencyId: 5, updatedAt: new Date() })
  .where(inArray(bots.id, IDS));

const rows = await db.select().from(bots).where(inArray(bots.id, IDS));
for (const b of rows) {
  let email = ''; try { email = decrypt(b.visaEmail); } catch {}
  console.log(`bot ${b.id}: provider=${b.proxyProvider} agency=${b.agencyId} cohort=${b.cohort} status=${b.status} ${email}`);
}
console.log(`\nAll ${rows.length} -> webshare, agency 5. webshare=${rows.filter(r=>r.proxyProvider==='webshare').length}, agency5=${rows.filter(r=>r.agencyId===5).length}`);
process.exit(0);

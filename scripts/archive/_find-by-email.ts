import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';

const targets = process.argv.slice(2).map(s => s.toLowerCase());
const all = await db.select().from(bots);
for (const b of all) {
  let email = '';
  try { email = decrypt(b.visaEmail).toLowerCase(); } catch { continue; }
  if (targets.some(t => email === t)) {
    console.log(`${b.id}\t${b.status}\t${email}\tschedule=${b.scheduleId}\tactiveRunId=${b.activeRunId ?? ''}`);
  }
}
process.exit(0);

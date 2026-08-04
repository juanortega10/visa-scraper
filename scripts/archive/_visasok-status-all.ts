import { db } from '../src/db/client.js';
import { bots, pollLogs } from '../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';

const AGENCY_ID = 5;
const rows = await db.select().from(bots).where(eq(bots.agencyId, AGENCY_ID));
rows.sort((a,b)=>a.id-b.id);
console.log(`Agency ${AGENCY_ID}: ${rows.length} bots\n`);
for (const b of rows) {
  let email=''; try { email=decrypt(b.visaEmail); } catch {}
  const [p] = await db.select({ s: pollLogs.status, e: pollLogs.earliestDate, t: pollLogs.createdAt })
    .from(pollLogs).where(eq(pollLogs.botId, b.id)).orderBy(desc(pollLogs.createdAt)).limit(1);
  const last = p ? `${p.s} earliest=${p.e ?? '-'} @${p.t?.toISOString().slice(5,16)}` : 'no-polls';
  console.log(`${String(b.id).padStart(3)} ${(b.status||'').padEnd(7)} ${(b.cohort||'-').padEnd(5)} consular=${(b.currentConsularDate||'-').toString().padEnd(10)} rc=${b.rescheduleCount}/${b.maxReschedules ?? '∞'} ${email.padEnd(34)} ${last}`);
}
process.exit(0);

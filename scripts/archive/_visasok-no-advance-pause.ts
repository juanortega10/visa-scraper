import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { inArray } from 'drizzle-orm';

// "No adelantar más" — VisasOK clients who want to KEEP their current appointment.
const LABELS: Record<number, string> = {
  196: 'ronaldaparradou@hotmail.com',
  198: 'marialejandraparo@hotmail.com',
  201: 'karenanguzmanmo@hotmail.com',
  205: 'jhonatanbusmen@hotmail.com',
  210: 'henryquinorojas17@hotmail.com',
};
const IDS = Object.keys(LABELS).map(Number);

await db.update(bots)
  .set({ status: 'paused', activeRunId: null, activeCloudRunId: null, updatedAt: new Date() })
  .where(inArray(bots.id, IDS));

const rows = await db.select({
  id: bots.id, status: bots.status, currentConsularDate: bots.currentConsularDate,
}).from(bots).where(inArray(bots.id, IDS));

for (const r of rows.sort((a,b)=>a.id-b.id)) {
  console.log(`bot ${r.id}\t${r.status}\tconsular=${r.currentConsularDate}\t${LABELS[r.id]}`);
}
console.log(`\npaused ${rows.filter(r=>r.status==='paused').length}/${IDS.length}`);
process.exit(0);

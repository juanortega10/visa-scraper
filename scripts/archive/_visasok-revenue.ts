import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { inArray } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';

const PRICE = 950; // COP per day advanced
const TARGET = '2026-06-30';
const NEW = [194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211];
const ID178 = 178;

const rows = await db.select().from(bots).where(inArray(bots.id, [...NEW, ID178]));
const byId = new Map(rows.map(b => [b.id, b]));
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
const fmt = (n: number) => n.toLocaleString('es-CO');

let totalNew = 0;
console.log(`950 COP/día adelantado · objetivo ${TARGET}\n`);
console.log('cuenta'.padEnd(8) + 'cita actual'.padEnd(13) + 'días adel.'.padEnd(11) + 'COP');
for (const id of NEW) {
  const b = byId.get(id)!;
  const d = days(TARGET, b.currentConsularDate!);
  const cop = d * PRICE;
  totalNew += cop;
  console.log(`${String(id).padEnd(8)}${b.currentConsularDate!.padEnd(13)}${String(d).padEnd(11)}${fmt(cop)}`);
}
console.log(`\n18 cuentas nuevas: días totales=${NEW.reduce((s,id)=>s+days(TARGET,byId.get(id)!.currentConsularDate!),0)}  ->  TOTAL = ${fmt(totalNew)} COP`);

// 178 variants
const b178 = byId.get(ID178)!;
const d178jun = days(TARGET, b178.currentConsularDate!);
const d178ago = days('2026-08-01', b178.currentConsularDate!);
console.log(`\nBot 178 (titonelbayonalop, cur=${b178.currentConsularDate}):`);
console.log(`  si a jun-30: ${d178jun} días = ${fmt(d178jun*PRICE)} COP  (pero su piso es ago-1)`);
console.log(`  si a ago-1 (realista): ${d178ago} días = ${fmt(d178ago*PRICE)} COP`);
console.log(`\nTOTAL 19 (18 nuevas a jun-30 + 178 a ago-1) = ${fmt(totalNew + d178ago*PRICE)} COP`);
console.log(`TOTAL 19 (todas a jun-30, literal)        = ${fmt(totalNew + d178jun*PRICE)} COP`);
process.exit(0);

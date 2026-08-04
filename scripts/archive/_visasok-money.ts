import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { inArray } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';

const PRICE = 950;
const NEW = [194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211];
const ID178 = 178;
const ALL = [...NEW, ID178];

const rows = await db.select().from(bots).where(inArray(bots.id, ALL));
const byId = new Map(rows.map(b => [b.id, b]));

function appls(id: number) { return (byId.get(id)?.applicantIds as string[] | null)?.length ?? 0; }
function email(id: number) { try { return decrypt(byId.get(id)!.visaEmail); } catch { return '?'; } }

// June 30 eligibility: floor <= 2026-06-30 < current consular
const TARGET = '2026-06-30';
let elig: number[] = [], inelig: { id: number; reason: string }[] = [];
for (const id of ALL) {
  const b = byId.get(id)!;
  const floorAug = id === ID178; // 178 has Aug-1 floor
  const floorOk = floorAug ? TARGET >= '2026-08-01' : TARGET >= '2026-06-23';
  const cur = b.currentConsularDate;
  const curOk = cur ? TARGET < cur : false;
  if (floorOk && curOk) elig.push(id);
  else inelig.push({ id, reason: !floorOk ? `floor (needs >=${floorAug?'ago-1':'jun-23'})` : `current ${cur} not later` });
}

const newAppl = NEW.reduce((s, id) => s + appls(id), 0);
const allAppl = ALL.reduce((s, id) => s + appls(id), 0);
const eligAppl = elig.reduce((s, id) => s + appls(id), 0);

console.log(`PRICE per unit = ${PRICE}\n`);
console.log('Applicants per bot:');
for (const id of ALL) console.log(`  bot ${id}: ${appls(id)} appl  cur=${byId.get(id)?.currentConsularDate}  ${email(id)}`);

console.log(`\n--- Scenario: TODOS a ${TARGET} ---`);
console.log(`Eligible for ${TARGET} (window includes it): ${elig.length} bots -> ${elig.join(',')}`);
console.log(`Ineligible: ${inelig.map(x=>`${x.id}(${x.reason})`).join(', ')}`);

console.log(`\n=== MONEY ===`);
console.log(`Per ACCOUNT (bot):`);
console.log(`  18 new bots:        18 x ${PRICE} = ${(18*PRICE).toLocaleString()}`);
console.log(`  19 (incl 178):      19 x ${PRICE} = ${(19*PRICE).toLocaleString()}`);
console.log(`  eligible for jun-30: ${elig.length} x ${PRICE} = ${(elig.length*PRICE).toLocaleString()}`);
console.log(`Per APPLICANT (person):`);
console.log(`  18 new:  ${newAppl} x ${PRICE} = ${(newAppl*PRICE).toLocaleString()}`);
console.log(`  19 all:  ${allAppl} x ${PRICE} = ${(allAppl*PRICE).toLocaleString()}`);
console.log(`  eligible jun-30: ${eligAppl} x ${PRICE} = ${(eligAppl*PRICE).toLocaleString()}`);
process.exit(0);

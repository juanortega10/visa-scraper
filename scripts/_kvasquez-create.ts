/**
 * CREATE Katherine Vasquez bot — B2C direct, paid Visagente. Colombia, 4 applicants.
 * Floor: only accept consular/CAS on/after 2026-10-20 ("finales de octubre" — piso 20 oct),
 * and strictly earlier than current 2027-04-23 (automatic protection).
 * Creates PAUSED. Idempotent (skips if email already a bot). Dry-run unless --commit.
 */
import { db } from '../src/db/client.js';
import { bots, excludedDates } from '../src/db/schema.js';
import { encrypt, decrypt } from '../src/services/encryption.js';
import { discoverAccount } from '../src/services/login.js';
import { and, eq } from 'drizzle-orm';

const COMMIT = process.argv.includes('--commit');
const EMAIL = 'Katherinevasquezvasquez1@gmail.com';
const PASS = 'Katherinevasquez12345*';
const LOCALE = 'es-co';
const NOTIF = 'juanalbertoortega456@gmail.com';       // admin operational alerts
const OWNER = 'Katherinevasquezvasquez1@gmail.com';   // customer — reschedule_success
const OWNER_PHONE = '573217017251';                   // +57 321 7017251, digits only (WhatsApp)
const FLOOR_START = '2026-01-01';                     // block window start (well before bookables)
const FLOOR_END = '2026-10-19';                       // last blocked day → first allowed = 2026-10-20

const existing = await db.select().from(bots);
for (const b of existing) {
  try { if (decrypt(b.visaEmail).toLowerCase() === EMAIL.toLowerCase()) { console.log(`SKIP: already bot ${b.id} (status=${b.status})`); process.exit(0); } } catch {}
}
const takenSchedules = new Set(existing.map(b => b.scheduleId));

const r = await discoverAccount(EMAIL, PASS, LOCALE);
if (!r.currentConsularDate && r.currentCasDate) { console.log('SKIP: CAS-only invalid'); process.exit(1); }
if (takenSchedules.has(r.scheduleId)) { console.log(`SKIP: schedule ${r.scheduleId} already used`); process.exit(1); }

console.log(`Account: ${r.applicantNames?.join(', ')}`);
console.log(`  sched=${r.scheduleId} userId=${r.userId} facility=${r.consularFacilityId}/asc=${r.ascFacilityId} cat=${r.primaryVisaCategory}`);
console.log(`  current consular=${r.currentConsularDate} ${r.currentConsularTime} | cas=${r.currentCasDate} ${r.currentCasTime}`);
console.log(`  floor: block ${FLOOR_START}..${FLOOR_END} (first allowed 2026-10-20) | strictly earlier than ${r.currentConsularDate}`);

if (!COMMIT) { console.log('\n[DRY-RUN] pass --commit to create (PAUSED).'); process.exit(0); }

const [bot] = await db.insert(bots).values({
  visaEmail: encrypt(EMAIL),
  visaPassword: encrypt(PASS),
  scheduleId: r.scheduleId,
  applicantIds: r.applicantIds,
  consularFacilityId: r.consularFacilityId,
  ascFacilityId: r.ascFacilityId,
  locale: LOCALE,
  userId: r.userId,
  currentConsularDate: r.currentConsularDate,
  currentConsularTime: r.currentConsularTime,
  currentCasDate: r.currentCasDate,
  currentCasTime: r.currentCasTime,
  visaCategory: r.primaryVisaCategory ?? null,
  visaTypeRaw: r.primaryVisaTypeRaw ?? null,
  applicantVisaTypes: r.applicantVisaTypes ?? null,
  proxyProvider: 'webshare',
  skipCas: false,
  notificationEmail: NOTIF,
  ownerEmail: OWNER,
  notificationPhone: OWNER_PHONE,
  agencyId: null,
  clientType: 'b2c',
  cohort: 'paid',
  status: 'paused',
  pollEnvironments: ['prod'],
  activatedAt: new Date(),
}).returning();

await db.insert(excludedDates).values({ botId: bot!.id, startDate: FLOOR_START, endDate: FLOOR_END });
console.log(`\nCREATED bot ${bot!.id} (PAUSED) + floor excluded ${FLOOR_START}..${FLOOR_END}`);
process.exit(0);

/**
 * CREATE Leonor Melo Richard bot — B2C direct, paid Visagente. Colombia (Bogotá), 1 applicant.
 * Account melo.david@gmail.com has 3 groups; only Leonor has a consular appointment (the other
 * two are CAS-only/past → invalid). discoverAccount returns Leonor as primary.
 *
 * Constraints (per client via WhatsApp 573217017251):
 *   - Floor: search only Aug-2026 onward → block 2026-01-01..2026-07-31 (first allowed 2026-08-01).
 *   - Avoid week of Oct 5 (2026-10-05..10-11) and week of Oct 19 (2026-10-19..10-25).
 *   - No ceiling beyond the automatic strictly-earlier-than-current protection (< 2027-03-12).
 *   - "no muy temprano" = preference only, NOT enforced (would drop good slots).
 *
 * Creates PAUSED. Idempotent (skips if email already a bot). Dry-run unless --commit.
 */
import { db } from '../src/db/client.js';
import { bots, excludedDates } from '../src/db/schema.js';
import { encrypt, decrypt } from '../src/services/encryption.js';
import { discoverAccount } from '../src/services/login.js';

const COMMIT = process.argv.includes('--commit');
const EMAIL = 'melo.david@gmail.com';
const PASS = 'pasaporte';
const LOCALE = 'es-co';
const NOTIF = 'juanalbertoortega456@gmail.com';   // admin operational alerts
const OWNER = 'melo.david@gmail.com';             // customer — reschedule_success
const OWNER_PHONE = '573217017251';               // +57 321 7017251, digits only (WhatsApp)

const EXCLUSIONS: Array<{ startDate: string; endDate: string; why: string }> = [
  { startDate: '2026-01-01', endDate: '2026-07-31', why: 'floor: first allowed 2026-08-01' },
  { startDate: '2026-10-05', endDate: '2026-10-11', why: 'avoid week of Oct 5' },
  { startDate: '2026-10-19', endDate: '2026-10-25', why: 'avoid week of Oct 19' },
];

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
console.log('  exclusions:');
for (const e of EXCLUSIONS) console.log(`    ${e.startDate}..${e.endDate}  (${e.why})`);
console.log(`  strictly earlier than ${r.currentConsularDate} (automatic) | maxReschedules=null (unlimited, es-co default)`);

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

await db.insert(excludedDates).values(EXCLUSIONS.map(e => ({ botId: bot!.id, startDate: e.startDate, endDate: e.endDate })));
console.log(`\nCREATED bot ${bot!.id} (PAUSED) + ${EXCLUSIONS.length} excluded ranges`);
console.log(`Next: npm run login -- --bot-id=${bot!.id}  (primes session + sets active; prod cron chains it)`);
process.exit(0);

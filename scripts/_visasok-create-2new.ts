/**
 * VisasOK PAID onboarding — CREATE 2 new bots (writes). Creates them PAUSED.
 *   carloselopezos@hotmail.com  — sin fecha limite (no floor)
 *   ejpinillah@gmail.com        — desde 1 agosto  (floor excluded_dates 2026-01-01..2026-07-31)
 * Idempotent: skips an email that already has a bot. Does NOT activate.
 * Run with --commit to write; without it, dry-run.
 */
import { db } from '../src/db/client.js';
import { bots, excludedDates } from '../src/db/schema.js';
import { encrypt, decrypt } from '../src/services/encryption.js';
import { discoverAccount } from '../src/services/login.js';
import { and, eq } from 'drizzle-orm';

const COMMIT = process.argv.includes('--commit');
const AGENCY_ID = 5;
const NOTIF = 'juanalbertoortega456@gmail.com';
const OWNER = 'neiloswaldo@gmail.com';

const ACCOUNTS = [
  { email: 'carloselopezos@hotmail.com', pass: 'Visadopersonalusa2026.*', floorEnd: null as string | null },
  { email: 'ejpinillah@gmail.com',       pass: '3232892547',              floorEnd: '2026-07-31' },
];
const EXCL_START = '2026-01-01';

const existing = await db.select().from(bots);
const byEmail = new Map<string, number>();
const takenSchedules = new Set(existing.map(b => b.scheduleId));
for (const b of existing) { try { byEmail.set(decrypt(b.visaEmail).toLowerCase(), b.id); } catch {} }

async function setFloor(botId: number, end: string) {
  const ex = await db.select().from(excludedDates)
    .where(and(eq(excludedDates.botId, botId), eq(excludedDates.startDate, EXCL_START), eq(excludedDates.endDate, end)));
  if (ex.length === 0) await db.insert(excludedDates).values({ botId, startDate: EXCL_START, endDate: end });
}

let created = 0, skipped = 0;
for (const a of ACCOUNTS) {
  if (byEmail.has(a.email.toLowerCase())) { console.log(`SKIP ${a.email}: already has bot ${byEmail.get(a.email.toLowerCase())}`); skipped++; continue; }

  let r;
  try { r = await discoverAccount(a.email, a.pass, 'es-co'); }
  catch (e) { console.log(`SKIP ${a.email}: discover failed: ${e instanceof Error ? e.message : e}`); skipped++; continue; }

  if (!r.currentConsularDate && r.currentCasDate) { console.log(`SKIP ${a.email}: CAS-only invalid`); skipped++; continue; }
  if (takenSchedules.has(r.scheduleId)) { console.log(`SKIP ${a.email}: schedule ${r.scheduleId} already used`); skipped++; continue; }

  const floorTxt = a.floorEnd ? `floor=>${a.floorEnd}` : 'no-floor';
  if (!COMMIT) {
    console.log(`[DRY] would CREATE ${a.email} (${r.applicantNames?.join(', ')}) sched=${r.scheduleId} current=${r.currentConsularDate} ${r.currentConsularTime} ${floorTxt}`);
    continue;
  }

  const [bot] = await db.insert(bots).values({
    visaEmail: encrypt(a.email),
    visaPassword: encrypt(a.pass),
    scheduleId: r.scheduleId,
    applicantIds: r.applicantIds,
    consularFacilityId: r.consularFacilityId,
    ascFacilityId: r.ascFacilityId,
    locale: 'es-co',
    userId: r.userId,
    currentConsularDate: r.currentConsularDate,
    currentConsularTime: r.currentConsularTime,
    currentCasDate: r.currentCasDate,
    currentCasTime: r.currentCasTime,
    visaCategory: r.primaryVisaCategory ?? null,
    visaTypeRaw: r.primaryVisaTypeRaw ?? null,
    applicantVisaTypes: r.applicantVisaTypes ?? null,
    proxyProvider: 'direct',
    skipCas: false,
    notificationEmail: NOTIF,
    ownerEmail: OWNER,
    agencyId: AGENCY_ID,
    clientType: 'b2b',
    cohort: 'paid',
    status: 'paused',
    pollEnvironments: ['prod'],
    activatedAt: new Date(),
  }).returning();

  takenSchedules.add(r.scheduleId);
  byEmail.set(a.email.toLowerCase(), bot!.id);
  if (a.floorEnd) await setFloor(bot!.id, a.floorEnd);
  console.log(`CREATED bot ${bot!.id}: ${a.email} (${r.applicantNames?.join(', ')}) sched=${r.scheduleId} current=${r.currentConsularDate} ${r.currentConsularTime} ${floorTxt}`);
  created++;
}
console.log(`\nDone. created=${created} skipped=${skipped}${COMMIT ? '' : ' [DRY-RUN — pass --commit to write]'}. Bots are PAUSED.`);
process.exit(0);

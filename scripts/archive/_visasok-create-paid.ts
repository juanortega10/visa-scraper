/**
 * VisasOK PAID onboarding — CREATE + CONFIGURE (writes).
 * Creates 18 clean new bots (paused) + updates bot 178 (titonelbayonalop).
 * Skips 3 special cases (bad creds / past appt).
 * Floor: excluded_dates 2026-01-01..2026-06-22 (first acceptable 23-jun);
 *        titonelbayonalop -> ..2026-07-31 (first acceptable 01-ago, "dejar para agosto").
 * Idempotent: skips an email that already has a bot (except the 178 update).
 * Does NOT activate — bots are created paused.
 */
import xlsx from 'xlsx';
import os from 'node:os';
import { db } from '../src/db/client.js';
import { bots, agencies, excludedDates } from '../src/db/schema.js';
import { encrypt, decrypt } from '../src/services/encryption.js';
import { discoverAccount } from '../src/services/login.js';
import { and, eq } from 'drizzle-orm';

const AGENCY_ID = 5;
const NOTIF = 'juanalbertoortega456@gmail.com';
const OWNER = 'neiloswaldo@gmail.com';
const EXCL_START = '2026-01-01';
const FLOOR_END_DEFAULT = '2026-06-22'; // first acceptable 23-jun
const FLOOR_END_AGOSTO  = '2026-07-31'; // first acceptable 01-ago

const SKIP = new Set(['maycolsduranv@hotmail.com', 'anamilenapagara@hotmail.com', 'edgarcamparradoc@hotmail.com']);

const wb = xlsx.readFile(`${os.homedir()}/Downloads/Adelantamientos.xlsx`);
const rows = xlsx.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: '' });
const accounts = rows
  .filter(r => ['Familiar','Personal'].includes((r[0]||'').toString().trim()))
  .map(r => ({ email:(r[2]||'').toString().trim().toLowerCase(), pass:(r[5]||'').toString().trim(), nota:(r[11]||'').toString().trim().toLowerCase() }));

// existing bots by email
const existing = await db.select().from(bots);
const byEmail = new Map<string, { id: number }>();
const existingSchedules = new Set(existing.map(b => b.scheduleId));
for (const b of existing) { try { byEmail.set(decrypt(b.visaEmail).toLowerCase(), { id: b.id }); } catch {} }

async function setFloor(botId: number, end: string) {
  const ex = await db.select().from(excludedDates)
    .where(and(eq(excludedDates.botId, botId), eq(excludedDates.startDate, EXCL_START), eq(excludedDates.endDate, end)));
  if (ex.length === 0) await db.insert(excludedDates).values({ botId, startDate: EXCL_START, endDate: end });
}

let created = 0, updated = 0, skipped = 0;
for (const a of accounts) {
  if (SKIP.has(a.email)) { console.log(`SKIP-SPECIAL ${a.email}`); skipped++; continue; }
  const floorEnd = a.nota.includes('agosto') ? FLOOR_END_AGOSTO : FLOOR_END_DEFAULT;

  let r;
  try { r = await discoverAccount(a.email, a.pass, 'es-co'); }
  catch (e) { console.log(`SKIP ${a.email}: discover failed: ${e instanceof Error ? e.message : e}`); skipped++; continue; }

  if (!r.currentConsularDate && r.currentCasDate) { console.log(`SKIP ${a.email}: CAS-only invalid`); skipped++; continue; }

  const ex = byEmail.get(a.email);
  if (ex) {
    // UPDATE path (bot 178 titonelbayonalop): sync real current + cohort paid + floor
    await db.update(bots).set({
      currentConsularDate: r.currentConsularDate,
      currentConsularTime: r.currentConsularTime,
      currentCasDate: r.currentCasDate,
      currentCasTime: r.currentCasTime,
      userId: r.userId,
      cohort: 'paid',
      proxyProvider: 'direct',
      agencyId: AGENCY_ID,
      updatedAt: new Date(),
    }).where(eq(bots.id, ex.id));
    await setFloor(ex.id, floorEnd);
    console.log(`UPDATED bot ${ex.id}: ${a.email} cohort=paid current=${r.currentConsularDate} ${r.currentConsularTime} floor=>${floorEnd}`);
    updated++;
    continue;
  }

  if (existingSchedules.has(r.scheduleId)) { console.log(`SKIP ${a.email}: schedule ${r.scheduleId} already has a bot`); skipped++; continue; }

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
    pollEnvironments: ['dev'],
    activatedAt: new Date(),
  }).returning();

  existingSchedules.add(r.scheduleId);
  await setFloor(bot!.id, floorEnd);
  console.log(`CREATED bot ${bot!.id}: ${a.email} (${r.applicantNames.join(', ')}) sched=${r.scheduleId} current=${r.currentConsularDate} ${r.currentConsularTime} floor=>${floorEnd}`);
  created++;
}

const count = (await db.select({ id: bots.id }).from(bots).where(eq(bots.agencyId, AGENCY_ID))).length;
console.log(`\nDone. created=${created} updated=${updated} skipped=${skipped}. Agency ${AGENCY_ID} now has ${count} bots. All new bots are PAUSED (activate separately).`);
process.exit(0);

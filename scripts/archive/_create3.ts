/** Create the corrected special-case bots (skips invalid creds). Run on the RPi. Same config + floor as the 19. */
import { db } from '../src/db/client.js';
import { bots, excludedDates } from '../src/db/schema.js';
import { encrypt, decrypt } from '../src/services/encryption.js';
import { discoverAccount } from '../src/services/login.js';
import { and, eq } from 'drizzle-orm';

const AGENCY_ID = 5, NOTIF = 'juanalbertoortega456@gmail.com', OWNER = 'neiloswaldo@gmail.com';
const EXCL_START = '2026-01-01', EXCL_END = '2026-06-22'; // floor: first acceptable 23-jun (same as the 19)
const ACCOUNTS = [
  { email: 'maycolsduranv@hotmail.com',     password: 'Visausapersonal2025' },
  { email: 'anamilenapagara@hotmail.com',   password: 'Visadopersonalusa25' },
  { email: 'edgarcamparradoc@hotmail.com',  password: 'Visadofamiliarusa2026.*' },
];

const existing = await db.select().from(bots);
const byEmail = new Map<string, number>();
const existingSchedules = new Set(existing.map(b => b.scheduleId));
for (const b of existing) { try { byEmail.set(decrypt(b.visaEmail).toLowerCase(), b.id); } catch {} }

for (const a of ACCOUNTS) {
  if (byEmail.has(a.email.toLowerCase())) { console.log(`SKIP ${a.email}: already a bot (#${byEmail.get(a.email.toLowerCase())})`); continue; }
  let r;
  try { r = await discoverAccount(a.email, a.password, 'es-co'); }
  catch (e) { console.log(`SKIP ${a.email}: ${e instanceof Error ? e.message : e}`); continue; }
  if (!r.currentConsularDate && r.currentCasDate) { console.log(`SKIP ${a.email}: CAS-only invalid`); continue; }
  if (existingSchedules.has(r.scheduleId)) { console.log(`SKIP ${a.email}: schedule ${r.scheduleId} dup`); continue; }

  const [bot] = await db.insert(bots).values({
    visaEmail: encrypt(a.email), visaPassword: encrypt(a.password),
    scheduleId: r.scheduleId, applicantIds: r.applicantIds,
    consularFacilityId: r.consularFacilityId, ascFacilityId: r.ascFacilityId,
    locale: 'es-co', userId: r.userId,
    currentConsularDate: r.currentConsularDate, currentConsularTime: r.currentConsularTime,
    currentCasDate: r.currentCasDate, currentCasTime: r.currentCasTime,
    visaCategory: r.primaryVisaCategory ?? null, visaTypeRaw: r.primaryVisaTypeRaw ?? null,
    applicantVisaTypes: r.applicantVisaTypes ?? null,
    proxyProvider: 'webshare', skipCas: false,
    notificationEmail: NOTIF, ownerEmail: OWNER, agencyId: AGENCY_ID,
    clientType: 'b2b', cohort: 'paid', status: 'paused',
    pollEnvironments: ['dev'], activatedAt: new Date(),
  }).returning();
  existingSchedules.add(r.scheduleId);
  const ex = await db.select().from(excludedDates).where(and(eq(excludedDates.botId, bot!.id), eq(excludedDates.startDate, EXCL_START), eq(excludedDates.endDate, EXCL_END)));
  if (ex.length === 0) await db.insert(excludedDates).values({ botId: bot!.id, startDate: EXCL_START, endDate: EXCL_END });
  console.log(`CREATED bot ${bot!.id}: ${a.email} (${r.applicantNames.join(', ')}) sched=${r.scheduleId} consular=${r.currentConsularDate} ${r.currentConsularTime} floor=>23-jun`);
}
process.exit(0);

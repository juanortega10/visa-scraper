import { db } from '../src/db/client.js';
import { bots, agencies } from '../src/db/schema.js';
import { encrypt } from '../src/services/encryption.js';
import { discoverAccount } from '../src/services/login.js';
import { eq } from 'drizzle-orm';

const AGENCY_ID = 5;
const NOTIF = 'juanalbertoortega456@gmail.com';
const OWNER = 'neiloswaldo@gmail.com';

const ACCOUNTS = [
  { email: 'jhonfrgomen@hotmail.com',        password: 'Visadopersonalusa2026.*' },
  { email: 'joselitopancom@hotmail.com',     password: 'Visadopersonalusa2026.*' },
  { email: 'edgaralbpirateque@hotmail.com',  password: 'Visadopersonalusa2026.*' },
  { email: 'yamithsolanobacca@hotmail.com',  password: 'Visadopersonalusa2026.*' },
];

// 1. Raise cap
await db.update(agencies).set({ maxBots: 10, updatedAt: new Date() }).where(eq(agencies.id, AGENCY_ID));
const [ag] = await db.select().from(agencies).where(eq(agencies.id, AGENCY_ID));
console.log(`Agency ${AGENCY_ID} (${ag!.name}): maxBots -> ${ag!.maxBots}`);

const existing = await db.select({ scheduleId: bots.scheduleId }).from(bots);
const existingSchedules = new Set(existing.map(b => b.scheduleId));

for (const a of ACCOUNTS) {
  const r = await discoverAccount(a.email, a.password, 'es-co');
  if (!r.currentConsularDate && r.currentCasDate) { console.log(`SKIP ${a.email}: CAS-only invalid`); continue; }
  if (existingSchedules.has(r.scheduleId)) { console.log(`SKIP ${a.email}: schedule ${r.scheduleId} already has a bot`); continue; }

  const [bot] = await db.insert(bots).values({
    visaEmail: encrypt(a.email),
    visaPassword: encrypt(a.password),
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
    status: 'paused',
    pollEnvironments: ['dev'],
    activatedAt: new Date(),
  }).returning();

  existingSchedules.add(r.scheduleId);
  console.log(`CREATED bot ${bot!.id}: ${a.email} (${r.applicantNames.join(', ')}) schedule=${r.scheduleId} consular=${r.currentConsularDate} ${r.currentConsularTime} status=paused provider=direct`);
}

const count = (await db.select({ id: bots.id }).from(bots).where(eq(bots.agencyId, AGENCY_ID))).length;
console.log(`\nAgency ${AGENCY_ID} now has ${count} bots (cap ${ag!.maxBots}).`);
process.exit(0);

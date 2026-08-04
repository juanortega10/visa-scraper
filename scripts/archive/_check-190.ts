/**
 * READ-ONLY diagnostic for bot 190 (child).
 * Verifies new password works, reads REAL current appointment from portal,
 * and lists available consular days in the desired window (Jun 9 - Jul 26 2026).
 *
 * Usage: npx tsx --env-file=.env scripts/_check-190.ts
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { discoverAccount, pureFetchLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import type { ProxyProvider } from '../src/services/proxy-fetch.js';

const BOT_ID = 190;
const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!bot) { console.error('Bot not found'); process.exit(1); }

const email = decrypt(bot.visaEmail);
const password = decrypt(bot.visaPassword);
const locale = bot.locale ?? 'es-co';

console.log(`\n=== Bot ${BOT_ID} (child) diagnostic ===`);
console.log(`email=${email} locale=${locale} schedule=${bot.scheduleId}`);
console.log(`DB current: consular=${bot.currentConsularDate} ${bot.currentConsularTime}  cas=${bot.currentCasDate} ${bot.currentCasTime}`);
console.log(`rescheduleCount=${bot.rescheduleCount} maxReschedules=${bot.maxReschedules}\n`);

// 1) Discover — verifies password and reads ALL groups
console.log('--- discoverAccount (verifies password) ---');
const disc = await discoverAccount(email, password, locale);
console.log(`userId=${disc.userId}`);
console.log(`primary schedule=${disc.scheduleId} applicants=${disc.applicantIds.join(',')} names=${disc.applicantNames.join(' / ')}`);
console.log(`primary current: consular=${disc.currentConsularDate} ${disc.currentConsularTime}  cas=${disc.currentCasDate} ${disc.currentCasTime}`);

// 2) Full login (tokens) + VisaClient targeted at the child's schedule
console.log('\n--- full login + getCurrentAppointment for schedule', bot.scheduleId, '---');
const login = await pureFetchLogin({ email, password, scheduleId: bot.scheduleId, applicantIds: bot.applicantIds, locale }, { visaType: 'iv' });
const client = new VisaClient(
  { cookie: login.cookie, csrfToken: login.csrfToken, authenticityToken: login.authenticityToken },
  {
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    consularFacilityId: bot.consularFacilityId,
    ascFacilityId: bot.ascFacilityId,
    proxyProvider: 'direct' as ProxyProvider,
    userId: disc.userId,
    locale,
  },
);

const current = await client.getCurrentAppointment();
console.log('REAL current appointment (schedule ' + bot.scheduleId + '):', JSON.stringify(current));

// 3) Available consular days
console.log('\n--- available consular days (facility ' + bot.consularFacilityId + ') ---');
const days = await client.getConsularDays();
console.log(`total available days: ${days.length}`);
const inWindow = days.filter(d => d.date >= '2026-06-09' && d.date <= '2026-07-26');
console.log(`days in window 2026-06-09..2026-07-26: ${inWindow.length}`);
console.log('first 20 available dates:', days.slice(0, 20).map(d => d.date).join(', '));
console.log('window dates:', inWindow.map(d => d.date).join(', '));

process.exit(0);

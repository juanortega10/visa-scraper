/**
 * READ-ONLY live appointment check. Fresh login + read current appointment.
 * Does NOT reschedule, does NOT change bot status, does NOT write to DB.
 * Usage: npx tsx --env-file=.env scripts/_live-appt-check.ts --bot-ids=196,207,197
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { performLogin, type LoginCredentials } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import type { ProxyProvider } from '../src/services/proxy-fetch.js';

const arg = process.argv.find(a => a.startsWith('--bot-ids='));
const ids = (arg ? arg.split('=')[1]! : '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.log(`Live read-only check for ${ids.length} bots\n`);
console.log('bot    DB_cita     LIVE_cita   match   LIVE_CAS     estado_DB');
const out: any[] = [];
for (const id of ids) {
  const [bot] = await db.select().from(bots).where(eq(bots.id, id));
  if (!bot) { console.log(`#${id}  NOT FOUND`); continue; }
  let live = 'ERR', liveCas = '-', note = '';
  try {
    const email = decrypt(bot.visaEmail), password = decrypt(bot.visaPassword);
    const creds: LoginCredentials = { email, password, scheduleId: bot.scheduleId, applicantIds: bot.applicantIds, locale: bot.locale ?? 'es-co' };
    const session = await performLogin(creds);
    const client = new VisaClient(session, {
      scheduleId: bot.scheduleId, applicantIds: bot.applicantIds,
      consularFacilityId: bot.consularFacilityId, ascFacilityId: bot.ascFacilityId,
      proxyProvider: bot.proxyProvider as ProxyProvider, userId: bot.userId, locale: bot.locale ?? 'es-co',
    });
    const appt = await client.getCurrentAppointment();
    if (appt) { live = appt.consularDate; liveCas = appt.casDate ?? '-'; }
    else { live = 'null'; note = '(sin cita legible)'; }
  } catch (e: any) { live = 'LOGINERR'; note = (e?.message || '').slice(0, 40); }
  const dbDate = bot.currentConsularDate ?? '-';
  const match = live === dbDate ? 'OK' : 'DIFF';
  console.log(`#${String(id).padEnd(4)} ${String(dbDate).padEnd(11)} ${String(live).padEnd(11)} ${match.padEnd(7)} ${String(liveCas).padEnd(12)} ${bot.status} ${note}`);
  out.push({ id, dbDate, live, match, liveCas, status: bot.status, note });
  await sleep(2500);
}
console.log('\nJSON:' + JSON.stringify(out));
process.exit(0);

/**
 * READ-ONLY live appointment check. Fresh login + read current appointment.
 * Does NOT reschedule, NOT change bot status, NOT write to the bots table.
 * Usage:
 *   npx tsx --env-file=.env scripts/live-appt-check.ts --bot-ids=196,207 [--out=/path/live.json]
 * Output: prints JSON array; if --out given, also writes it there.
 */
import { writeFileSync } from 'fs';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { performLogin, type LoginCredentials } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import type { ProxyProvider } from '../src/services/proxy-fetch.js';

const idsArg = process.argv.find(a => a.startsWith('--bot-ids='));
const outArg = process.argv.find(a => a.startsWith('--out='));
const ids = (idsArg ? idsArg.split('=')[1]! : '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const out: any[] = [];
for (const id of ids) {
  const [bot] = await db.select().from(bots).where(eq(bots.id, id));
  if (!bot) { out.push({ id, ok: false, live: null, note: 'bot not found' }); continue; }
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
    if (appt) out.push({ id, ok: true, live: appt.consularDate, liveCas: appt.casDate ?? null });
    else out.push({ id, ok: false, live: null, note: 'sin cita legible' });
  } catch (e: any) {
    out.push({ id, ok: false, live: null, note: (e?.message || 'login error').slice(0, 60) });
  }
  console.error(`#${id} -> ${out[out.length-1].ok ? out[out.length-1].live : 'ERR:'+out[out.length-1].note}`);
  await sleep(2500);
}
const json = JSON.stringify(out);
if (outArg) { writeFileSync(outArg.split('=')[1]!, json); console.error(`written ${outArg.split('=')[1]}`); }
console.log(json);
process.exit(0);

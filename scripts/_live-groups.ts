/**
 * READ-ONLY live check via DIRECT login (clean IP, retries around tcp blocks).
 * Lists ALL groups/appointments on the account and, per schedule, whether an
 * EARLIER consular slot is available (can be advanced). Writes NOTHING.
 * Usage: npx tsx --env-file=.env scripts/_live-groups.ts <botId>
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { pureFetchLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import { extractGroups } from '../src/services/html-parsers.js';
import { eq } from 'drizzle-orm';

const botId = parseInt(process.argv[2] ?? '231', 10);
const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
if (!bot) { console.error(`bot ${botId} no existe`); process.exit(1); }
const email = decrypt(bot.visaEmail);
const password = decrypt(bot.visaPassword);
const locale = bot.locale ?? 'es-co';
const today = new Date('2026-07-08');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 6): Promise<T | null> {
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) { console.log(`   ${label} intento ${i}/${tries} falló: ${(e as Error).message.slice(0, 60)}`); await sleep(1500); }
  }
  return null;
}

console.log(`Login DIRECTO como ${email} (userId ${bot.userId})...`);
const result = await withRetry('login', () => pureFetchLogin({ email, password, scheduleId: bot.scheduleId, applicantIds: bot.applicantIds, locale }, {}));
if (!result) { console.log('❌ no se pudo loguear tras varios intentos'); process.exit(1); }
const userId = result.userId ?? bot.userId!;
console.log(`  login ok (cookie=${!!result.cookie}), userId=${userId}`);

const mkClient = (scheduleId: string) => new VisaClient(
  { cookie: result.cookie, csrfToken: result.csrfToken ?? '', authenticityToken: result.authenticityToken ?? '' },
  { scheduleId, applicantIds: bot.applicantIds, consularFacilityId: bot.consularFacilityId, ascFacilityId: bot.ascFacilityId,
    proxyProvider: 'direct', userId, locale, captureHtml: true },
);

// Fetch /groups with retries, parse ALL groups
const gclient = mkClient(bot.scheduleId);
await withRetry('groups-fetch', async () => { await gclient.getCurrentAppointment(); const h = (gclient as any).capturedPages?.get('groups-page'); if (!h) throw new Error('sin HTML'); return h; });
const html = (gclient as any).capturedPages?.get('groups-page') as string | undefined;
if (!html) { console.log('❌ no se pudo leer /groups tras reintentos (tcp block persistente)'); process.exit(1); }

const groups = extractGroups(html);
console.log(`\n${'='.repeat(72)}\nCUENTA ${email} — userId ${userId} — ${groups.length} cita(s)\n${'='.repeat(72)}`);

for (const g of groups) {
  const d = g.currentConsularDate ? Math.round((new Date(g.currentConsularDate).getTime() - today.getTime()) / 86400000) : null;
  const bt = await db.select({ id: bots.id, status: bots.status }).from(bots).where(eq(bots.scheduleId, g.scheduleId));
  console.log(`\n▶ schedule ${g.scheduleId} — ${g.applicantNames.join(', ') || '(sin nombre)'}`);
  console.log(`   VISA: ${g.primaryVisaCategory ?? '?'}  | tipos crudos: ${JSON.stringify(g.applicantVisaTypes)}`);
  console.log(`   CONSULAR actual: ${g.currentConsularDate ?? '—'} ${g.currentConsularTime ?? ''} ${d !== null ? `(${d}d, ${d < 0 ? 'PASÓ ⏰' : 'futuro'})` : ''}`);
  console.log(`   CAS actual:      ${g.currentCasDate ?? '—'} ${g.currentCasTime ?? ''}`);
  console.log(`   bot en DB: ${bt.map(x => `#${x.id}(${x.status})`).join(', ') || 'NINGUNO (no rastreado por un bot)'}`);

  // Advanceable? live consular days for this schedule (facility 25 Bogota by default)
  const days = await withRetry(`days ${g.scheduleId}`, () => mkClient(g.scheduleId).getConsularDays(), 4);
  if (!days) { console.log(`   DISPONIBILIDAD: no se pudo leer (tcp block)`); continue; }
  const sorted = days.map((x: any) => x.date).sort();
  const earliest = sorted[0] ?? null;
  if (!earliest) { console.log(`   DISPONIBILIDAD: 0 fechas abiertas ahora`); continue; }
  const canAdvance = g.currentConsularDate ? earliest < g.currentConsularDate : true;
  console.log(`   DISPONIBILIDAD: ${sorted.length} fechas, más temprana ${earliest}` +
    (g.currentConsularDate ? ` → ${canAdvance ? `✅ SE PUEDE ADELANTAR (${earliest} < ${g.currentConsularDate})` : `❌ nada antes de ${g.currentConsularDate}`}` : ''));
  if (canAdvance) console.log(`      próximas: ${sorted.slice(0, 8).join(', ')}`);
}
process.exit(0);

/**
 * READ-ONLY live account check. Fresh login, fetches /groups/{userId}, lists ALL
 * appointments (groups) on the account — including any not tracked by a bot.
 * Writes NOTHING. Usage: npx tsx --env-file=.env scripts/_live-account-check.ts <botId>
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { performLogin, type LoginCredentials } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import { extractGroups } from '../src/services/html-parsers.js';
import { eq } from 'drizzle-orm';

const botId = parseInt(process.argv[2] ?? '231', 10);
const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
if (!bot) { console.log(`bot ${botId} not found`); process.exit(1); }

const email = decrypt(bot.visaEmail);
const password = decrypt(bot.visaPassword);
const locale = bot.locale ?? 'es-co';
console.log(`Login en vivo como ${email} (userId ${bot.userId}, locale ${locale})...`);

const creds: LoginCredentials = { email, password, scheduleId: bot.scheduleId, applicantIds: bot.applicantIds, locale };
const result = await performLogin(creds);
console.log(`  login ok: hasTokens=${!!result.authenticityToken} userId(login)=${result.userId ?? '—'}`);

const userId = result.userId ?? bot.userId;
const client = new VisaClient(
  { cookie: result.cookie, csrfToken: result.csrfToken ?? '', authenticityToken: result.authenticityToken ?? '' },
  { scheduleId: bot.scheduleId, applicantIds: bot.applicantIds, consularFacilityId: bot.consularFacilityId,
    ascFacilityId: bot.ascFacilityId, proxyProvider: 'direct', userId, locale, captureHtml: true },
);

// Trigger fetch of /groups page (captured), then parse ALL groups from raw HTML.
await client.getCurrentAppointment();
const html = (client as any).capturedPages?.get('groups-page') as string | undefined;
if (!html) { console.log('  ⚠ no se capturó la página /groups (login o userId inválido).'); process.exit(0); }

const groups = extractGroups(html);
const archivedIdx = html.search(/[Aa]rchived\s*[Gg]roups/);
console.log(`\n=== /groups/${userId} — ${groups.length} cita(s) activa(s)${archivedIdx > -1 ? ' (+ hay sección Archived)' : ''} ===`);
const today = new Date('2026-07-06');
for (const g of groups) {
  const d = g.currentConsularDate ? Math.round((new Date(g.currentConsularDate).getTime() - today.getTime()) / 86400000) : null;
  const past = d !== null && d < 0;
  console.log(`\n  schedule ${g.scheduleId} — ${g.applicantNames.join(', ') || '(sin nombre)'} [${g.primaryVisaCategory ?? '?'}]`);
  console.log(`     applicants: ${g.applicantIds.join(', ')}`);
  console.log(`     CONSULAR: ${g.currentConsularDate ?? '—'} ${g.currentConsularTime ?? ''}  ${d !== null ? `(${d}d ${past ? '⏰PASÓ' : 'futuro'})` : ''}`);
  console.log(`     CAS/ASC:  ${g.currentCasDate ?? '—'} ${g.currentCasTime ?? ''}`);
  const bt = await db.select({ id: bots.id, status: bots.status }).from(bots).where(eq(bots.scheduleId, g.scheduleId));
  console.log(`     bot(s) en DB para este schedule: ${bt.map(x => `#${x.id}(${x.status})`).join(', ') || 'NINGUNO'}`);
}
if (archivedIdx > -1) {
  const arch = html.slice(archivedIdx);
  const archScheds = [...new Set([...arch.matchAll(/\/schedule\/(\d+)\//g)].map(m => m[1]))];
  console.log(`\n  --- Archived (schedules): ${archScheds.join(', ') || 'ninguno parseable'} ---`);
}
process.exit(0);

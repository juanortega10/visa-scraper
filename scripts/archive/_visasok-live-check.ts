/**
 * READ-ONLY live check for VisasOK bots.
 * Fresh DIRECT login, parses current appointment from /groups/{userId},
 * fetches live consular day availability. Writes NOTHING to DB, changes no status.
 *
 * Usage: npx tsx --env-file=.env scripts/_visasok-live-check.ts
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { performLogin, type LoginCredentials } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import { eq } from 'drizzle-orm';

// botId -> { name, attendAfter (first acceptable date, i.e. day AFTER the "después del X") }
const TARGETS: Record<number, { name: string; afterDate: string }> = {
  180: { name: 'Yajaira',  afterDate: '2026-06-06' }, // después del 6 jun → quiere >= 7 jun
  179: { name: 'luzayve',  afterDate: '2026-06-15' }, // después del 15 jun → quiere >= 16 jun
};

async function checkBot(botId: number, name: string, afterDate: string) {
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) { console.log(`Bot ${botId} not found`); return; }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`Bot ${botId} — ${name}  (schedule ${bot.scheduleId}, userId ${bot.userId})`);
  console.log(`  DB current consular: ${bot.currentConsularDate} ${bot.currentConsularTime} | CAS ${bot.currentCasDate} ${bot.currentCasTime}`);
  console.log(`  Quiere asistir después del ${afterDate} (1ra fecha aceptable >= día siguiente)`);
  console.log('='.repeat(70));

  const email = decrypt(bot.visaEmail);
  const password = decrypt(bot.visaPassword);
  const locale = bot.locale ?? 'es-co';

  const creds: LoginCredentials = { email, password, scheduleId: bot.scheduleId, applicantIds: bot.applicantIds, locale };
  console.log(`Login directo como ${email}...`);
  const result = await performLogin(creds);

  const client = new VisaClient(
    { cookie: result.cookie, csrfToken: result.csrfToken ?? '', authenticityToken: result.authenticityToken ?? '' },
    {
      scheduleId: bot.scheduleId,
      applicantIds: bot.applicantIds,
      consularFacilityId: bot.consularFacilityId,
      ascFacilityId: bot.ascFacilityId,
      proxyProvider: 'direct',
      userId: bot.userId,
      locale,
    },
  );

  // 1) LIVE current appointment
  let liveAppt = null;
  try {
    liveAppt = await client.getCurrentAppointment();
  } catch (e) {
    console.log(`  getCurrentAppointment ERROR: ${(e as Error).message}`);
  }
  if (liveAppt) {
    const matchesDb = liveAppt.consularDate === bot.currentConsularDate;
    console.log(`\n  >>> CITA ACTUAL EN VIVO: consular ${liveAppt.consularDate} ${liveAppt.consularTime} | CAS ${liveAppt.casDate ?? '—'} ${liveAppt.casTime ?? ''}`);
    console.log(`      ${matchesDb ? '✓ coincide con DB' : '⚠ DIFERENTE de la DB (' + bot.currentConsularDate + ')'}`);
  } else {
    console.log(`  >>> No se pudo parsear la cita en vivo (userId nulo o sin grupo).`);
  }

  // 2) LIVE consular day availability
  try {
    const days = await client.getConsularDays();
    const sorted = days.map(d => d.date).sort();
    const earliestOverall = sorted[0] ?? 'ninguna';
    const acceptable = sorted.filter(d => d > afterDate);
    console.log(`\n  Disponibilidad consular EN VIVO: ${days.length} fechas. Más temprana global: ${earliestOverall}`);
    if (acceptable.length) {
      console.log(`      Fechas aceptables (> ${afterDate}): ${acceptable.length}. PRIMERA aceptable: ${acceptable[0]}`);
      console.log(`      Próximas: ${acceptable.slice(0, 8).join(', ')}`);
    } else {
      console.log(`      ⚠ NO hay fechas disponibles después del ${afterDate} en este momento.`);
      console.log(`      Primeras 10 disponibles: ${sorted.slice(0, 10).join(', ')}`);
    }
  } catch (e) {
    console.log(`  getConsularDays ERROR: ${(e as Error).message}`);
  }
}

async function main() {
  for (const [id, t] of Object.entries(TARGETS)) {
    await checkBot(Number(id), t.name, t.afterDate);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

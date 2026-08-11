/**
 * Sonda de disponibilidad por consulado.
 *
 * Responde dos preguntas que no son públicas:
 *   1. ¿Qué consulados ve una cuenta, y cuál es la próxima fecha disponible en cada uno?
 *   2. ¿Puede una cuenta de un país consultar facilities de OTRO país?
 *      (o sea: ¿el facility_id es global o está encerrado en el portal de su locale?)
 *
 * Es solo lectura: hace login y consulta `appointment/days/{facilityId}.json`. Nunca
 * hace POST de reagendamiento, así que no puede mover ni perder la cita de nadie.
 *
 * Escalonado a propósito: un delay entre consultas (default 20s) para no parecer un
 * scraper agresivo sobre una cuenta real. La embajada de EE.UU. en India canceló 2.000
 * citas agendadas por bots; el riesgo de plataforma es real y no vale la pena apurarlo.
 *
 *   npx tsx scripts/probe-facilities.ts --bot 119
 *   npx tsx scripts/probe-facilities.ts --bot 119 --delay 30000
 *   npx tsx scripts/probe-facilities.ts --bot 6 --extra-facilities 70,82,95
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = args.indexOf('--' + n);
  return i >= 0 ? args[i + 1] : d;
};

const botId = Number(flag('bot'));
const delayMs = Number(flag('delay', '20000'));
const extra = (flag('extra-facilities', '') ?? '').split(',').filter(Boolean);

if (!botId) {
  console.error('Uso: npx tsx scripts/probe-facilities.ts --bot <id> [--delay ms] [--extra-facilities 70,82]');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Los facilities que el portal ofrece salen del <select> de la página de cita. */
function parseFacilities(html: string): { id: string; name: string }[] {
  const select =
    html.match(/<select[^>]*consulate_appointment_facility_id[^>]*>([\s\S]*?)<\/select>/i) ??
    html.match(/<select[^>]*facility_id[^>]*>([\s\S]*?)<\/select>/i);
  if (!select) return [];
  const out: { id: string; name: string }[] = [];
  const re = /<option[^>]*value="(\d+)"[^>]*>([^<]*)<\/option>/g;
  let m;
  while ((m = re.exec(select[1])) !== null) {
    out.push({ id: m[1], name: m[2].trim() });
  }
  return out;
}

async function main() {
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) throw new Error(`bot ${botId} no existe`);

  const locale = bot.locale ?? 'es-co';
  console.log(`Bot ${bot.id} · ${locale} · schedule ${bot.scheduleId} · status ${bot.status}`);
  console.log(`Delay entre consultas: ${delayMs / 1000}s\n`);

  const email = decrypt(bot.visaEmail);
  const password = decrypt(bot.visaPassword);
  const applicantIds = (bot.applicantIds ?? []) as string[];

  const session = await performLogin({ email, password, scheduleId: bot.scheduleId, applicantIds, locale });
  console.log('Login OK\n');

  // getConsularDays() lee el facility de la config, así que para sondear otro consulado
  // se arma un cliente nuevo sobre la MISMA sesión. No hay re-login por consulado.
  const clientFor = (facilityId: string) =>
    new VisaClient(session, {
      scheduleId: bot.scheduleId,
      applicantIds,
      consularFacilityId: facilityId,
      ascFacilityId: bot.ascFacilityId ?? '',
      proxyProvider: (bot.proxyProvider ?? 'direct') as 'direct',
      proxyUrls: bot.proxyUrls as string[] | null,
      userId: bot.userId,
      locale,
      captureHtml: true,
    });

  const client = clientFor(bot.consularFacilityId);

  // El <select> con todos los consulados vive en la página de cita, que se baja en
  // refreshTokens() (getCurrentAppointment() trae la página de grupos, sin el select).
  // refreshTokens() baja la página en directo (necesita el authenticity_token del form),
  // y la embajada bloquea las IPs residenciales: desde un portátil da embassy_block.
  // No es fatal para el sondeo — performLogin ya dejó tokens válidos y las consultas de
  // días van por AJAX/proxy. Si falla, se pierde el autodescubrimiento, no la medición.
  let html = '';
  try {
    await client.refreshTokens();
    html = client.getCapturedPages().get('appointment-page') ?? '';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`(sin autodescubrimiento de consulados: ${msg.slice(0, 60)})`);
    console.log('(se sondea el facility propio como control + los pasados en --extra-facilities)\n');
  }
  const discovered = parseFacilities(html);
  if (discovered.length === 0 && html) {
    console.log('(no se encontró el <select> de consulados; se sondea solo el propio)');
  }
  if (!discovered.some((f) => f.id === bot.consularFacilityId)) {
    // Control obligatorio: sin el facility propio no se puede distinguir "bloqueado"
    // de "sin disponibilidad" cuando un facility ajeno devuelve cero.
    discovered.unshift({ id: bot.consularFacilityId, name: '(el propio — control)' });
  }

  console.log(`Consulados que ofrece el portal para esta cuenta: ${discovered.length}`);
  for (const f of discovered) console.log(`  ${f.id.padStart(3)} · ${f.name}`);
  console.log('');

  const targets = [
    ...discovered.map((f) => ({ ...f, propio: true })),
    ...extra
      .filter((id) => !discovered.some((f) => f.id === id))
      .map((id) => ({ id, name: '(ajeno al locale — prueba de frontera)', propio: false })),
  ];

  const results: Record<string, unknown>[] = [];
  for (const [i, t] of targets.entries()) {
    if (i > 0) await sleep(delayMs);
    try {
      const days = await clientFor(t.id).getConsularDays();
      const first = days?.[0]?.date ?? null;
      const diasDesdeHoy = first
        ? Math.round((new Date(first).getTime() - Date.now()) / 86400000)
        : null;
      console.log(
        `  ${t.id.padStart(3)} ${t.name.slice(0, 34).padEnd(36)} ${
          first ? `próxima ${first} (${diasDesdeHoy}d)` : 'sin fechas'
        }  [${days?.length ?? 0} días ofrecidos]`,
      );
      results.push({ ...t, primeraFecha: first, diasDesdeHoy, totalDias: days?.length ?? 0 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ${t.id.padStart(3)} ${t.name.slice(0, 34).padEnd(36)} ERROR: ${msg.slice(0, 70)}`);
      results.push({ ...t, error: msg.slice(0, 200) });
    }
  }

  const propios = results.filter((r) => r.propio);
  const ajenos = results.filter((r) => !r.propio);
  const controlVivo = propios.some((r) => !r.error && (r.totalDias as number) > 0);

  if (!controlVivo) {
    // Sin control positivo no se puede concluir NADA: una cuenta cuya cita ya pasó (o
    // que no es elegible para reagendar) devuelve cero en TODOS los consulados, propios
    // y ajenos. Leer eso como "frontera cerrada" sería confundir la sonda con el dato.
    console.log(
      '\n⚠️  SONDEO NO CONCLUYENTE: ningún consulado propio devolvió fechas.\n' +
        '   La cuenta no está viendo disponibilidad (cita vencida, no elegible o sesión sin permisos),\n' +
        '   así que los ceros no distinguen "sin cupos" de "bloqueado". Repetir con una cuenta\n' +
        '   que tenga cita futura viva antes de sacar conclusiones.',
    );
  } else if (ajenos.length > 0) {
    const alguno = ajenos.some((r) => !r.error && (r.totalDias as number) > 0);
    console.log(
      `\nFrontera entre países: ${
        alguno
          ? 'PERMEABLE — una cuenta pudo leer un facility ajeno a su locale'
          : 'CERRADA — con el control en positivo, el facility ajeno devuelve vacío'
      }`,
    );
  }

  console.log('\n' + JSON.stringify(results, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

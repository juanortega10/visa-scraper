/**
 * SNIPER DE PERU · bot 299 (Luiggi) · POC.
 *
 * Por que existe: `phase_aligned` no sirve cuando el bot va por cron cada 2 min.
 * El cron decide el momento, no nosotros. Este proceso si controla la fase: duerme
 * hasta el segundo 14 UTC de cada minuto y pide `days.json` ahi.
 *
 * Ventana medida para es-pe con `scripts/analyze-release-clock.ts` el 2026-08-27:
 * las fechas a menos de 6 meses salen en s15-24 al 6,2% (5,15x la media). Fuera de
 * ese tramo la tasa cae a 0,1-0,5%.
 *
 * Camino en el disparo (todo dentro de la ventana):
 *   1  `days.json`            ~0,8 s
 *   2  `times.json`           ~0,7 s
 *   3  POST con el token YA precalentado (no se pide en el momento)
 *   4  verificacion contra `/groups`
 *
 * El token se refresca por rutina cada 10 min, FUERA del camino critico. Techo duro
 * de edad 45 min. Ver `POLITICA_TOKEN` en `peru-sniper-core.ts`.
 *
 * Seguridad: los verificadores V1-V7 de `peru-sniper-core.ts` mas un reclamo
 * ATOMICO del cupo en la base de datos, con la misma consulta que `claimSlot()` de
 * `reschedule-logic.ts`. Eso evita que la cadena normal de `poll-visa` y este
 * proceso gasten dos disparos. En Peru el portal permite 2 y el bloqueo es
 * irreversible.
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/peru-sniper-299.ts             # DRY-RUN
 *   npx tsx --env-file=.env scripts/peru-sniper-299.ts --commit    # real
 *   npx tsx --env-file=.env scripts/peru-sniper-299.ts --una-vuelta
 */
import { eq, and, or, sql, lt, gt, isNull } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { bots, rescheduleLogs } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { loginWithFallback } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import {
  elegirFecha, verificarDisparo, cupoEfectivo, veredictoToken, POLITICA_TOKEN,
  msHastaSegundo, enVentana, VENTANA_PE,
  type SniperPeruConfig, type EstadoToken,
} from '../src/services/peru-sniper-core.js';

const BOT_ID = Number(process.env.SNIPER_BOT_ID ?? 299);
const COMMIT = process.argv.includes('--commit');
const UNA_VUELTA = process.argv.includes('--una-vuelta');

/** Segundo del minuto UTC en que arranca el disparo. La respuesta cae en s15-24. */
const SEGUNDO_TICK = 14;
/** Edad maxima de la sesion antes de re-login preventivo. El TTL duro del portal es ~1h28m. */
const SESION_MAX_MS = 44 * 60_000;
/** Una fecha que fallo el POST no se reintenta durante este tiempo. */
const QUEMADA_MS = 20 * 60_000;
/** Errores seguidos antes de una pausa larga. Evita golpear al portal si algo se rompio. */
const ERRORES_PARA_PAUSA = 5;
const PAUSA_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hoyUtc = () => new Date().toISOString().slice(0, 10);
const log = (...p: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}Z]`, ...p);

type FilaBot = typeof bots.$inferSelect;

interface Sesion {
  client: VisaClient;
  creadaMs: number;
  token: EstadoToken | null;
}

let sesion: Sesion | null = null;
const quemadas = new Map<string, number>();

/** Fila del bot, leida en vivo. Nunca se cachea: el cupo puede cambiar por fuera. */
async function leerBot(): Promise<FilaBot> {
  const [row] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
  if (!row) throw new Error(`bot ${BOT_ID} no existe`);
  return row;
}

function configDe(row: FilaBot, citaPortal: string | null): SniperPeruConfig {
  return {
    citaActual: citaPortal,
    metaAntesDe: row.targetDateBefore ?? null,
    minDiasDesdeHoy: row.minDaysFromToday ?? 1,
    nuestroMax: row.maxReschedules ?? null,
    nuestroCount: row.rescheduleCount ?? 0,
    portalRestante: row.portalRemainingReschedules ?? null,
    usaCas: !!row.ascFacilityId && !row.skipCas,
  };
}

/** Abre sesion nueva: login y token recien emitido. */
async function abrirSesion(row: FilaBot): Promise<Sesion> {
  const { result: login, via } = await loginWithFallback({
    email: decrypt(row.visaEmail as string),
    password: decrypt(row.visaPassword as string),
    scheduleId: String(row.scheduleId),
    applicantIds: (row.applicantIds ?? []) as string[],
    locale: row.locale ?? 'es-pe',
  });
  const client = new VisaClient(
    { cookie: login.cookie, csrfToken: login.csrfToken ?? '', authenticityToken: login.authenticityToken ?? '' },
    {
      scheduleId: String(row.scheduleId),
      applicantIds: (row.applicantIds ?? []) as string[],
      consularFacilityId: String(row.consularFacilityId ?? '115'),
      ascFacilityId: String(row.ascFacilityId ?? ''),
      proxyProvider: row.proxyProvider,
      postProvider: row.proxyProvider,
      proxyUrls: row.proxyUrls as string[] | null,
      locale: row.locale ?? 'es-pe',
      userId: row.userId ? String(row.userId) : null,
    },
  );
  log(`  [sesion] login por ${via}, cookie ${login.cookie.length} bytes`);
  const s: Sesion = { client, creadaMs: Date.now(), token: null };
  await precalentar(s);
  return s;
}

/**
 * Pide `authenticity_token` nuevo y lo ata a la cookie que lo emitio.
 *
 * Esto va SIEMPRE fuera del camino critico. `refreshTokens()` es un GET a la pagina
 * del formulario y tarda ~1,4 s. Hacerlo en el momento del disparo gasta la mitad
 * de la ventana de 10 s.
 */
async function precalentar(s: Sesion): Promise<boolean> {
  try {
    await s.client.refreshTokens();
    const ses = s.client.getSession();
    if (!ses.authenticityToken) { log('  [token] la pagina no trae authenticity_token'); s.token = null; return false; }
    s.token = { emitidoMs: Date.now(), cookie: ses.cookie, token: ses.authenticityToken };
    return true;
  } catch (e) {
    log(`  [token] refresco fallo: ${(e as Error).message}`);
    s.token = null;
    return false;
  }
}

/** Devuelve una sesion con token utilizable. Re-login si la sesion es vieja o el token murio. */
async function sesionLista(row: FilaBot): Promise<Sesion> {
  if (sesion && Date.now() - sesion.creadaMs > SESION_MAX_MS) {
    log('  [sesion] pasa de 44 min. Re-login preventivo.');
    sesion = null;
  }
  if (!sesion) sesion = await abrirSesion(row);

  const ses = sesion.client.getSession();
  const v = veredictoToken(sesion.token, ses.cookie, Date.now(), POLITICA_TOKEN);
  if (v === 'refrescar') {
    log('  [token] paso la cadencia de 10 min. Refresco por rutina.');
    await precalentar(sesion);
  } else if (v === 'vencido') {
    log('  [token] vencido o atado a otra cookie. Refresco obligatorio.');
    if (!(await precalentar(sesion))) {
      log('  [token] sin token tras el refresco. Re-login completo.');
      sesion = await abrirSesion(row);
    }
  }
  return sesion;
}

/**
 * Reclamo ATOMICO del cupo. Misma consulta que `claimSlot()` de `reschedule-logic.ts`.
 * Sube nuestro contador y baja el saldo del portal en un solo UPDATE. Si otra
 * cadena ya lo tomo, este UPDATE no devuelve filas y el disparo se cancela.
 */
async function reclamarCupo(): Promise<boolean> {
  const filas = await db.update(bots)
    .set({
      rescheduleCount: sql`${bots.rescheduleCount} + 1`,
      portalRemainingReschedules: sql`GREATEST(0, COALESCE(${bots.portalRemainingReschedules}, 1) - 1)`,
    })
    .where(and(
      eq(bots.id, BOT_ID),
      or(isNull(bots.maxReschedules), lt(bots.rescheduleCount, bots.maxReschedules)),
      or(isNull(bots.portalRemainingReschedules), gt(bots.portalRemainingReschedules, 0)),
    ))
    .returning({ rescheduleCount: bots.rescheduleCount });
  return filas.length > 0;
}

/** Devuelve el cupo cuando el POST no dejo la cita. */
async function devolverCupo(motivo: string): Promise<void> {
  await db.update(bots)
    .set({
      rescheduleCount: sql`GREATEST(${bots.rescheduleCount} - 1, 0)`,
      portalRemainingReschedules: sql`COALESCE(${bots.portalRemainingReschedules}, 0) + 1`,
    })
    .where(eq(bots.id, BOT_ID));
  log(`  [cupo] devuelto (${motivo})`);
}

interface Resultado { agendado: boolean; fatal?: string }

/** Una vuelta completa: pedir dias, verificar, y disparar si todo cierra. */
async function vuelta(): Promise<Resultado> {
  const row = await leerBot();

  if (row.status !== 'active') { log(`  bot ${BOT_ID} en estado ${row.status}. No se dispara.`); return { agendado: false }; }

  const cupoDb = cupoEfectivo(configDe(row, row.currentConsularDate));
  if (cupoDb.quedan <= 0) return { agendado: false, fatal: `sin cupo (tope ${cupoDb.topeDe})` };

  const s = await sesionLista(row);

  // 1 · dias. Es la unica peticion en la vuelta normal.
  const t0 = Date.now();
  const dias = await s.client.getConsularDays();
  const msDias = Date.now() - t0;

  const cfgPrevia = configDe(row, row.currentConsularDate);
  const fecha = elegirFecha(dias as Array<{ date: string }>, cfgPrevia, hoyUtc());
  const quemadaHasta = fecha ? quemadas.get(fecha) ?? 0 : 0;

  if (!fecha) {
    log(`  dias ${dias.length} · ${msDias} ms · nada util (cita ${row.currentConsularDate}, meta < ${row.targetDateBefore})`);
    return { agendado: false };
  }
  if (Date.now() < quemadaHasta) {
    log(`  ${fecha} quemada hasta ${new Date(quemadaHasta).toISOString().slice(11, 19)}Z. Se salta.`);
    return { agendado: false };
  }

  log(`  DETECCION ${fecha} · dias ${dias.length} · ${msDias} ms · ventana ${enVentana(Date.now()) ? 'SI' : 'NO'}`);

  // 2 · la cita actual sale del PORTAL, no de la base de datos. La regla critica se
  //     verifica contra lo que el portal dice hoy.
  const apt = await s.client.getCurrentAppointment();
  const cfg = configDe(row, apt?.consularDate ?? null);
  log(`  portal dice cita ${apt?.consularDate ?? '(no leida)'} ${apt?.consularTime ?? ''}`);

  // 3 · horas
  const horas = ((await s.client.getConsularTimes(fecha)).available_times ?? []).filter(Boolean) as string[];
  if (!horas.length) {
    log(`  ${fecha} sin horas. Se quema 20 min.`);
    quemadas.set(fecha, Date.now() + QUEMADA_MS);
    return { agendado: false };
  }
  // La ultima hora del dia compite menos que la primera.
  const hora = horas[horas.length - 1]!;

  // 4 · verificadores duros
  const fallos = verificarDisparo(fecha, hora, cfg, hoyUtc());
  if (fallos.length) {
    log(`  ABORTA. ${fallos.length} verificador(es):`);
    for (const f of fallos) log(`    · ${f}`);
    quemadas.set(fecha, Date.now() + QUEMADA_MS);
    return { agendado: false };
  }

  // 5 · el token debe estar vivo AHORA, no cuando se precalento
  const ses = s.client.getSession();
  if (veredictoToken(s.token, ses.cookie, Date.now(), POLITICA_TOKEN) === 'vencido') {
    log('  ABORTA: el token vencio justo antes del POST. Se refresca para la proxima.');
    await precalentar(s);
    return { agendado: false };
  }

  const edadTokenS = Math.round((Date.now() - (s.token?.emitidoMs ?? 0)) / 1000);
  log(`  LISTO → ${fecha} ${hora} (de ${horas.length} horas) · token de ${edadTokenS} s · cita actual ${cfg.citaActual}`);

  if (!COMMIT) {
    log('  DRY-RUN. No se manda el POST.');
    return { agendado: false };
  }

  // 6 · reclamo atomico. Solo despues de esto se toca el portal.
  if (!(await reclamarCupo())) {
    log('  ABORTA: otra cadena ya tomo el cupo (UPDATE atomico sin filas).');
    return { agendado: false, fatal: 'cupo tomado por otra cadena' };
  }

  // 7 · UN solo POST por deteccion. Sin reintento a ciegas.
  const tPost = Date.now();
  let dijoOk = false;
  let errPost: string | null = null;
  try { dijoOk = await s.client.reschedule(fecha, hora); }
  catch (e) { errPost = (e as Error).message; }
  log(`  POST → ${dijoOk ? 'dice OK' : `dice NO (${errPost ?? 'sin excepcion'})`} · ${Date.now() - tPost} ms`);

  // 8 · verificacion contra el portal. El POST miente: ver `followRedirectChain`.
  await sleep(2500);
  let real: Awaited<ReturnType<VisaClient['getCurrentAppointment']>> = null;
  try { real = await s.client.getCurrentAppointment(); }
  catch (e) { log(`  verificacion fallo: ${(e as Error).message}`); }
  const quedo = real?.consularDate === fecha;
  log(`  portal ahora: ${real?.consularDate ?? '?'} ${real?.consularTime ?? ''} → ${quedo ? 'QUEDO' : 'NO QUEDO'}`);

  await db.insert(rescheduleLogs).values({
    botId: BOT_ID,
    oldConsularDate: cfg.citaActual, oldConsularTime: apt?.consularTime ?? null,
    newConsularDate: quedo ? fecha : null, newConsularTime: quedo ? hora : null,
    success: quedo,
    provider: row.proxyProvider,
    failStep: quedo ? null : 'post_reschedule',
    failReason: quedo ? null : (errPost ? 'post_error' : 'post_failed'),
    error: quedo ? null : `[peru_sniper] dijoOk=${dijoOk} objetivo=${fecha} ${hora} real=${real?.consularDate ?? '?'} ${errPost ?? ''}`,
    detail: { source: 'peru-sniper-299', horasVistas: horas, edadTokenS, msDias },
  });

  if (quedo && real) {
    await db.update(bots).set({
      currentConsularDate: real.consularDate,
      currentConsularTime: real.consularTime,
      updatedAt: new Date(),
    }).where(eq(bots.id, BOT_ID));
    log(`  *** AGENDADO ${real.consularDate} ${real.consularTime} ***`);
    return { agendado: true };
  }

  // El POST no dejo la cita: el cupo vuelve, y la fecha se quema para no insistir.
  await devolverCupo('el POST no dejo la cita');
  quemadas.set(fecha, Date.now() + QUEMADA_MS);
  sesion = null;   // un POST fallido puede ensuciar los tokens
  return { agendado: false };
}

async function main() {
  const row = await leerBot();
  const cupo = cupoEfectivo(configDe(row, row.currentConsularDate));
  log('═══ SNIPER PERU · bot ' + BOT_ID + ' ═══');
  log(`  modo: ${COMMIT ? '*** COMMIT (REAL) ***' : 'DRY-RUN'}${UNA_VUELTA ? ' · una vuelta' : ''}`);
  log(`  cita ${row.currentConsularDate} ${row.currentConsularTime} · meta antes de ${row.targetDateBefore}`);
  log(`  cupo ${cupo.quedan} (tope ${cupo.topeDe}) · nuestro ${row.rescheduleCount}/${row.maxReschedules} · portal ${row.portalRemainingReschedules}`);
  log(`  fase: 1 peticion por minuto en el segundo ${SEGUNDO_TICK} UTC · ventana s${VENTANA_PE.inicioSeg}-${VENTANA_PE.finSeg - 1}`);
  log(`  token: refresco cada ${POLITICA_TOKEN.cadenciaMs / 60000} min, techo ${POLITICA_TOKEN.techoMs / 60000} min`);

  let errores = 0;
  for (;;) {
    await sleep(msHastaSegundo(Date.now(), SEGUNDO_TICK));
    try {
      const r = await vuelta();
      errores = 0;
      if (r.agendado) { log('  objetivo cumplido. Fin.'); break; }
      if (r.fatal) { log(`  ALTO: ${r.fatal}. Fin.`); break; }
    } catch (e) {
      errores += 1;
      sesion = null;
      log(`  ERROR (${errores}/${ERRORES_PARA_PAUSA}): ${(e as Error).message}`);
      if (errores >= ERRORES_PARA_PAUSA) {
        log(`  ${ERRORES_PARA_PAUSA} errores seguidos. Pausa de ${PAUSA_MS / 60000} min.`);
        await sleep(PAUSA_MS);
        errores = 0;
      }
    }
    if (UNA_VUELTA) break;
  }
  process.exit(0);
}

main().catch((e) => { log('FATAL:', (e as Error).stack ?? (e as Error).message); process.exit(1); });

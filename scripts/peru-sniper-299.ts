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
 * El token se refresca por rutina cada 30 min, FUERA del camino critico. Techo duro
 * de edad 45 min. Ver `POLITICA_TOKEN` en `peru-sniper-core.ts`. Cuando el refresco
 * FALLA, `intentarToken` espacia los reintentos en vez de pedirlo en cada vuelta.
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
import { bots, rescheduleLogs, sniperScans } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { loginWithFallback } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import {
  elegirFecha, verificarDisparo, cupoEfectivo, veredictoToken, POLITICA_TOKEN,
  tocaDisparar, minutosEntreDisparos,
  msHastaProximoTick, enVentana, VENTANA_PE,
  type SniperPeruConfig, type EstadoToken,
} from '../src/services/peru-sniper-core.js';

const BOT_ID = Number(process.env.SNIPER_BOT_ID ?? 299);
const COMMIT = process.argv.includes('--commit');
const UNA_VUELTA = process.argv.includes('--una-vuelta');

/**
 * Segundos del minuto UTC en que se dispara. DOS por minuto, a proposito.
 *
 * El borde de liberacion cae en el segundo 14-15 UTC (ver [[release-clock-second-14]]).
 * Con `days.json` en 235-1.100 ms, un solo disparo en s14 puede llegar justo ANTES
 * de la liberacion y perder el cupo por un minuto entero. El de s18 lo recoge.
 */
const SEGUNDOS_TICK = [14, 18] as const;
/** Edad maxima de la sesion antes de re-login preventivo. El TTL duro del portal es ~1h28m. */
const SESION_MAX_MS = 44 * 60_000;
/** Una fecha que fallo el POST no se reintenta durante este tiempo. */
const QUEMADA_MS = 20 * 60_000;

/** Clave del sniper en `sniper_scans`. La pagina /dashboard/peru la lee. */
const SCAN_KEY = 'peru-299';
/** Cada cuanto se escribe un latido aunque nada cambie. */
const LATIDO_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hoyUtc = () => new Date().toISOString().slice(0, 10);
const log = (...p: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}Z]`, ...p);

type FilaBot = typeof bots.$inferSelect;

interface Sesion {
  client: VisaClient;
  creadaMs: number;
  /** Identidad de esta sesion. Cambia solo con un login nuevo. */
  id: string;
  token: EstadoToken | null;
}

let sesion: Sesion | null = null;
const quemadas = new Map<string, number>();
/** Estado del ultimo escaneo escrito. Sirve para el patron cambio mas latido. */
let ultimoEscaneo: { masTemprana: string; enMs: number } | null = null;

/**
 * Deja constancia de cada vuelta en `sniper_scans`, para que
 * `/dashboard/peru?bot=299` muestre si el sniper vive y que ofrece el portal.
 *
 * Escribe solo cuando la fecha mas temprana CAMBIA, o cada 5 min como latido.
 * A 2 vueltas por minuto, escribir todo serian 2.880 filas por dia. Con esta
 * regla quedan ~290, y la pagina sigue viendo lo mismo.
 */
/**
 * Metricas del camino critico. Todas se miden con `Date.now()` sobre codigo que ya
 * corria, entonces el costo es una resta por vuelta. Ninguna agrega una peticion.
 */
export interface MetricasCamino {
  /** Milisegundos que costo leer la fila del bot. Con la copia en memoria debe ser ~0. */
  msLeerBot?: number;
  /** Segundo del minuto UTC en que SALIO `days.json`. La ventana de es-pe es s15-s24. */
  segundoTick?: number;
  /** De la respuesta de `days.json` hasta lanzar la peticion de horas. Es el tiempo REGALADO. */
  msDiasAHoras?: number;
  /** Reloj de pared de las dos peticiones en paralelo. */
  msCarrera?: number;
  /** Cada una por separado. Si `msCarrera` se parece a la suma, el paralelo se rompio. */
  msTimes?: number;
  msApt?: number;
  /** true = el token ya estaba precalentado y no se pidio la pagina del appointment. */
  tokenPrecalentado?: boolean;
  /** Vuelta completa, de leer el bot a decidir. */
  msVuelta?: number;
  /** Motivo si alguna de las dos peticiones del ensayo fallo. null = las dos bien. */
  falloEnsayo?: string | null;
  /**
   * Cuantas horas devolvio `times.json` para la fecha del ensayo.
   *
   * Es la respuesta a "cuando HAY horas de verdad". `days.json` lista un dia; solo
   * `times.json` dice si ese dia se puede reservar. Historicamente el bot 299 tiene
   * DOS muestras de times.json en toda su vida, las dos vacias (2026-08-27). Sin este
   * campo no hay con que armar el histograma de disponibilidad real.
   */
  horasEncontradas?: number | null;
  /**
   * CUALES horas, no solo cuantas. Es lo que decide si se puede adivinar la hora y
   * saltarse `times.json`. Hoy `SPECULATIVE_TIMES` en `reschedule-logic.ts` apuesta a
   * ['10:15','10:00','07:30'] sin respaldo medido para es-pe: las 354 apariciones de
   * ese trio en la base son la CONSTANTE del propio fallback, no lecturas del portal.
   */
  horas?: string[] | null;
  /**
   * `business_times` de la MISMA respuesta. Es el horario del consulado para ese dia,
   * o sea TODAS las horas posibles, libres o no. `horas` es el subconjunto libre.
   *
   * Medido en el bot 7 el 2026-08-31:
   *   2028-01-12  available ["09:45"]  business ["09:45","10:00","10:15","10:30"]
   *
   * Es la lista de candidatos EXACTA para adivinar una hora, y viene gratis. Si un dia
   * `horas` sale vacio y esto sale lleno, ahi esta la respuesta a las especulativas.
   */
  horasNegocio?: string[] | null;
  /** La fecha que se le pregunto a `times.json`. Contexto del numero de arriba. */
  fechaEnsayo?: string | null;
  /** Dias entre hoy y la fecha del ensayo. La disponibilidad depende de la distancia. */
  diasHastaFecha?: number | null;
}

async function registrarEscaneo(args: {
  masTemprana: string; dias: number; msDias: number; fase: string;
  ventanaFin: string | null; edadTokenS: number | null;
  metricas?: MetricasCamino;
  /** Salta la regla de latido: el ensayo siempre se escribe. */
  siempre?: boolean;
}): Promise<void> {
  const cambio = ultimoEscaneo?.masTemprana !== args.masTemprana;
  const viejo = !ultimoEscaneo || Date.now() - ultimoEscaneo.enMs > LATIDO_MS;
  if (!args.siempre && !cambio && !viejo) return;
  // El sello se marca ANTES del viaje a Neon. Sin esto, dos vueltas seguidas
  // dispararian dos INSERT del mismo latido mientras el primero sigue en vuelo.
  //
  // El ENSAYO no toca el sello. Escribe con `siempre: true` cada 10 min, y si moviera
  // el reloj del latido le robaria turnos a los ticks normales: medido el 2026-08-30,
  // `buscando` bajo de 11 filas por hora a 6. Son dos flujos distintos y cada uno
  // lleva su propia cadencia.
  if (!args.siempre) ultimoEscaneo = { masTemprana: args.masTemprana, enMs: Date.now() };
  try {
    await db.insert(sniperScans).values({
      scanKey: SCAN_KEY,
      windowStart: hoyUtc(),
      windowEnd: args.ventanaFin ?? hoyUtc(),
      phase: args.fase,
      payload: {
        masTemprana: args.masTemprana, dias: args.dias, msDias: args.msDias,
        edadTokenS: args.edadTokenS, segundosTick: [...SEGUNDOS_TICK],
        ventanaSeg: [VENTANA_PE.inicioSeg, VENTANA_PE.finSeg - 1],
        ...(args.metricas ?? {}),
      },
    });
  } catch (e) {
    // El sello se revierte para que el latido se reintente en la vuelta siguiente.
    if (!args.siempre) ultimoEscaneo = null;
    log(`  [escaneo] no se pudo registrar: ${(e as Error).message}`);
  }
}

/**
 * Registra el escaneo SIN esperar el viaje a Neon.
 *
 * Medido desde el RPi el 2026-08-30: un INSERT a Neon (us-east-1) tarda 87-90 ms
 * de mediana. Esos 90 ms caian entre ver el cupo en `days.json` y pedir las horas,
 * que es la carrera que el sniper existe para ganar. Es telemetria: no decide nada,
 * entonces no bloquea. El error ya se maneja adentro.
 */
function registrarEscaneoSinEsperar(args: Parameters<typeof registrarEscaneo>[0]): void {
  void registrarEscaneo(args);
}

/** Fila del bot, leida en vivo contra Neon. */
async function leerBotEnVivo(): Promise<FilaBot> {
  const [row] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
  if (!row) throw new Error(`bot ${BOT_ID} no existe`);
  return row;
}

/**
 * Fila del bot en memoria, con refresco de fondo.
 *
 * Neon vive en us-east-1 y desde el RPi cada consulta cuesta 87-90 ms de mediana
 * (medido el 2026-08-30). Esa lectura corria ANTES de `days.json`, o sea que el
 * sniper llegaba 90 ms tarde a cada tick sin ganar nada.
 *
 * Por que es seguro cachearla: ninguna de las tres decisiones duras depende de esta
 * copia.
 *
 *   1. La cita actual sale del PORTAL (`getCurrentAppointment`), nunca de aqui.
 *      Lo dice V2 de `verificarDisparo`, y sin cita leida el disparo se cancela.
 *   2. El cupo se toma con un UPDATE atomico contra Neon (`reclamarCupo`). Si otro
 *      proceso ya lo consumio, ese UPDATE no devuelve filas y el disparo se cancela.
 *   3. `status` y `targetDateBefore` solo estrechan la busqueda. Una copia de hasta
 *      60 s ordena igual, y los verificadores duros vuelven a correr contra el
 *      portal antes del POST.
 *
 * El refresco sale sin esperar: la vuelta usa la copia que ya tiene.
 */
const EDAD_MAX_FILA_MS = 60_000;
let filaBot: { row: FilaBot; enMs: number } | null = null;
let refrescoEnVuelo: Promise<void> | null = null;

function refrescarFilaSinEsperar(): void {
  if (refrescoEnVuelo) return;
  refrescoEnVuelo = leerBotEnVivo()
    .then((row) => { filaBot = { row, enMs: Date.now() }; })
    .catch((e) => { log(`  [fila] refresco fallo: ${(e as Error).message}`); })
    .finally(() => { refrescoEnVuelo = null; });
}

async function leerBot(): Promise<FilaBot> {
  if (!filaBot) {
    // Arranque en frio: la primera vuelta si espera.
    filaBot = { row: await leerBotEnVivo(), enMs: Date.now() };
    return filaBot.row;
  }
  if (Date.now() - filaBot.enMs > EDAD_MAX_FILA_MS) refrescarFilaSinEsperar();
  return filaBot.row;
}

/** Invalida la copia. Se llama tras cualquier escritura propia sobre `bots`. */
function olvidarFila(): void {
  filaBot = null;
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
  const s: Sesion = { client, creadaMs: Date.now(), id: `ses-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, token: null };
  // Por `intentarToken` y no por `precalentar` directo: si la ruta del schedule esta
  // cerrada, un login nuevo no es motivo para volver a golpearla fuera del espaciado.
  await intentarToken(s);
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
    s.token = { emitidoMs: Date.now(), sesionId: s.id, token: ses.authenticityToken };
    return true;
  } catch (e) {
    log(`  [token] refresco fallo: ${(e as Error).message}`);
    s.token = null;
    return false;
  }
}

/**
 * Prueba si la COOKIE sigue sirviendo, sin tocar la ruta del schedule.
 *
 * `getCurrentAppointment()` pega a `/groups/{userId}`, que es una ruta distinta de
 * `/schedule/{id}/...`. Ese detalle es todo el valor de esta funcion.
 *
 * Medido el 2026-08-31 en el bot 299, por las DOS rutas de salida:
 *
 *   appointment  direct FALLO   webshare FALLO
 *   days.json    direct FALLO   webshare FALLO
 *   groups       direct 200     webshare 200     <- la cookie esta sana
 *
 * Sin esta prueba, el sniper leia el fallo de `refreshTokens()` como "la sesion
 * murio" y hacia un login completo. Con la ruta cerrada eso se repetia en cada
 * disparo: 4 IPs quemadas en el token, mas un login, mas 4 IPs en `days.json`.
 * El login es el endpoint mas vigilado del portal, y esa presion alarga el bloqueo
 * en vez de dejarlo expirar.
 *
 * Devuelve `false` solo si la cookie de verdad no sirve. Un fallo de red tambien
 * devuelve `false`, y ahi el re-login es la respuesta correcta de todos modos.
 */
async function cookieSigueViva(s: Sesion): Promise<boolean> {
  try {
    return (await s.client.getCurrentAppointment()) !== null;
  } catch (e) {
    log(`  [sesion] la prueba de /groups fallo: ${(e as Error).message}`);
    return false;
  }
}

// ── Espaciado de los reintentos del token ────────────────────────────────────

let ultimoIntentoTokenMs = 0;
let fallosTokenSeguidos = 0;

/**
 * Pide el token respetando un espaciado que crece con los fallos seguidos.
 *
 * Por que existe. `POLITICA_TOKEN.cadenciaMs` solo gobierna un token QUE EXISTE.
 * Un token en `null` siempre da `vencido`, y eso pedia "refresco obligatorio" en
 * cada vuelta. Medido en el RPi el 2026-08-31 con la ruta cerrada: 7 intentos en
 * 20 min, o sea unas 500 lecturas al dia de `/schedule/{id}/appointment`. Es MAS
 * carga que las 144 al dia que la cadencia de 30 min queria bajar a 48.
 *
 * Reusa `minutosEntreDisparos` (0/1/2/5/10 min) para no inventar una segunda curva.
 * Con la ruta cerrada el espaciado llega a 10 min, o sea 6 intentos por hora.
 * Al primer exito el contador vuelve a cero y el token se recupera en la vuelta
 * siguiente, entonces reabrir la ruta no cuesta mas de 10 min de retraso.
 *
 * `aplazado` NO es un fallo: dice que todavia no toca reintentar.
 */
async function intentarToken(s: Sesion): Promise<'ok' | 'fallo' | 'aplazado'> {
  if (!tocaDisparar(fallosTokenSeguidos, ultimoIntentoTokenMs, Date.now())) return 'aplazado';
  ultimoIntentoTokenMs = Date.now();
  if (await precalentar(s)) {
    if (fallosTokenSeguidos > 0) log(`  [token] recuperado tras ${fallosTokenSeguidos} fallos.`);
    fallosTokenSeguidos = 0;
    return 'ok';
  }
  fallosTokenSeguidos += 1;
  return 'fallo';
}

/** Devuelve una sesion con token utilizable. Re-login si la sesion es vieja o el token murio. */
async function sesionLista(row: FilaBot): Promise<Sesion> {
  if (sesion && Date.now() - sesion.creadaMs > SESION_MAX_MS) {
    log('  [sesion] pasa de 44 min. Re-login preventivo.');
    sesion = null;
  }
  if (!sesion) sesion = await abrirSesion(row);

  const v = veredictoToken(sesion.token, sesion.id, Date.now(), POLITICA_TOKEN);
  if (v === 'refrescar') {
    log(`  [token] paso la cadencia de ${POLITICA_TOKEN.cadenciaMs / 60_000} min. Refresco por rutina.`);
    await intentarToken(sesion);
  } else if (v === 'vencido') {
    const r = await intentarToken(sesion);
    if (r === 'fallo') {
      // El refresco fallo. Antes de gastar un login, se pregunta QUE murio.
      if (await cookieSigueViva(sesion)) {
        log(`  [token] sin token, pero /groups responde. Es la ruta del schedule, no la sesion. NO se hace login. Proximo intento en ${minutosEntreDisparos(fallosTokenSeguidos)} min.`);
      } else {
        log('  [token] sin token y /groups tampoco responde. Re-login completo.');
        sesion = await abrirSesion(row);
      }
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
  olvidarFila();   // el contador cambio: la copia en memoria ya no sirve
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
  olvidarFila();
  log(`  [cupo] devuelto (${motivo})`);
}

interface Resultado { agendado: boolean; fatal?: string }

/** Momento de emision del token ANTES de `sesionLista`. Sirve para saber si hubo refresco. */
function s0Token(): number | null {
  return sesion?.token?.emitidoMs ?? null;
}

// ── Ensayo del camino critico ────────────────────────────────────────────────

/**
 * Cadencia del ensayo. A 2 vueltas por minuto el sniper hace 120 `days.json` por
 * hora; el ensayo agrega 12 peticiones, o sea 10% mas. Es el precio de saber si las
 * mejoras del 2026-08-30 son reales en produccion y no solo en los tests.
 */
const ENSAYO_MS = 10 * 60_000;
let ultimoEnsayoMs = 0;
let ensayoEnVuelo = false;
/**
 * Cursor de rotacion de fechas del ensayo.
 *
 * Antes el ensayo preguntaba SIEMPRE por la fecha mas temprana. Esa fecha se queda
 * quieta dias enteros, entonces 55 muestras dieron solo 4 fechas distintas, y de esas
 * 33 salieron de mirar 2028-01-10 una tarde entera. Con tan pocas fechas no se puede
 * elegir una hora especulativa: por primera hora vista, las 4 fechas dieron 4 horas
 * distintas y ninguna se repitio. Ver [[horas-especulativas-contaminadas]].
 *
 * Rotando entre los dias que `days.json` ya ofrece, el mismo numero de peticiones
 * cubre 12 fechas en vez de 1. No agrega ni una peticion: el ensayo ya corria.
 */
let cursorEnsayo = 0;

/**
 * Corre el MISMO par de peticiones del camino critico contra una fecha que el portal
 * ya ofrece, y mide. Nunca postea: no llama a `verificarDisparo`, no llama a
 * `reclamarCupo` y no llama a `reschedule`. Es un cronometro, no un disparo.
 *
 * Existe porque las detecciones reales son rarisimas: el bot 299 tuvo 2 en toda su
 * vida. Sin ensayo no habria con que comprobar que el camino critico mejoro.
 *
 * Las fechas que elige estan lejisimos de la meta (hoy el portal ofrece enero de 2028).
 * Aunque el codigo se rompiera, ninguna pasa V2 ni V3, entonces el ensayo no puede
 * disparar por accidente.
 */
function quizasEnsayo(s: Sesion, dias: Array<{ date: string }>, row: FilaBot, msDias: number): void {
  if (ensayoEnVuelo || Date.now() - ultimoEnsayoMs < ENSAYO_MS) return;
  // Rota entre TODAS las fechas ofrecidas, no siempre la primera. El orden queda fijo
  // para que el cursor avance parejo aunque el portal reordene la respuesta.
  const fechas = dias.map((d) => d.date).filter(Boolean).sort();
  if (fechas.length === 0) return;
  const fecha = fechas[cursorEnsayo % fechas.length]!;
  cursorEnsayo = (cursorEnsayo + 1) % fechas.length;
  if (!fecha) return;
  ensayoEnVuelo = true;
  ultimoEnsayoMs = Date.now();

  void (async () => {
    const tVisto = Date.now();
    try {
      const tCarrera = Date.now();
      const msDiasAHoras = tCarrera - tVisto;
      let msTimes = 0;
      let msApt = 0;
      let fallo: string | null = null;
      // Cada lado atrapa lo suyo: un fallo de una peticion no borra la medicion de
      // la otra, y el motivo queda escrito. Sin esto, un solo abort dejaba la fila
      // sin escribir y el verificador se quedaba sin muestra.
      const [horas, apt] = await Promise.all([
        (async () => {
          const t = Date.now();
          try { return await s.client.getConsularTimes(fecha); }
          catch (e) { fallo = `times: ${(e as Error).message}`; return null; }
          finally { msTimes = Date.now() - t; }
        })(),
        (async () => {
          const t = Date.now();
          try { return await s.client.getCurrentAppointment(); }
          catch (e) { fallo = `${fallo ? fallo + ' · ' : ''}cita: ${(e as Error).message}`; return null; }
          finally { msApt = Date.now() - t; }
        })(),
      ]);
      const msCarrera = Date.now() - tCarrera;
      const edadTokenS = s.token ? Math.round((Date.now() - s.token.emitidoMs) / 1000) : null;
      log(`  [ensayo] ${fecha} · carrera ${msCarrera} ms (times ${msTimes}, cita ${msApt}) · horas ${(horas?.available_times ?? []).length} · cita ${apt?.consularDate ?? '?'}${fallo ? ` · FALLO ${fallo}` : ''}`);
      await registrarEscaneo({
        masTemprana: fecha, dias: dias.length, msDias, fase: 'ensayo',
        ventanaFin: row.targetDateBefore ?? null, edadTokenS, siempre: true,
        metricas: {
          msDiasAHoras, msCarrera, msTimes, msApt, falloEnsayo: fallo,
          horasEncontradas: horas ? (horas.available_times ?? []).filter(Boolean).length : null,
          horas: horas ? ((horas.available_times ?? []).filter(Boolean) as string[]) : null,
          horasNegocio: horas ? ((horas.business_times ?? []).filter(Boolean) as string[]) : null,
          fechaEnsayo: fecha,
          diasHastaFecha: Math.round((Date.parse(`${fecha}T00:00:00Z`) - Date.now()) / 86_400_000),
        },
      });
    } catch (e) {
      log(`  [ensayo] fallo: ${(e as Error).message}`);
    } finally {
      ensayoEnVuelo = false;
    }
  })();
}

/**
 * Verificacion PROGRESIVA de la cita despues del POST.
 *
 * El POST miente: puede decir que salio bien y la cita no haberse movido. La unica
 * verdad es leer `/groups`. Lo que cambia aqui es COMO se espera.
 *
 * Antes: `await sleep(2500)` fijo y una sola lectura. Se pagaban los 2,5 s completos
 * siempre, incluso cuando el portal ya habia guardado el cambio.
 *
 * Ahora: se pregunta a los 400 ms y se corta apenas la cita aparece con la fecha
 * nueva. Si no aparece, se vuelve a los 800 y a los 1.300 ms. El techo de espera sigue
 * siendo 2.500 ms, entonces el peor caso no empeora, y el caso bueno pasa de ~3.200 ms
 * a ~1.100 ms.
 *
 * Devuelve la ultima lectura que se consiguio, o `null` si ninguna respondio.
 */
async function verificarCita(
  s: Sesion,
  fecha: string,
  esperas: readonly number[] = [400, 800, 1300],
): Promise<Awaited<ReturnType<VisaClient['getCurrentAppointment']>>> {
  let ultima: Awaited<ReturnType<VisaClient['getCurrentAppointment']>> = null;
  for (const espera of esperas) {
    await sleep(espera);
    try {
      const leida = await s.client.getCurrentAppointment();
      if (leida) ultima = leida;
      if (leida?.consularDate === fecha) return leida;   // ya quedo, no se espera mas
    } catch (e) {
      log(`  verificacion: lectura fallo (${(e as Error).message})`);
    }
  }
  return ultima;
}

/** Una vuelta completa: pedir dias, verificar, y disparar si todo cierra. */
async function vuelta(): Promise<Resultado> {
  const tVuelta = Date.now();
  const tLeer = Date.now();
  const row = await leerBot();
  const msLeerBot = Date.now() - tLeer;

  if (row.status !== 'active') { log(`  bot ${BOT_ID} en estado ${row.status}. No se dispara.`); return { agendado: false }; }

  const cupoDb = cupoEfectivo(configDe(row, row.currentConsularDate));
  if (cupoDb.quedan <= 0) {
    // La fila viene de memoria y puede tener hasta 60 s. Otra cadena puede haber
    // tomado el cupo y devuelto un instante despues. Matar el proceso con un dato
    // viejo lo deja muerto para siempre (`Restart=on-failure` no revive un exit 0).
    // Se confirma EN VIVO antes de rendirse.
    olvidarFila();
    const vivo = await leerBot();
    const cupoVivo = cupoEfectivo(configDe(vivo, vivo.currentConsularDate));
    if (cupoVivo.quedan > 0) {
      log(`  cupo en memoria decia 0 y en vivo quedan ${cupoVivo.quedan}. Se sigue.`);
    } else {
      return { agendado: false, fatal: `sin cupo (tope ${cupoVivo.topeDe})` };
    }
  }

  const tokenAntes = s0Token();
  const s = await sesionLista(row);
  const tokenPrecalentado = tokenAntes === s.token?.emitidoMs;

  // 1 · dias. Es la unica peticion en la vuelta normal.
  const t0 = Date.now();
  const segundoTick = Math.floor((t0 % 60_000) / 1000);
  const dias = await s.client.getConsularDays();
  const msDias = Date.now() - t0;
  // Momento exacto en que el cupo se hace VISIBLE para nosotros. Desde aqui corre el
  // reloj que perdimos las dos veces que el bot 299 vio algo util.
  const tVisto = Date.now();

  const cfgPrevia = configDe(row, row.currentConsularDate);
  const fecha = elegirFecha(dias as Array<{ date: string }>, cfgPrevia, hoyUtc());
  const quemadaHasta = fecha ? quemadas.get(fecha) ?? 0 : 0;

  if (!fecha) {
    // Se muestra la mas temprana que el portal ofrece. Sirve para ver de lejos si
    // el portal se acerca a la meta, y para notar un filtro que descarta de mas.
    const masTemprana = (dias as Array<{ date: string }>).map((d) => d.date).sort()[0] ?? '(ninguna)';
    log(`  dias ${dias.length} · ${msDias} ms · nada util · mas temprana ${masTemprana} (cita ${row.currentConsularDate}, meta < ${row.targetDateBefore})`);
    registrarEscaneoSinEsperar({
      masTemprana, dias: dias.length, msDias, fase: 'buscando',
      ventanaFin: row.targetDateBefore ?? null,
      edadTokenS: s.token ? Math.round((Date.now() - s.token.emitidoMs) / 1000) : null,
      metricas: { msLeerBot, segundoTick, tokenPrecalentado, msVuelta: Date.now() - tVuelta },
    });
    // El ensayo mide el camino critico de verdad, con la cadencia de ENSAYO_MS.
    // Sale sin esperar y nunca puede postear.
    quizasEnsayo(s, dias as Array<{ date: string }>, row, msDias);
    return { agendado: false };
  }
  if (Date.now() < quemadaHasta) {
    log(`  ${fecha} quemada hasta ${new Date(quemadaHasta).toISOString().slice(11, 19)}Z. Se salta.`);
    return { agendado: false };
  }

  log(`  DETECCION ${fecha} · dias ${dias.length} · ${msDias} ms · ventana ${enVentana(Date.now()) ? 'SI' : 'NO'}`);
  ultimoEscaneo = null;   // una deteccion siempre se escribe
  registrarEscaneoSinEsperar({
    masTemprana: fecha, dias: dias.length, msDias, fase: 'deteccion',
    ventanaFin: row.targetDateBefore ?? null,
    edadTokenS: s.token ? Math.round((Date.now() - s.token.emitidoMs) / 1000) : null,
    metricas: { msLeerBot, segundoTick, tokenPrecalentado },
  });

  // 2 y 3 · horas Y cita actual, EN PARALELO.
  //
  // Las dos son peticiones al portal y ninguna depende de la otra. En serie
  // sumaban; ahora se cobra el maximo. `times.json` es la carrera: el cupo del
  // 2026-10-26 vivio 15 segundos y el bot llego a los 16,6 (medido 2026-08-27).
  //
  // La cita actual sale del PORTAL, nunca de la base de datos: la regla critica se
  // verifica contra lo que el portal dice hoy. Si esa lectura falla queda en null, y
  // V2 de `verificarDisparo` cancela el disparo. No se cachea: en Peru el bloqueo es
  // irreversible y un dato viejo podria autorizar un movimiento hacia adelante.
  const tCarrera = Date.now();
  // Tiempo REGALADO: de ver el cupo a pedir las horas. Era 4.408 ms y 13.832 ms en
  // las dos detecciones del 2026-08-27. Con el escaneo sin esperar y el token
  // precalentado tiene que quedar en pocos milisegundos.
  const msDiasAHoras = tCarrera - tVisto;
  let msTimes = 0;
  let msApt = 0;
  const [resHoras, apt] = await Promise.all([
    (async () => { const t = Date.now(); try { return await s.client.getConsularTimes(fecha); } finally { msTimes = Date.now() - t; } })(),
    (async () => {
      const t = Date.now();
      try { return await s.client.getCurrentAppointment(); }
      catch (e) { log(`  [cita] no se pudo leer del portal: ${(e as Error).message}`); return null; }
      finally { msApt = Date.now() - t; }
    })(),
  ]);
  const msCarrera = Date.now() - tCarrera;
  const cfg = configDe(row, apt?.consularDate ?? null);
  log(`  regalado ${msDiasAHoras} ms · carrera ${msCarrera} ms (times ${msTimes}, cita ${msApt}) · portal dice cita ${apt?.consularDate ?? '(no leida)'} ${apt?.consularTime ?? ''}`);
  // Se escribe la medicion de la deteccion real, sin esperar.
  registrarEscaneoSinEsperar({
    masTemprana: fecha, dias: dias.length, msDias, fase: 'deteccion_medida',
    ventanaFin: row.targetDateBefore ?? null,
    edadTokenS: s.token ? Math.round((Date.now() - s.token.emitidoMs) / 1000) : null,
    siempre: true,
    metricas: { msLeerBot, segundoTick, tokenPrecalentado, msDiasAHoras, msCarrera, msTimes, msApt },
  });

  const horas = (resHoras.available_times ?? []).filter(Boolean) as string[];
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
  if (veredictoToken(s.token, s.id, Date.now(), POLITICA_TOKEN) === 'vencido') {
    log('  ABORTA: el token vencio justo antes del POST. Se refresca para la proxima.');
    await intentarToken(s);
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
    // NO es fatal. `poll-visa` corre sobre el mismo bot y puede reclamar y devolver el
    // cupo en la misma vuelta. Antes esto mataba el sniper para siempre por una
    // carrera de segundos. Se salta el tick y la vuelta siguiente lee en vivo.
    log('  Se salta: otra cadena tiene el cupo ahora (UPDATE atomico sin filas).');
    olvidarFila();
    return { agendado: false };
  }

  // 7 · UN solo POST por deteccion. Sin reintento a ciegas.
  const tPost = Date.now();
  let dijoOk = false;
  let errPost: string | null = null;
  try { dijoOk = await s.client.reschedule(fecha, hora); }
  catch (e) { errPost = (e as Error).message; }
  log(`  POST → ${dijoOk ? 'dice OK' : `dice NO (${errPost ?? 'sin excepcion'})`} · ${Date.now() - tPost} ms`);

  // 8 · verificacion contra el portal. El POST miente: ver `followRedirectChain`.
  const tVerif = Date.now();
  const real = await verificarCita(s, fecha);
  const quedo = real?.consularDate === fecha;
  log(`  portal ahora: ${real?.consularDate ?? '?'} ${real?.consularTime ?? ''} → ${quedo ? 'QUEDO' : 'NO QUEDO'} · ${Date.now() - tVerif} ms`);

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
    olvidarFila();
    log(`  *** AGENDADO ${real.consularDate} ${real.consularTime} ***`);
    ultimoEscaneo = null;
    await registrarEscaneo({
      masTemprana: real.consularDate, dias: dias.length, msDias, fase: 'agendado',
      ventanaFin: row.targetDateBefore ?? null, edadTokenS,
    });
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
  log(`  fase: ${SEGUNDOS_TICK.length} peticiones por minuto, segundos ${SEGUNDOS_TICK.join(' y ')} UTC · ventana s${VENTANA_PE.inicioSeg}-${VENTANA_PE.finSeg - 1}`);
  log(`  token: refresco cada ${POLITICA_TOKEN.cadenciaMs / 60000} min, techo ${POLITICA_TOKEN.techoMs / 60000} min`);

  // La sesion se abre ANTES del bucle. El login tarda ~17 s y desalinearia la
  // primera vuelta: la peticion caeria en el segundo 25, fuera de la ventana.
  try { await sesionLista(row); } catch (e) { log(`  [sesion] arranque fallo: ${(e as Error).message}`); }

  let errores = 0;
  let ultimoDisparoMs = 0;
  let saltadosSeguidos = 0;
  for (;;) {
    await sleep(msHastaProximoTick(Date.now(), SEGUNDOS_TICK));

    // Cadencia degradada. NO es una pausa: el proceso sigue despertando en los segundos
    // 14 y 18, conserva su fase contra la ventana de liberacion, y solo saltea disparos
    // mientras la racha de errores dure. Al primer poll sano vuelve a la cadencia plena.
    if (!tocaDisparar(errores, ultimoDisparoMs, Date.now())) {
      saltadosSeguidos += 1;
      if (saltadosSeguidos === 1) {
        log(`  cadencia reducida a 1 cada ${minutosEntreDisparos(errores)} min por ${errores} errores seguidos. Sigue vivo.`);
      }
      continue;
    }
    saltadosSeguidos = 0;
    ultimoDisparoMs = Date.now();

    try {
      const r = await vuelta();
      if (errores > 0) log(`  recuperado tras ${errores} errores. Cadencia plena otra vez.`);
      errores = 0;
      if (r.agendado) { log('  objetivo cumplido. Fin.'); break; }
      if (r.fatal) { log(`  ALTO: ${r.fatal}. Fin.`); break; }
    } catch (e) {
      errores += 1;
      // SIN PAUSA. Una pausa de 15 min se come 30 ventanas de liberacion seguidas, y
      // el cupo de Peru aparece justo ahi. Se sigue disparando y se avisa en el log.
      //
      // La sesion se suelta SOLO si la cookie de verdad murio. Un fallo de `days.json`
      // no prueba nada sobre la cookie: el 2026-08-31 la ruta del schedule estaba
      // cerrada y `/groups` respondia 200. Tirar la sesion ahi costaba un login por
      // error, contra el endpoint mas vigilado del portal. Ver `cookieSigueViva`.
      if (sesion && !(await cookieSigueViva(sesion))) {
        log('  [sesion] la cookie murio. Se suelta y la vuelta siguiente entra de nuevo.');
        sesion = null;
      }
      log(`  ERROR (${errores} seguidos): ${(e as Error).message}`);
      if (errores % 10 === 0) log(`  ATENCION: ${errores} errores seguidos y sigue intentando.`);
    }
    if (UNA_VUELTA) break;
  }
  process.exit(0);
}

main().catch((e) => { log('FATAL:', (e as Error).stack ?? (e as Error).message); process.exit(1); });

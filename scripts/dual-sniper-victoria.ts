/**
 * DUAL SNIPER · familia Alvarez / Perez · cuenta victorian0122@hotmail.com (userId 45936434)
 *
 * OBJETIVO
 *   Dejar las 2 citas CONSULARES el MISMO dia, dentro de [WINDOW_START, WINDOW_END],
 *   con los PADRES antes que los NINOS, y el gap de horas lo mas pequeno posible.
 *   La CAS es prioridad 2: debe existir, se prefiere dentro de la ventana.
 *
 * POR QUE UN SCRIPT Y NO sniperMode
 *   `sniperMode` de la app trabaja UN bot a la vez. No conoce la hora del otro grupo,
 *   entonces no puede exigir "mismo dia", ni "padres antes que ninos", ni un gap de minutos.
 *
 * SEGURIDAD
 *   - Dry-run por defecto. Sin `--commit` no hace ningun POST.
 *   - Verificadores V1 a V9 en `src/services/dual-sniper-core.ts`, con 35 tests.
 *   - Re-lectura de cupos en vivo justo antes del POST.
 *   - Verificacion REAL despues de cada POST leyendo /groups. `reschedule()` tiene
 *     falsos positivos documentados; aqui no se le cree.
 *   - Si el POST de los ninos falla despues de mover a los padres, el script NO revierte.
 *     Pasa a modo CHILD_ONLY anclado al dia de los padres y sigue cazando.
 *
 * TELEMETRIA
 *   Cada poll interesante escribe una fila en `sniper_scans`. La pagina
 *   /dashboard/sniper la lee. Observa septiembre a diciembre para ver patrones,
 *   no solo la ventana.
 *
 * USO
 *   npx tsx --env-file=.env scripts/dual-sniper-victoria.ts            # dry-run, 1 ciclo
 *   npx tsx --env-file=.env scripts/dual-sniper-victoria.ts --loop     # dry-run continuo
 *   npx tsx --env-file=.env scripts/dual-sniper-victoria.ts --loop --commit   # REAL
 */

import { and, eq, lt, desc } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { bots, rescheduleLogs, sniperScans } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { loginWithFallback } from '../src/services/login.js';
import { VisaClient, SessionExpiredError, type DaySlot } from '../src/services/visa-client.js';
import { notifyUser } from '../src/services/notifications.js';
import { recordFailure, isBlocked, clearOnCasAvailable, type FailureTuning } from '../src/services/date-failure-tracker.js';
import type { DateFailureEntry, CasCacheData } from '../src/db/schema.js';
import {
  toMin, inWindow, buildPairs, rankCandidates, computePhase, movingRoles,
  verifyCandidate, rankCasDates, effectiveConfig, currentGapMin, inPreferred,
  type SniperConfig, type GroupState, type Candidate, type CasPick, type Phase,
} from '../src/services/dual-sniper-core.js';

// ─────────────────────────── Configuracion ───────────────────────────

const CFG: SniperConfig = {
  windowStart: '2026-09-14',      // aceptacion, inclusive
  windowEnd: '2026-09-30',        // aceptacion, inclusive
  preferStart: '2026-09-14',      // prioridad: un par aqui gana sobre el resto
  preferEnd: '2026-09-25',
  gapMaxMin: 60,                  // techo cuando se mueven LOS DOS grupos
  rescueGapMaxMin: 480,           // techo en rescate: lo que importa es el MISMO dia
  gapIdealMin: 15,                // meta blanda
  casInWindowRequired: false,     // el consular es prioridad 1; la CAS solo debe existir
};

/** Rango que se OBSERVA para ver patrones. Mas ancho que la ventana donde se actua. */
const OBSERVE_START = '2026-09-01';
const OBSERVE_END = '2026-12-31';
/** Dias fuera de la ventana a los que se les piden horas por ciclo (rotativo). */
const SAMPLE_PER_CYCLE = 2;

const SCAN_KEY = 'victoria-alvarez';
const SCAN_RETENTION_DAYS = 21;
const SCAN_HEARTBEAT_MS = 10 * 60 * 1000;   // fila minima cada 10 min aunque nada cambie

const DEADLINE = '2026-09-29';              // el script para solo despues de esta fecha
/**
 * Ritmo del ciclo.
 *
 * Bajado de 30s a 5min el 2026-08-25. A 30s, tras 18 horas de polling sostenido en `es-co`,
 * la embajada bloqueo la cuenta: el pool de webshare se agotaba en cada ciclo
 * (`[embassy_block] All webshare IPs exhausted`) y la IP directa quedo sin conexion TCP.
 * Resultado: 10 ciclos utiles en 65 minutos contra 107 normales, y una hora entera con 0
 * escaneos. Esta documentado en CLAUDE.md: webshare sostenido en es-co bloquea la cuenta.
 *
 * Con la familia ya partida solo hay UN dia que vigilar (`2026-09-16`), entonces 30s no
 * aporta nada y si sostiene el bloqueo.
 */
const POLL_INTERVAL_MS = 5 * 60_000;
const SESSION_MAX_AGE_MS = 40 * 60 * 1000;  // TTL duro del portal ~1h28m; re-login a 40m
const COOLDOWN_ERRORS = 5;
const COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Cooldown por fecha cuando el portal no ofrece CAS. Reusa
 * `src/services/date-failure-tracker.ts`, el mismo tracker de la flota, y se guarda en
 * `bots.casCacheJson.dateFailureTracking`. Sale en el tab TRACKER de /dashboard/{botId}.
 *
 * La escala de la flota (5 fallos en 3h → bloqueo 6h) esta pensada para el poll de 2 min.
 * Un sniper de 30s con ese bloqueo perderia justo la liberacion de CAS que espera.
 * Aqui: 3 fallos en 30 min → deja de probar esa fecha 5 min, luego reintenta.
 */
const CAS_TUNING: FailureTuning = { threshold: 3, blockMs: 5 * 60_000, windowMs: 30 * 60_000 };

const PARENTS_BOT_ID = 141;   // Estephany Cecilia Alvarez Merchan, Nestor Andres Perez Osorio
const CHILDREN_BOT_ID = 140;  // Victoria Perez Alvarez, Emanuel Perez Alvarez, Santiago Alberto Alvarez Calvo

const COMMIT = process.argv.includes('--commit');
const LOOP = process.argv.includes('--loop');

/**
 * Orden de los POST. Por defecto se mueve PRIMERO el grupo de 3 (ninos).
 *
 * Motivo: tomar un cupo lo BORRA del portal. Si el segundo POST falla, el primero ya
 * quedo movido y hay que rescatarlo. Asegurar primero el cupo escaso (3 asientos) deja
 * el rescate FACIL: buscar despues 2 asientos mas temprano ese mismo dia. Al reves el
 * rescate seria el dificil: buscar 3 asientos en un dia concreto.
 *
 * El orden de los POST no tiene nada que ver con el orden de las HORAS: los padres
 * siguen quedando siempre antes que los ninos en el dia.
 */
const PARENTS_FIRST = process.argv.includes('--parents-first');

/**
 * Guardia contra partir a la familia.
 *
 * Un par de gap 0 manda a los 2 grupos a la MISMA hora. Cada grupo ve ese horario porque
 * hay asientos para el suyo, y no hay forma de saber si hay para los dos. Si el dia ofrece
 * un solo horario y el 2do POST no cuaja, el rescate no tiene alternativa: un grupo queda
 * en septiembre y el otro en 2027.
 *
 * Con este guardia, un par de gap 0 solo se ejecuta si ese dia ofrece al menos otro horario
 * valido de respaldo para el 2do grupo. Los pares con gap > 0 no lo necesitan: ya van a
 * horarios distintos.
 *
 * Poner en false para aceptar el riesgo y disparar igual.
 */
const REQUIRE_BACKUP_TIME_ON_GAP0 = !process.argv.includes('--no-backup-guard');
/** Intentos inmediatos con otra hora del mismo dia si el cupo del 2do grupo desaparecio. */
const SECOND_MOVE_RETRIES = 3;

// ─────────────────────────── Utilidades ───────────────────────────

function log(...parts: unknown[]): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}Z]`, ...parts);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────── Grupo ───────────────────────────

interface Group extends GroupState {
  botId: number;
  scheduleId: string;
  applicantIds: string[];
  consularFacilityId: string;
  ascFacilityId: string;
  locale: string;
  email: string;
  password: string;
  userId: string;
  proxyProvider: 'direct' | 'webshare' | 'brightdata' | 'firecrawl';
  proxyUrls: string[] | null;
  casDate: string | null;
  casTime: string | null;
  client: VisaClient | null;
  sessionAt: number;
  /** Espejo de bots.casCacheJson.dateFailureTracking para este bot. */
  dateFailures: Record<string, DateFailureEntry>;
  casCache: CasCacheData | null;
}

async function loadGroup(botId: number, role: 'PARENTS' | 'CHILDREN'): Promise<Group> {
  const [row] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!row) throw new Error(`bot ${botId} no existe`);
  const g: Group = {
    role,
    botId,
    scheduleId: String(row.scheduleId),
    applicantIds: (row.applicantIds ?? []) as string[],
    consularFacilityId: String(row.consularFacilityId ?? '25'),
    ascFacilityId: String(row.ascFacilityId ?? '26'),
    locale: row.locale ?? 'es-co',
    email: decrypt(row.visaEmail as string),
    password: decrypt(row.visaPassword as string),
    userId: String(row.userId ?? ''),
    // Los GET JSON salen por el proveedor del bot (webshare). El POST de reschedule
    // siempre sale directo: `doDirectFetch` en visa-client.ts lo fuerza, y Bright Data
    // devuelve 402 en POST. Si la IP directa esta bloqueada, el POST falla y el
    // verificador post-POST lo detecta; el loop reintenta.
    proxyProvider: (row.proxyProvider ?? 'direct') as Group['proxyProvider'],
    proxyUrls: (row.proxyUrls ?? null) as string[] | null,
    maxReschedules: row.maxReschedules ?? null,
    rescheduleCount: row.rescheduleCount ?? 0,
    consularDate: null,
    consularTime: null,
    casDate: null,
    casTime: null,
    client: null,
    sessionAt: 0,
    casCache: (row.casCacheJson ?? null) as CasCacheData | null,
    dateFailures: ((row.casCacheJson as CasCacheData | null)?.dateFailureTracking ?? {}) as Record<string, DateFailureEntry>,
  };
  if (g.applicantIds.length === 0) throw new Error(`bot ${botId} sin applicantIds`);
  if (!g.userId) throw new Error(`bot ${botId} sin userId`);
  return g;
}

async function ensureSession(g: Group): Promise<VisaClient> {
  if (g.client && Date.now() - g.sessionAt < SESSION_MAX_AGE_MS) return g.client;

  // loginWithFallback = webshare primero, directo despues (ver login.ts:loginRouted).
  // Sirve cuando la IP residencial del RPi esta TCP-bloqueada por el portal.
  const { result: login, via } = await loginWithFallback({
    email: g.email, password: g.password, scheduleId: g.scheduleId,
    applicantIds: g.applicantIds, locale: g.locale,
  });
  g.client = new VisaClient(
    { cookie: login.cookie, csrfToken: login.csrfToken ?? '', authenticityToken: login.authenticityToken ?? '' },
    {
      scheduleId: g.scheduleId,
      applicantIds: g.applicantIds,
      consularFacilityId: g.consularFacilityId,
      ascFacilityId: g.ascFacilityId,
      proxyProvider: g.proxyProvider,
      // El POST y `refreshTokens()` salen por el MISMO proveedor que los GET.
      // La IP directa del RPi queda TCP-bloqueada por rachas. El 2026-08-25 03:31 el
      // sniper paso todos los verificadores, mando el correo `sniper_ready`, y murio en
      // `primeTokens` con `fetch failed`, porque ese paso salia directo.
      postProvider: g.proxyProvider === 'brightdata' ? 'direct' : g.proxyProvider,
      proxyUrls: g.proxyUrls,
      locale: g.locale,
      userId: g.userId,
    },
  );
  g.sessionAt = Date.now();
  log(`  [${g.role}] sesion nueva (schedule ${g.scheduleId}, login via ${via}, polls via ${g.proxyProvider})`);
  return g.client;
}

/** Lee la cita REAL del portal. Nunca confia en la base. */
async function syncCurrentAppointment(g: Group): Promise<void> {
  const client = await ensureSession(g);
  const appt = await client.getCurrentAppointment();
  if (!appt) throw new Error(`[${g.role}] /groups no devolvio cita para schedule ${g.scheduleId}`);
  const changed = g.consularDate !== appt.consularDate || g.consularTime !== appt.consularTime
    || g.casDate !== appt.casDate || g.casTime !== appt.casTime;
  g.consularDate = appt.consularDate;
  g.consularTime = appt.consularTime;
  g.casDate = appt.casDate;
  g.casTime = appt.casTime;

  // La fila de `bots` se queda vieja cuando el dueno reagenda a mano. El sniper ya leyo
  // el portal, entonces sincronizarla es gratis y deja el dashboard de la flota honesto.
  if (changed) {
    try {
      await db.update(bots).set({
        currentConsularDate: appt.consularDate,
        currentConsularTime: appt.consularTime,
        currentCasDate: appt.casDate,
        currentCasTime: appt.casTime,
      }).where(eq(bots.id, g.botId));
    } catch (err) {
      log(`  [${g.role}] no se pudo sincronizar bots: ${(err as Error).message}`);
    }
  }
}

// ─────────────────────────── CAS ───────────────────────────

/** Guarda el tracker de fechas en bots.casCacheJson.dateFailureTracking del propio bot. */
async function persistFailures(g: Group): Promise<void> {
  try {
    const next: CasCacheData = { ...(g.casCache ?? {} as CasCacheData), dateFailureTracking: g.dateFailures };
    g.casCache = next;
    await db.update(bots).set({ casCacheJson: next }).where(eq(bots.id, g.botId));
  } catch (err) {
    log(`  [${g.role}] no se pudo guardar el tracker: ${(err as Error).message}`);
  }
}

interface CasProbe {
  role: 'PARENTS' | 'CHILDREN';
  consularDate: string;
  consularTime: string;
  casDaysOffered: number;      // 0 = muro CAS
  picked: CasPick | null;
}

async function pickCas(
  g: Group,
  consularDate: string,
  consularTime: string,
  preferDate: string | null,
  preferTime: string | null,
  probes: CasProbe[],
): Promise<CasPick | null> {
  const probe: CasProbe = { role: g.role, consularDate, consularTime, casDaysOffered: 0, picked: null };
  probes.push(probe);
  const client = await ensureSession(g);
  let days: DaySlot[];
  try {
    days = await client.getCasDays(consularDate, consularTime);
  } catch (err) {
    log(`  [${g.role}] getCasDays fallo: ${(err as Error).message}`);
    return null;
  }
  probe.casDaysOffered = days.length;
  if (days.length === 0) {
    // Muro CAS. Cuenta el fallo de esta fecha; a los 3 en 30 min deja de probarla 5 min.
    //
    // El modulo compartido fija `blockedUntil` UNA vez y nunca lo extiende (decision
    // cerrada de la flota). Para el sniper eso daria una sola pausa de 5 min por ventana
    // de 30 min. Aqui la pausa debe repetirse, entonces al expirar el bloqueo se arranca
    // una ventana nueva: 3 sondeos, 5 min de pausa, y otra vez.
    const prev = g.dateFailures[consularDate];
    const expired = !!prev?.blockedUntil && new Date(prev.blockedUntil).getTime() <= Date.now();
    g.dateFailures[consularDate] = recordFailure(expired ? undefined : prev, 'casNoDays', Date.now(), CAS_TUNING);
    const e = g.dateFailures[consularDate]!;
    log(`  [${g.role}] muro CAS en ${consularDate} (fallo ${e.totalCount}${e.blockedUntil ? `, en pausa hasta ${e.blockedUntil.slice(11, 16)}Z` : ''})`);
    await persistFailures(g);
    return null;
  }
  // Hay CAS. Es el cuello de botella real, entonces vale un correo.
  await alertOnce(g.botId, 'sniper_cas_found', `${g.role}:${consularDate}`, {
    grupo: g.role === 'PARENTS' ? 'padres (2)' : 'ninos (3)',
    consular: `${consularDate} ${consularTime}`,
    dias_cas_ofrecidos: days.length,
  });
  // Se libera el bloqueo de esa fecha (escape hatch del tracker).
  if (g.dateFailures[consularDate]) {
    g.dateFailures = clearOnCasAvailable(g.dateFailures, consularDate);
    log(`  [${g.role}] CAS reaparecio en ${consularDate}: bloqueo liberado`);
    await persistFailures(g);
  }

  const ranked = rankCasDates(days.map((d) => d.date), CFG, preferDate);
  for (const date of ranked.slice(0, 3)) {
    if (date > consularDate) continue;   // la CAS nunca despues del consular
    let times: string[];
    try {
      times = (await client.getCasTimes(date, consularDate, consularTime)).available_times ?? [];
    } catch (err) {
      log(`  [${g.role}] getCasTimes(${date}) fallo: ${(err as Error).message}`);
      continue;
    }
    if (times.length === 0) continue;
    const time = preferTime && times.includes(preferTime) ? preferTime : times[0]!;
    probe.picked = { date, time, inWindow: inWindow(date, CFG) };
    return probe.picked;
  }
  return null;
}

// ─────────────────────────── Escaneo ───────────────────────────

interface DayObservation {
  date: string;
  parentsTimes: string[] | null;   // null = no se consulto en este ciclo
  childrenTimes: string[];
  pairs: Array<{ p: string; c: string; gapMin: number }>;
  source: 'window' | 'sample';
}

interface ScanRecord {
  allDays: string[];               // days.json completo del scout
  observeDays: string[];           // los que caen en [OBSERVE_START, OBSERVE_END]
  windowDays: string[];            // los que caen en la ventana de accion
  observations: DayObservation[];
  /** Todos los pares validos, del mejor al peor. */
  ranked: Candidate[];
  best: Candidate | null;
}

let sampleCursor = 0;
/** Ultima composicion de la ventana, para avisar solo cuando cambia. */
let lastWindowKey: string | null = null;

/** Re-lee los cupos en vivo justo antes del POST. Ultimo filtro contra cupos ya tomados. */
async function reverifyLive(c: Candidate, parents: Group, children: Group, phase: Phase): Promise<string[]> {
  const fails: string[] = [];
  for (const role of movingRoles(phase)) {
    const g = role === 'PARENTS' ? parents : children;
    const want = role === 'PARENTS' ? c.parentsTime : c.childrenTime;
    const t = (await (await ensureSession(g)).getConsularTimes(c.date)).available_times ?? [];
    if (!t.includes(want)) fails.push(`LIVE [${role}] ${c.date} ${want} ya no existe (quedan: ${t.join(',') || 'ninguna'})`);
  }
  return fails;
}

async function scan(parents: Group, children: Group, phase: Phase): Promise<ScanRecord> {
  // Scout = grupo de 3 (ninos). Si hay cupo para 3, casi siempre lo hay para 2.
  const scout = children;
  const days = await (await ensureSession(scout)).getConsularDays();
  const allDays = days.map((d) => d.date).sort();
  const observeDays = allDays.filter((d) => d >= OBSERVE_START && d <= OBSERVE_END);
  const windowDays = allDays.filter((d) => inWindow(d, CFG));
  const observations: DayObservation[] = [];
  const out: ScanRecord = { allDays, observeDays, windowDays, observations, ranked: [], best: null };

  log(`  scout(${scout.applicantIds.length} personas): ${allDays.length} dias totales | ${observeDays.length} en ${OBSERVE_START}..${OBSERVE_END} | ${windowDays.length} en ventana → ${windowDays.join(', ') || '(ninguno)'}`);

  // Cambio de composicion de la ventana: se registra en el log y en `sniper_scans`, y NO
  // manda correo. Medido el 2026-08-24: los dias del tramo 21-30 aparecen y desaparecen en
  // menos de 1 minuto. Un aviso asi no da tiempo de hacer nada, entonces solo es ruido.
  const winKey = windowDays.join(',');
  if (winKey !== lastWindowKey) {
    const before = lastWindowKey === null ? [] : lastWindowKey.split(',').filter(Boolean);
    const ganados = windowDays.filter((d) => !before.includes(d));
    const perdidos = before.filter((d) => !windowDays.includes(d));
    if (lastWindowKey !== null && (ganados.length > 0 || perdidos.length > 0)) {
      log(`  ventana cambio: +[${ganados.join(' ') || '-'}] -[${perdidos.join(' ') || '-'}]`);
    }
    lastWindowKey = winKey;
  }

  // 1) Dias de la ventana: horas de LOS DOS grupos, siempre.
  const anchorDays = phase === 'CHILD_ONLY' && parents.consularDate ? [parents.consularDate]
    : phase === 'PARENT_ONLY' && children.consularDate ? [children.consularDate]
    : windowDays;
  const actDays = [...new Set(anchorDays.filter((d) => inWindow(d, CFG)))].sort();

  const found: Candidate[] = [];
  for (const date of actDays) {
    let childTimes: string[];
    let parentTimes: string[];
    if (phase === 'CHILD_ONLY') {
      parentTimes = parents.consularTime ? [parents.consularTime] : [];
      childTimes = (await (await ensureSession(children)).getConsularTimes(date)).available_times ?? [];
    } else if (phase === 'PARENT_ONLY') {
      childTimes = children.consularTime ? [children.consularTime] : [];
      parentTimes = (await (await ensureSession(parents)).getConsularTimes(date)).available_times ?? [];
    } else {
      childTimes = (await (await ensureSession(children)).getConsularTimes(date)).available_times ?? [];
      parentTimes = childTimes.length === 0
        ? []
        : (await (await ensureSession(parents)).getConsularTimes(date)).available_times ?? [];
    }
    const pairs = buildPairs(date, parentTimes, childTimes, effectiveConfig(CFG, phase));
    observations.push({ date, parentsTimes: parentTimes, childrenTimes: childTimes, pairs, source: 'window' });
    log(`    ${date}: padres [${parentTimes.join(',') || '-'}] ninos [${childTimes.join(',') || '-'}] → ${pairs.length} pares`);
    for (const pr of pairs) {
      found.push({ date, parentsTime: pr.p, childrenTime: pr.c, gapMin: pr.gapMin, parentsCas: null, childrenCas: null });
    }
  }

  // 2) Muestra rotativa fuera de la ventana, solo con el scout. Sirve para ver patrones
  //    de septiembre a diciembre sin disparar el numero de requests.
  const samplePool = observeDays.filter((d) => !inWindow(d, CFG));
  for (let i = 0; i < Math.min(SAMPLE_PER_CYCLE, samplePool.length); i += 1) {
    const date = samplePool[(sampleCursor + i) % samplePool.length]!;
    try {
      const times = (await (await ensureSession(children)).getConsularTimes(date)).available_times ?? [];
      observations.push({ date, parentsTimes: null, childrenTimes: times, pairs: [], source: 'sample' });
      log(`    [muestra] ${date}: ninos [${times.join(',') || '-'}]`);
    } catch (err) {
      log(`    [muestra] ${date} fallo: ${(err as Error).message}`);
    }
  }
  sampleCursor = samplePool.length > 0 ? (sampleCursor + SAMPLE_PER_CYCLE) % samplePool.length : 0;

  if (found.length > 0) {
    const ranked = rankCandidates(found, CFG);
    out.ranked = ranked;
    out.best = ranked[0]!;
    const pref = inPreferred(out.best.date, CFG) ? ' [PREFERIDO]' : '';
    log(`  ${found.length} pares validos. Mejor: ${out.best.date} padres ${out.best.parentsTime} → ninos ${out.best.childrenTime} (gap ${out.best.gapMin}min)${pref}${out.best.gapMin <= CFG.gapIdealMin ? ' [gap ideal]' : ''}`);
  }
  return out;
}

// ─────────────────────────── Persistencia del escaneo ───────────────────────────

/** Ultimo juego de horas visto por cada dia muestreado. La muestra rota cada ciclo,
 *  entonces un dia distinto NO es informacion nueva: solo lo es si sus horas cambiaron. */
const sampleMemory = new Map<string, string>();

/**
 * Huella de lo observado. Si no cambia, el poll no es interesante.
 * Entran: days.json completo, las horas de los dias de la ventana, y solo las
 * muestras cuyo juego de horas difiere de la ultima vez que se vio ese mismo dia.
 */
function fingerprint(s: ScanRecord): string {
  const win = s.observations
    .filter((o) => o.source === 'window')
    .map((o) => `${o.date}|${(o.parentsTimes ?? []).join(',')}|${o.childrenTimes.join(',')}`)
    .sort()
    .join(';');

  const changedSamples: string[] = [];
  for (const o of s.observations) {
    if (o.source !== 'sample') continue;
    const key = o.childrenTimes.join(',');
    if (sampleMemory.get(o.date) !== key) changedSamples.push(`${o.date}|${key}`);
  }
  return `${s.allDays.join(',')}#${win}#${changedSamples.sort().join(';')}`;
}

/** Se llama solo cuando la fila SI se escribio, para no perder un cambio en un ciclo saltado. */
function rememberSamples(s: ScanRecord): void {
  for (const o of s.observations) {
    if (o.source === 'sample') sampleMemory.set(o.date, o.childrenTimes.join(','));
  }
}

let lastFingerprint: string | null = null;
let lastScanWriteAt = 0;

/**
 * Escribe una fila solo cuando el poll es INTERESANTE: cambio lo observado, o pasaron
 * SCAN_HEARTBEAT_MS. Mismo criterio de "change + heartbeat" que `poll-logging.ts`,
 * por el costo de Neon (se paga computo, y a 30s serian ~2.880 filas/dia).
 */
interface CycleOutcome {
  /** null = no hubo par candidato. Si hubo, el mejor. */
  best: { date: string; parentsTime: string; childrenTime: string; gapMin: number } | null;
  /** Verificadores que fallaron. Vacio y `fired=true` = se ejecuto el movimiento. */
  blockers: string[];
  fired: boolean;
  casProbes: CasProbe[];
}

async function saveScan(
  s: ScanRecord, phase: Phase, parents: Group, children: Group, outcome: CycleOutcome,
): Promise<'written' | 'skipped'> {
  const fp = fingerprint(s) + '#' + outcome.blockers.join('|') + (outcome.fired ? '#fired' : '');
  const changed = fp !== lastFingerprint;
  const stale = Date.now() - lastScanWriteAt > SCAN_HEARTBEAT_MS;
  if (!changed && !stale) return 'skipped';

  const byMonth: Record<string, number> = {};
  for (const d of s.allDays) {
    const m = d.slice(0, 7);
    byMonth[m] = (byMonth[m] ?? 0) + 1;
  }

  try {
    await db.insert(sniperScans).values({
      scanKey: SCAN_KEY,
      windowStart: CFG.windowStart,
      windowEnd: CFG.windowEnd,
      phase,
      payload: {
        reason: changed ? 'change' : 'heartbeat',
        totalDays: s.allDays.length,
        allDays: s.allDays,
        byMonth,
        observeStart: OBSERVE_START,
        observeEnd: OBSERVE_END,
        observeDays: s.observeDays,
        windowDays: s.windowDays,
        observations: s.observations,
        best: outcome.best,
        blockers: outcome.blockers,
        fired: outcome.fired,
        casProbes: outcome.casProbes,
        gapMaxMin: CFG.gapMaxMin,
        gapIdealMin: CFG.gapIdealMin,
        commit: COMMIT,
        groups: {
          parents: {
            botId: parents.botId, scheduleId: parents.scheduleId, applicants: parents.applicantIds.length,
            consularDate: parents.consularDate, consularTime: parents.consularTime,
            casDate: parents.casDate, casTime: parents.casTime,
          },
          children: {
            botId: children.botId, scheduleId: children.scheduleId, applicants: children.applicantIds.length,
            consularDate: children.consularDate, consularTime: children.consularTime,
            casDate: children.casDate, casTime: children.casTime,
          },
        },
      },
    });
    lastFingerprint = fp;
    lastScanWriteAt = Date.now();
    rememberSamples(s);
    if (Math.random() < 0.02) {
      const cutoff = new Date(Date.now() - SCAN_RETENTION_DAYS * 86400_000);
      await db.delete(sniperScans).where(and(eq(sniperScans.scanKey, SCAN_KEY), lt(sniperScans.scannedAt, cutoff)));
    }
    return 'written';
  } catch (err) {
    log(`  saveScan fallo (no bloquea el sniper): ${(err as Error).message}`);
    return 'skipped';
  }
}

/** Al arrancar, recupera la huella de la ultima fila para no escribir un duplicado. */
async function primeScanState(): Promise<void> {
  try {
    const [row] = await db.select().from(sniperScans)
      .where(eq(sniperScans.scanKey, SCAN_KEY))
      .orderBy(desc(sniperScans.scannedAt)).limit(1);
    if (row) lastScanWriteAt = new Date(row.scannedAt).getTime();
  } catch { /* la tabla puede no existir todavia */ }
}

// ─────────────────────────── Movimiento ───────────────────────────

async function verifyMoved(g: Group, date: string, time: string): Promise<boolean> {
  await sleep(2000);
  try {
    await syncCurrentAppointment(g);
  } catch (err) {
    log(`  [${g.role}] verificacion post-POST fallo al leer /groups: ${(err as Error).message}`);
    return false;
  }
  const ok = g.consularDate === date && g.consularTime === time;
  log(`  [${g.role}] portal dice: consular ${g.consularDate} ${g.consularTime} | CAS ${g.casDate} ${g.casTime} → ${ok ? 'OK' : 'NO COINCIDE'}`);
  return ok;
}

interface MoveSnapshot {
  prevDate: string | null;
  prevTime: string | null;
  prevCasDate: string | null;
  prevCasTime: string | null;
}

/**
 * Pide el authenticity_token del grupo. Es un GET.
 *
 * Se hace ANTES del primer POST, para los DOS grupos, porque cada peticion entre el POST 1
 * y el POST 2 es tiempo en el que el cupo del segundo grupo puede desaparecer. Con los
 * tokens ya en mano, los 2 POST salen con ~1s de diferencia en vez de ~5s.
 */
async function primeTokens(g: Group): Promise<void> {
  const client = await ensureSession(g);
  await client.refreshTokens();
}

function snapshot(g: Group): MoveSnapshot {
  return { prevDate: g.consularDate, prevTime: g.consularTime, prevCasDate: g.casDate, prevCasTime: g.casTime };
}

/** Solo el POST. Sin verificar, sin dormir. Devuelve lo que dijo el portal. */
async function postMove(g: Group, date: string, time: string, cas: CasPick | null): Promise<boolean> {
  const client = await ensureSession(g);
  log(`  [${g.role}] POST → consular ${date} ${time} | CAS ${cas ? `${cas.date} ${cas.time}` : 'N/A'}`);
  try {
    return await client.reschedule(date, time, cas?.date, cas?.time);
  } catch (err) {
    log(`  [${g.role}] POST lanzo error: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Verifica contra /groups, escribe `reschedule_logs` y sincroniza `bots`.
 * `reschedule()` tiene falsos positivos documentados, entonces manda el portal.
 */
async function confirmMove(
  g: Group, date: string, time: string, cas: CasPick | null,
  claimed: boolean, snap: MoveSnapshot, gapMin: number,
): Promise<boolean> {
  log(`  [${g.role}] reschedule() dijo ${claimed}. Verificando contra el portal...`);
  const real = await verifyMoved(g, date, time);

  await db.insert(rescheduleLogs).values({
    botId: g.botId,
    oldConsularDate: snap.prevDate,
    oldConsularTime: snap.prevTime,
    oldCasDate: snap.prevCasDate,
    oldCasTime: snap.prevCasTime,
    newConsularDate: real ? date : null,
    newConsularTime: real ? time : null,
    newCasDate: real && cas ? cas.date : null,
    newCasTime: real && cas ? cas.time : null,
    success: real,
    provider: g.proxyProvider,
    failStep: real ? null : 'dual_sniper_verify',
    error: real ? null : `[dual_sniper] claimed=${claimed} target=${date} ${time} actual=${g.consularDate} ${g.consularTime}`,
    detail: { source: SCAN_KEY, role: g.role, gapMin, claimed },
  });

  if (real) {
    g.rescheduleCount += 1;
    g.dateFailures = clearOnCasAvailable(g.dateFailures, date);
    await db.update(bots).set({
      currentConsularDate: g.consularDate,
      currentConsularTime: g.consularTime,
      currentCasDate: g.casDate,
      currentCasTime: g.casTime,
      rescheduleCount: g.rescheduleCount,
      casCacheJson: { ...(g.casCache ?? {} as CasCacheData), dateFailureTracking: g.dateFailures },
    }).where(eq(bots.id, g.botId));
  }
  return real;
}

/** POST + verificacion, para un solo grupo. Se usa en las fases de rescate. */
async function commitMove(g: Group, c: Candidate, cas: CasPick | null, consularTime: string): Promise<boolean> {
  const snap = snapshot(g);
  await primeTokens(g);
  const claimed = await postMove(g, c.date, consularTime, cas);
  return confirmMove(g, c.date, consularTime, cas, claimed, snap, c.gapMin);
}

/**
 * Anti-spam de correos. Un evento con la misma huella no se repite antes de este tiempo.
 * A 30s por ciclo, sin esto una condicion estable mandaria 120 correos por hora.
 */
const ALERT_MIN_GAP_MS = 60 * 60_000;
const lastAlertAt = new Map<string, number>();

/** Manda el aviso solo si la huella cambio o si paso ALERT_MIN_GAP_MS. */
async function alertOnce(botId: number, event: string, fingerprint: string, data: Record<string, unknown>): Promise<void> {
  const key = `${event}#${fingerprint}`;
  const prev = lastAlertAt.get(key);
  if (prev && Date.now() - prev < ALERT_MIN_GAP_MS) return;
  lastAlertAt.set(key, Date.now());
  log(`  aviso por correo: ${event} (${fingerprint})`);
  await alert(botId, event, data);
}

async function alert(botId: number, event: string, data: Record<string, unknown>): Promise<void> {
  try {
    const [row] = await db.select().from(bots).where(eq(bots.id, botId));
    if (!row) return;
    await notifyUser(row as never, event, data);
  } catch (err) {
    log(`  aviso fallo: ${(err as Error).message}`);
  }
}

// ─────────────────────────── Ciclo ───────────────────────────

async function cycle(parents: Group, children: Group): Promise<Phase> {
  await syncCurrentAppointment(parents);
  await syncCurrentAppointment(children);
  log(`  PADRES  consular ${parents.consularDate} ${parents.consularTime} | CAS ${parents.casDate} ${parents.casTime}`);
  log(`  NINOS   consular ${children.consularDate} ${children.consularTime} | CAS ${children.casDate} ${children.casTime}`);

  const phase = computePhase(parents, children, CFG);
  log(`  fase: ${phase}`);
  if (phase === 'DONE') return 'DONE';

  const s = await scan(parents, children, phase);
  const outcome: CycleOutcome = {
    best: s.best && { date: s.best.date, parentsTime: s.best.parentsTime, childrenTime: s.best.childrenTime, gapMin: s.best.gapMin },
    blockers: [],
    fired: false,
    casProbes: [],
  };
  if (s.ranked.length === 0) {
    outcome.blockers.push(s.windowDays.length === 0 ? 'sin_dias_en_ventana' : 'sin_par_valido');
    log(`  sniper_scans: ${await saveScan(s, phase, parents, children, outcome)}`);
    return phase;
  }

  // Se prueban los pares del mejor al peor. Una fecha en cooldown por muro CAS se salta
  // sin gastar requests, hasta que el bloqueo expire (ver CAS_TUNING).
  const now = Date.now();
  const roles = movingRoles(phase);
  let cand: Candidate | null = null;
  const rejected: string[] = [];
  const loggedPause = new Set<string>();

  for (const c of s.ranked) {
    const blockedBy = roles.filter((r) => isBlocked((r === 'PARENTS' ? parents : children).dateFailures[c.date], now));
    if (blockedBy.length > 0) {
      // Un dia con 5 horarios genera 15 pares. Se avisa una sola vez por fecha.
      if (!loggedPause.has(c.date)) {
        loggedPause.add(c.date);
        const until = (blockedBy[0] === 'PARENTS' ? parents : children).dateFailures[c.date]!.blockedUntil!;
        log(`  ${c.date} en pausa por muro CAS (${blockedBy.join(',')}) hasta ${until.slice(11, 16)}Z. Se salta.`);
        rejected.push(`cas_cooldown ${c.date}`);
      }
      continue;
    }

    for (const role of roles) {
      if (role === 'PARENTS') {
        c.parentsCas = await pickCas(parents, c.date, c.parentsTime, null, null, outcome.casProbes);
        log(`  [PARENTS] CAS elegida: ${c.parentsCas ? `${c.parentsCas.date} ${c.parentsCas.time}${c.parentsCas.inWindow ? ' (en ventana)' : ' (FUERA de ventana)'}` : 'NINGUNA'}`);
      } else {
        const preferDate = c.parentsCas?.date ?? parents.casDate;
        const preferTime = c.parentsCas?.time ?? parents.casTime;
        c.childrenCas = await pickCas(children, c.date, c.childrenTime, preferDate, preferTime, outcome.casProbes);
        log(`  [CHILDREN] CAS elegida: ${c.childrenCas ? `${c.childrenCas.date} ${c.childrenCas.time}${c.childrenCas.inWindow ? ' (en ventana)' : ' (FUERA de ventana)'}` : 'NINGUNA'}`);
      }
    }

    const f = verifyCandidate(c, parents, children, phase, effectiveConfig(CFG, phase), todayISO());
    if (f.length === 0 && c.gapMin === 0 && REQUIRE_BACKUP_TIME_ON_GAP0 && roles.length === 2) {
      // ¿Tiene el dia otro horario que sirva de respaldo para el 2do grupo?
      const secondRole = PARENTS_FIRST ? 'CHILDREN' : 'PARENTS';
      const obs = s.observations.find((o) => o.date === c.date && o.source === 'window');
      const pool = secondRole === 'CHILDREN' ? (obs?.childrenTimes ?? []) : (obs?.parentsTimes ?? []);
      const backups = pool.filter((t) => t !== c.parentsTime);
      if (backups.length === 0) {
        log(`  ${c.date} ${c.parentsTime} tiene gap 0 y ningun horario de respaldo para ${secondRole}.`);
        log(`  Se salta para no arriesgar partir la familia. Desactivar con --no-backup-guard.`);
        rejected.push(`gap0_sin_respaldo ${c.date}`);
        continue;
      }
      log(`  ${c.date} gap 0 con ${backups.length} horario(s) de respaldo para ${secondRole}: ${backups.join(',')}`);
    }
    if (f.length === 0) { cand = c; break; }
    log(`  ${c.date} ${c.parentsTime}/${c.childrenTime} rechazado:\n    - ${f.join('\n    - ')}`);
    rejected.push(...f);
  }

  if (!cand) {
    outcome.blockers = rejected.length > 0 ? rejected : ['sin_par_valido'];
    outcome.best = null;
    log(`  ningun par paso los verificadores (${s.ranked.length} probados).`);
    log(`  sniper_scans: ${await saveScan(s, phase, parents, children, outcome)}`);
    return phase;
  }
  outcome.best = { date: cand.date, parentsTime: cand.parentsTime, childrenTime: cand.childrenTime, gapMin: cand.gapMin };

  log('  verificadores V1-V9: OK');

  if (!COMMIT) {
    outcome.blockers = ['dry_run'];
    log(`  sniper_scans: ${await saveScan(s, phase, parents, children, outcome)}`);
    log('  DRY-RUN. Con --commit haria:');
    for (const role of movingRoles(phase)) {
      const t = role === 'PARENTS' ? cand.parentsTime : cand.childrenTime;
      const cas = role === 'PARENTS' ? cand.parentsCas : cand.childrenCas;
      log(`    ${role} → ${cand.date} ${t} (CAS ${cas?.date} ${cas?.time})`);
    }
    return phase;
  }

  const liveFails = await reverifyLive(cand, parents, children, phase);
  if (liveFails.length > 0) {
    outcome.blockers = liveFails;
    log(`  CUPO PERDIDO ENTRE LA LECTURA Y EL POST:\n    - ${liveFails.join('\n    - ')}`);
    log(`  sniper_scans: ${await saveScan(s, phase, parents, children, outcome)}`);
    return phase;
  }
  outcome.fired = true;
  log(`  sniper_scans: ${await saveScan(s, phase, parents, children, outcome)}`);
  log('  re-verificacion en vivo: OK. Ejecutando.');
  await alertOnce(children.botId, 'sniper_ready', `${cand.date}|${cand.parentsTime}|${cand.childrenTime}`, {
    fecha: cand.date,
    padres: cand.parentsTime,
    ninos: cand.childrenTime,
    separacion_min: cand.gapMin,
    cas_padres: cand.parentsCas ? `${cand.parentsCas.date} ${cand.parentsCas.time}` : 'n/a',
    cas_ninos: cand.childrenCas ? `${cand.childrenCas.date} ${cand.childrenCas.time}` : 'n/a',
    tramo_prioritario: inPreferred(cand.date, CFG) ? 'si' : 'no',
  });

  // ── Orden de los POST ──
  // Primero el grupo escaso. Ver PARENTS_FIRST arriba.
  const order: Array<'PARENTS' | 'CHILDREN'> = PARENTS_FIRST ? ['PARENTS', 'CHILDREN'] : ['CHILDREN', 'PARENTS'];
  const toMove = order.filter((r) => movingRoles(phase).includes(r));
  log(`  orden de POST: ${toMove.join(' → ')}`);

  const timeFor = (r: 'PARENTS' | 'CHILDREN') => (r === 'PARENTS' ? cand.parentsTime : cand.childrenTime);
  const casFor = (r: 'PARENTS' | 'CHILDREN') => (r === 'PARENTS' ? cand.parentsCas : cand.childrenCas);
  const groupFor = (r: 'PARENTS' | 'CHILDREN') => (r === 'PARENTS' ? parents : children);

  // ── Tokens de los DOS grupos ANTES de tocar nada ──
  // El authenticity_token es de sesion y se pide con un GET. Sacarlo del camino critico
  // reduce la ventana entre el POST 1 y el POST 2 de ~5s a ~1s. Esa ventana es justo
  // donde el cupo del segundo grupo puede desaparecer.
  const first = toMove[0]!;
  const second = toMove.length > 1 ? toMove[1]! : null;
  const t0 = Date.now();
  await Promise.all(toMove.map((r) => primeTokens(groupFor(r))));
  log(`  tokens listos para ${toMove.join(' y ')} (${Date.now() - t0}ms)`);

  const snapFirst = snapshot(groupFor(first));
  const snapSecond = second ? snapshot(groupFor(second)) : null;

  // ── POST 1 ──
  const claimedFirst = await postMove(groupFor(first), cand.date, timeFor(first), casFor(first));

  // ── POST 2, pegado al 1 ──
  // No se verifica el POST 1 antes de mandar el 2: cada verificacion cuesta ~3s y en ese
  // rato el cupo se va. `claimed` del portal alcanza como semaforo. Las dos citas se
  // verifican juntas al final, y si una fallo, la fase de rescate lo arregla.
  let claimedSecond = false;
  let postGapMs = 0;
  if (second && claimedFirst) {
    const t1 = Date.now();
    claimedSecond = await postMove(groupFor(second), cand.date, timeFor(second), casFor(second));
    postGapMs = Date.now() - t1;
  }

  // ── Verificacion real de los dos, contra /groups ──
  const okFirst = await confirmMove(groupFor(first), cand.date, timeFor(first), casFor(first), claimedFirst, snapFirst, cand.gapMin);
  if (!okFirst) {
    log(`  [${first}] no se movio. Se reintenta en el proximo ciclo.`);
    await alert(groupFor(first).botId, 'reschedule_failed', {
      target: `${cand.date} ${timeFor(first)}`, note: `dual sniper: fallo el POST 1 (${first})`,
    });
    return phase;
  }
  await alert(groupFor(first).botId, 'reschedule_success', {
    newDate: cand.date, newTime: timeFor(first), note: `dual sniper POST 1/2 (${first})`,
  });

  if (second && claimedSecond) {
    const okSecond = await confirmMove(groupFor(second), cand.date, timeFor(second), casFor(second), claimedSecond, snapSecond!, cand.gapMin);
    if (okSecond) {
      log(`  LAS DOS CITAS QUEDARON. Separacion entre los 2 POST: ${postGapMs}ms.`);
      await alert(groupFor(second).botId, 'reschedule_success', {
        newDate: cand.date, newTime: timeFor(second), gapMin: cand.gapMin, note: `dual sniper POST 2/2 (${second})`,
      });
      await syncCurrentAppointment(parents);
      await syncCurrentAppointment(children);
      return computePhase(parents, children, CFG);
    }
  }

  if (!second) {
    await syncCurrentAppointment(parents);
    await syncCurrentAppointment(children);
    return computePhase(parents, children, CFG);
  }

  // ── Rescate del 2do grupo ──
  // Se llega aqui si el POST 2 no cuajo. Tomar el cupo del POST 1 lo borra del portal, y
  // el cupo del 2do grupo pudo desaparecer en esos milisegundos. NO se espera al proximo
  // ciclo: se re-leen las horas del dia y se prueba la mejor alternativa valida,
  // hasta SECOND_MOVE_RETRIES veces. El primer grupo ya quedo movido.
  log(`  [${second}] el POST 2 no cuajo. Rescate inmediato sobre el ${cand.date}.`);
  const secondGroup = groupFor(second);
  const anchorTime = timeFor(first);
  const rescueCfg = effectiveConfig(CFG, second === 'CHILDREN' ? 'CHILD_ONLY' : 'PARENT_ONLY');
  const tried = new Set<string>();

  for (let attempt = 1; attempt <= SECOND_MOVE_RETRIES; attempt += 1) {
    const live = (await (await ensureSession(secondGroup)).getConsularTimes(cand.date)).available_times ?? [];
    // El orden en el dia no cambia: los padres siempre antes que los ninos.
    const options = second === 'CHILDREN'
      ? buildPairs(cand.date, [anchorTime], live, rescueCfg).map((x) => ({ time: x.c, gapMin: x.gapMin }))
      : buildPairs(cand.date, live, [anchorTime], rescueCfg).map((x) => ({ time: x.p, gapMin: x.gapMin }));
    const usable = options.filter((o) => !tried.has(o.time)).sort((a, b) => a.gapMin - b.gapMin);

    if (usable.length === 0) {
      log(`  [${second}] intento ${attempt}/${SECOND_MOVE_RETRIES}: el dia ${cand.date} no ofrece ninguna hora valida (vivo: ${live.join(',') || 'ninguna'}).`);
      break;
    }

    const pick = usable[0]!;
    tried.add(pick.time);
    log(`  [${second}] intento ${attempt}/${SECOND_MOVE_RETRIES}: ${cand.date} ${pick.time} (gap ${pick.gapMin}min)`);

    const preferDate = second === 'CHILDREN' ? (cand.parentsCas?.date ?? parents.casDate) : (cand.childrenCas?.date ?? children.casDate);
    const preferTime = second === 'CHILDREN' ? (cand.parentsCas?.time ?? parents.casTime) : (cand.childrenCas?.time ?? children.casTime);
    const cas = await pickCas(secondGroup, cand.date, pick.time, preferDate, preferTime, outcome.casProbes);

    const attemptCand: Candidate = second === 'CHILDREN'
      ? { ...cand, childrenTime: pick.time, gapMin: pick.gapMin, childrenCas: cas }
      : { ...cand, parentsTime: pick.time, gapMin: pick.gapMin, parentsCas: cas };
    const phase2: Phase = second === 'CHILDREN' ? 'CHILD_ONLY' : 'PARENT_ONLY';
    const f2 = verifyCandidate(attemptCand, parents, children, phase2, rescueCfg, todayISO());
    if (f2.length > 0) {
      log(`  [${second}] intento rechazado:\n    - ${f2.join('\n    - ')}`);
      continue;
    }

    const ok = await commitMove(secondGroup, attemptCand, cas, pick.time);
    if (ok) {
      await alert(secondGroup.botId, 'reschedule_success', {
        newDate: cand.date, newTime: pick.time, gapMin: pick.gapMin, note: `dual sniper POST 2/2 (${second})`,
      });
      await syncCurrentAppointment(parents);
      await syncCurrentAppointment(children);
      return computePhase(parents, children, CFG);
    }
    log(`  [${second}] el POST no cuajo. Se prueba otra hora del mismo dia.`);
  }

  // Sin rescate en este ciclo. El primero quedo movido; el loop sigue cazando.
  const rescuePhase: Phase = second === 'CHILDREN' ? 'CHILD_ONLY' : 'PARENT_ONLY';
  log(`  [${second}] NO SE PUDO EN ESTE CICLO. ${first} ya quedo en ${cand.date} ${anchorTime}.`);
  log(`  Paso a modo ${rescuePhase}: cada 30s busca una hora para ${second} el ${cand.date}, nunca antes que los padres, con techo de ${CFG.rescueGapMaxMin} min.`);
  await alert(secondGroup.botId, 'sniper_split', {
    grupo_movido: first,
    quedo_en: `${cand.date} ${anchorTime}`,
    grupo_pendiente: second,
    objetivo: `${cand.date}, ${second === 'CHILDREN' ? 'despues' : 'antes'} de ${anchorTime}`,
    modo: rescuePhase,
    nota: 'El sniper sigue cazando ese mismo dia cada 30 segundos.',
  });
  return rescuePhase;

  await syncCurrentAppointment(parents);
  await syncCurrentAppointment(children);
  return computePhase(parents, children, CFG);
}

// ─────────────────────────── Main ───────────────────────────

async function main(): Promise<void> {
  log('═══ DUAL SNIPER · familia Alvarez/Perez ═══');
  log(`  ventana de aceptacion: ${CFG.windowStart} → ${CFG.windowEnd}`);
  log(`  tramo con prioridad:   ${CFG.preferStart} → ${CFG.preferEnd} (gana sobre el resto, aunque tenga peor gap)`);
  log(`  observacion de patrones: ${OBSERVE_START} → ${OBSERVE_END} (${SAMPLE_PER_CYCLE} dias por ciclo)`);
  log(`  gap: techo ${CFG.gapMaxMin}min (par), ${CFG.rescueGapMaxMin}min (rescate), ideal <=${CFG.gapIdealMin}min (0 = misma hora). Padres nunca despues que ninos.`);
  log(`  orden de POST: ${PARENTS_FIRST ? 'PADRES primero' : 'NINOS primero (asegura el cupo escaso de 3)'}`);
  log(`  guardia gap 0: ${REQUIRE_BACKUP_TIME_ON_GAP0 ? 'ACTIVO (exige horario de respaldo)' : 'desactivado'}`);
  log(`  deadline: ${DEADLINE}`);
  log(`  CAS: prioridad 2. Debe existir. ${CFG.casInWindowRequired ? 'Obligatoria en ventana.' : 'Se prefiere en ventana.'}`);
  log(`  modo: ${COMMIT ? '*** COMMIT (movimientos REALES) ***' : 'DRY-RUN'} | ${LOOP ? `loop cada ${POLL_INTERVAL_MS / 60_000} min` : 'un solo ciclo'}`);

  const parents = await loadGroup(PARENTS_BOT_ID, 'PARENTS');
  const children = await loadGroup(CHILDREN_BOT_ID, 'CHILDREN');
  log(`  PADRES = bot ${parents.botId} schedule ${parents.scheduleId} (${parents.applicantIds.length} personas)`);
  log(`  NINOS  = bot ${children.botId} schedule ${children.scheduleId} (${children.applicantIds.length} personas)`);
  if (parents.userId !== children.userId) throw new Error('los 2 grupos no comparten userId');
  if (parents.scheduleId === children.scheduleId) throw new Error('los 2 grupos apuntan al mismo schedule');
  if (parents.consularFacilityId !== children.consularFacilityId)
    throw new Error('los 2 grupos apuntan a consulados distintos');
  await primeScanState();

  let errors = 0;
  let n = 0;
  for (;;) {
    n += 1;
    log(`─── ciclo ${n} ───`);
    try {
      const phase = await cycle(parents, children);
      errors = 0;
      if (phase === 'DONE') {
        log('OBJETIVO CUMPLIDO:');
        log(`  PADRES ${parents.consularDate} ${parents.consularTime} | CAS ${parents.casDate} ${parents.casTime}`);
        log(`  NINOS  ${children.consularDate} ${children.consularTime} | CAS ${children.casDate} ${children.casTime}`);
        const gap = currentGapMin(parents, children);
        log(`  gap consular: ${gap} min${gap !== null && gap > CFG.gapMaxMin ? ` (por encima del ideal de ${CFG.gapIdealMin} min; quedaron juntos el mismo dia)` : ''}`);
        await alert(PARENTS_BOT_ID, 'sniper_done', {
          padres_consular: `${parents.consularDate} ${parents.consularTime}`,
          padres_cas: `${parents.casDate} ${parents.casTime}`,
          ninos_consular: `${children.consularDate} ${children.consularTime}`,
          ninos_cas: `${children.casDate} ${children.casTime}`,
          separacion_min: currentGapMin(parents, children),
        });
        break;
      }
    } catch (err) {
      errors += 1;
      log(`  ERROR (${errors}/${COOLDOWN_ERRORS}): ${(err as Error).message}`);
      if (err instanceof SessionExpiredError) {
        parents.client = null; children.client = null;
        log('  sesion expirada. Se re-loguea en el proximo ciclo.');
      }
      if (errors >= COOLDOWN_ERRORS) {
        log(`  ${errors} errores seguidos. Cooldown de ${COOLDOWN_MS / 60000} min.`);
        parents.client = null; children.client = null;
        await sleep(COOLDOWN_MS);
        errors = 0;
      }
    }

    if (!LOOP) break;
    if (todayISO() > DEADLINE) {
      log(`  DEADLINE ${DEADLINE} superado. El sniper para.`);
      await alert(PARENTS_BOT_ID, 'sniper_deadline', { deadline: DEADLINE, note: 'dual sniper paro sin cumplir el objetivo' });
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  process.exit(0);
}

main().catch((err) => {
  log('FATAL:', (err as Error).stack ?? (err as Error).message);
  process.exit(1);
});

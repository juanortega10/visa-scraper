import { logger } from '@trigger.dev/sdk/v3';
import { db } from '../db/client.js';
import { bots, sessions, rescheduleLogs } from '../db/schema.js';
import { eq, sql, or, lt, gt, isNull, and } from 'drizzle-orm';
import { encrypt } from './encryption.js';
import { VisaClient, SessionExpiredError, type DaySlot, type CurrentAppointment } from './visa-client.js';
import { filterDates, filterTimes, isAtLeastNDaysEarlier, isDateExcluded, computeMinDate, isSniperActive, isWithinWindow } from '../utils/date-helpers.js';
import { notifyUserTask } from '../trigger/notify-user.js';
import type { DateRange, TimeRange } from '../utils/date-helpers.js';
import type { CasCacheData, CasCacheEntry, DateFailureEntry, FailureDimension } from '../db/schema.js';
import { recordFailure } from './date-failure-tracker.js';

/** Minimal bot fields needed by executeReschedule (avoids requiring full Bot with casCacheJson). */
export interface RescheduleBot {
  currentConsularDate: string | null;
  currentConsularTime: string | null;
  currentCasDate: string | null;
  currentCasTime: string | null;
  ascFacilityId: string;
  targetDateBefore?: string | null;
  targetDateAfter?: string | null;
  sniperMode?: boolean | null;
  maxCasGapDays?: number | null;
  skipCas?: boolean;
  speculativeTimeFallback?: boolean;
  /** Horas a adivinar para este bot, en orden. Vacio o null usa `SPECULATIVE_TIMES`. */
  speculativeTimes?: string[] | null;
  minDaysFromToday?: number | null;
  excludedWeekdays?: number[] | null;
}

// Historical times seen at Lima facility 115 (es-pe). Used as fallback when
// getConsularTimes returns empty for phantom dates. Order: most recent first.
/**
 * Edad maxima del `authenticity_token` precalentado para saltarse el refresco.
 *
 * El techo duro de la sesion es 45 min (`peru-sniper-core.ts:POLITICA_TOKEN`), y el
 * re-login preventivo corre a los 44 min. Con 12 min queda margen de sobra: el token
 * usado nunca pasa de un cuarto de la vida de la sesion.
 */
export const MAX_EDAD_TOKEN_MS = 12 * 60_000;

/**
 * Horas a adivinar cuando `times.json` vuelve vacio, si el bot tiene el fallback.
 *
 * OJO con la evidencia: este trio NO esta medido. Las 354 apariciones de
 * `07:30 / 10:00 / 10:15` en `reschedule_logs.detail.timesFound` para es-pe son ESTA
 * MISMA constante, que el fallback inyecta y el log guarda. No son lecturas del portal.
 *
 * Lo que si esta medido (2026-08-30, bots sin fallback, 5.372 horas reales):
 *   es-co reparte 19 valores, con `07:15` a la cabeza (15,9%). `10:15` sale 1,2%.
 *   es-pe tiene 6 lecturas reales: 08:00, 09:15, 09:30.
 *
 * Como las horas dependen del schedule, cada bot puede traer las suyas en
 * `bots.speculative_times`. Esta constante es solo el respaldo.
 */
const SPECULATIVE_TIMES = ['10:15', '10:00', '07:30'];

/**
 * Lee la cita del portal y EXIGE respuesta. Un `null` se convierte en excepcion.
 *
 * BUG QUE ARREGLA (encontrado el 2026-08-30): `getCurrentAppointment()` devuelve
 * `null` SIN lanzar en tres casos: sin `userId`, con HTTP distinto de 200, o si no
 * encuentra el grupo. La verificacion posterior al POST decia
 * `if (verifyAppt && verifyAppt.consularDate !== candidate.date)`. Con `null` esa
 * condicion no entra, y `verified` se quedaba en `true`: una lectura fallida se
 * anotaba como verificacion exitosa.
 *
 * Caso real. Bot 7, 2026-04-17 18:25: se registro `success=true` moviendo a
 * 2026-04-22 10:15. La cita nunca se movio de 2027-07-30 07:30, en las 277 filas de
 * intento entre 2026-02-24 y 2026-08-25. Al dia siguiente el bot volvio a intentar la
 * MISMA fecha 2026-04-22, que es la prueba de que nunca se movio. El contador de
 * reagendamientos bajo igual.
 *
 * Lanzar deja que el `catch` que ya existe haga lo correcto: marcar el intento como
 * no verificado y, si fue especulativo, devolver el cupo con `releaseSlot()`.
 */
async function leerCitaVerificada(client: VisaClient): Promise<CurrentAppointment> {
  // Un reintento INMEDIATO. La mayoria de los `null` son transitorios (HTTP != 200) y
  // esta lectura decide si se anota un reagendamiento, entonces una segunda peticion
  // sale barata al lado de un exito fantasma.
  //
  // Sin espera entre los dos intentos a proposito: una pausa con `setTimeout` cuelga
  // cualquier test que use `vi.useFakeTimers()` (rompio 15 el 2026-08-30), y el
  // beneficio de esperar 400 ms nunca se midio.
  for (let intento = 0; intento < 2; intento++) {
    const appt = await client.getCurrentAppointment();
    if (appt) return appt;
  }
  throw new Error('getCurrentAppointment devolvio null dos veces (sin userId, HTTP != 200, o grupo no encontrado)');
}


export interface RescheduleAttempt {
  date: string;
  consularTime?: string;
  casDate?: string;
  casTime?: string;
  failReason: 'no_times' | 'no_cas_days' | 'no_cas_times' | 'no_cas_times_cached' | 'post_failed' | 'post_error' | 'fetch_error' | 'session_expired' | 'verification_failed';
  failStep?: 'get_consular_times' | 'parallel_cas_days' | 'get_cas_times' | 'post_reschedule';
  error?: string;
  cause?: string;
  durationMs: number;
  timesFound?: string[];
  /**
   * Del candidato elegido al POST enviado. Es lo unico que compite en una
   * carrera por un cupo: la verificacion posterior ya no. `durationMs` mezcla
   * las tres cosas y por eso no sirve para decidir si llegamos tarde.
   */
  msToPost?: number;
  /**
   * Horarios que ofrecio el PORTAL para esa fecha, sin filtrar y sin contar los
   * especulativos. 0 significa fecha fantasma: el calendario la lista y no tiene
   * cupo real detras. Mayor que 0 significa que el cupo existia y nos ganaron.
   */
  timesSeen?: number;
}

/** Lo que `columnasDeIntento` necesita de un intento fallido. */
export type ColumnasIntento = Pick<
  RescheduleAttempt,
  'failStep' | 'failReason' | 'durationMs' | 'error' | 'cause' | 'timesFound' | 'msToPost' | 'timesSeen'
>;

/**
 * Traduce un intento fallido a las columnas de `reschedule_logs`. UNA sola fuente.
 *
 * Existe por un bug del 2026-08-31. La rama que registra "se acabaron los intentos"
 * armaba este objeto a mano, campo por campo, y se le olvidaron `msToPost` y
 * `timesSeen`. Las otras seis ramas si los escribian. Resultado: las 23.494 filas de
 * `reschedule_logs` con `times_seen` nulo, incluidas las DOS unicas detecciones del
 * bot 299 de Peru, que es justo donde el dato hacia falta.
 *
 * Cualquier campo diagnostico nuevo se agrega AQUI y llega solo a todas las ramas.
 */
export function columnasDeIntento(a: ColumnasIntento) {
  return {
    failStep: a.failStep ?? null,
    failReason: a.failReason,
    durationMs: a.durationMs,
    msToPost: a.msToPost ?? null,
    timesSeen: a.timesSeen ?? null,
    detail: {
      ...(a.timesFound !== undefined ? { timesFound: a.timesFound } : {}),
      ...(a.cause ? { cause: a.cause } : {}),
      ...(a.error ? { error: a.error } : {}),
    } satisfies Record<string, unknown>,
  };
}

export interface RescheduleParams {
  client: VisaClient;
  botId: number;
  bot: RescheduleBot;
  dateExclusions: DateRange[];
  timeExclusions: TimeRange[];
  preFetchedDays?: DaySlot[];
  casCacheJson?: CasCacheData | null;
  dryRun: boolean;
  maxAttempts?: number;
  pending: Promise<unknown>[];
  loginCredentials?: { email: string; password: string; scheduleId: string; applicantIds: string[]; locale: string; botId?: number };
  maxReschedules?: number | null;
  /** Saldo que reporta el PORTAL. Distinto de `maxReschedules`, que es nuestro presupuesto. */
  portalRemaining?: number | null;
  runId?: string;
  sessionAgeMs?: number;
  /**
   * Lectura ya lanzada de `bots.current_consular_date` para la guarda de carrera.
   * El llamador la dispara en paralelo con las otras consultas del camino critico.
   * La guarda NO cambia: se espera aqui, antes de elegir candidata y antes del POST.
   * Sin este parametro la consulta se hace aqui mismo, igual que antes.
   */
  fechaFrescaPromesa?: PromiseLike<Array<{ currentConsularDate: string | null }>>;
}

export interface RescheduleResult {
  success: boolean;
  date?: string;
  consularTime?: string;
  casDate?: string;
  casTime?: string;
  reason?: string;
  totalDurationMs?: number;
  attempts?: RescheduleAttempt[];
  /** Dates where POST returned a fake success but verification showed appointment unchanged.
   *  Caller should persist these to blockedConsularDates so they aren't retried next poll. */
  falsePositiveDates?: string[];
  /** Dates with 3+ failures of any type in this call — caller should block for 1h. */
  repeatedlyFailingDates?: string[];
  /** Per-date failure tracker delta — caller should persist to casCacheJson.dateFailureTracking. */
  dateFailureTrackingDelta?: Record<string, DateFailureEntry>;
  /** Dates whose tracker entry just crossed the block threshold — caller should add to blockedConsularDates with 2h TTL. */
  newlyBlockedDates?: string[];
}

export async function executeReschedule(params: RescheduleParams): Promise<RescheduleResult> {
  const {
    client,
    botId,
    bot,
    dateExclusions,
    timeExclusions,
    preFetchedDays,
    casCacheJson,
    dryRun,
    // Bajado de 5 a 3 el 2026-08-27. Evidencia en `reschedule_logs` (905 exitos):
    // hasta 3 candidatas se conserva el 98,3% de los exitos; de la 4 en adelante
    // solo salen 15 de 905 (1,7%) y cada intento cuesta 2-3 s. Ademas un run largo
    // empuja el proximo poll fuera de tiempo (`getPollingDelay` resta lo transcurrido),
    // o sea el bot queda ciego justo cuando aparecen cupos.
    maxAttempts = 3,
    pending,
    loginCredentials,
    maxReschedules,
    portalRemaining,
    runId,
    sessionAgeMs,
    fechaFrescaPromesa,
  } = params;
  const totalStart = Date.now();
  const failedAttempts: RescheduleAttempt[] = [];
  const provider = client.getConfig().proxyProvider;

  /** Common diagnostic columns for every reschedule_logs insert. */
  /**
   * `carrera` va aparte del intento fallido porque un EXITO tambien tiene que
   * registrar cuanto tardo el POST. Sin eso no hay con que comparar: no se sabe
   * como se ve ganar, solo como se ve perder.
   */
  const diag = (
    attempt?: ColumnasIntento,
    carrera?: { msToPost?: number; timesSeen?: number },
  ) => ({
    runId: runId ?? null,
    provider,
    sessionAgeMs: sessionAgeMs ?? null,
    ...(carrera ? { msToPost: carrera.msToPost ?? null, timesSeen: carrera.timesSeen ?? null } : {}),
    ...(attempt ? columnasDeIntento(attempt) : {}),
  });
  let successfulPosts = 0; // Track POSTs in this invocation for maxReschedules guard
  const minDate = computeMinDate(bot.minDaysFromToday);

  // SNIPER MODE: accept ANY consular date inside the window [targetDateAfter, targetDateBefore),
  // even if it is NOT earlier than the current appointment (overrides the strictly-earlier
  // protection — owner-authorized per bot). Requires both window bounds. Once a date is secured,
  // the secure-then-improve loop still drives toward the earliest in-window date.
  const sniperMode = isSniperActive(bot.sniperMode, bot.targetDateAfter, bot.targetDateBefore);
  const inSniperWindow = (d: string | null | undefined): boolean =>
    isWithinWindow(d, bot.targetDateAfter, bot.targetDateBefore);
  // The sniper override (take ANY in-window date, even a later one) applies ONLY while the current
  // appointment is still OUTSIDE the window. Once it is inside, the strictly-earlier rule returns:
  // the bot only improves, it never trades an in-window date for a later in-window one.
  const sniperFreeMove = sniperMode && !inSniperWindow(bot.currentConsularDate);

  /** Date bounds that apply to the CAS date too, not only to the consular date. */
  const casDateWithinBounds = (d: string): boolean =>
    (!bot.targetDateAfter || d >= bot.targetDateAfter)
    && (!bot.targetDateBefore || d < bot.targetDateBefore);


  if (dryRun) {
    const targetDate = preFetchedDays?.[0]?.date ?? '2026-12-15';
    const mockConsularDate = targetDate;
    const mockConsularTime = '08:00';
    const mockCasDate = new Date(new Date(targetDate).getTime() - 3 * 86400000).toISOString().split('T')[0]!;
    const mockCasTime = '07:30';

    logger.info('[DRY RUN] Mock reschedule', {
      botId,
      consular: `${mockConsularDate} ${mockConsularTime}`,
      cas: `${mockCasDate} ${mockCasTime}`,
    });

    pending.push(
      db.insert(rescheduleLogs).values({
        botId,
        oldConsularDate: bot.currentConsularDate,
        oldConsularTime: bot.currentConsularTime,
        oldCasDate: bot.currentCasDate,
        oldCasTime: bot.currentCasTime,
        newConsularDate: mockConsularDate,
        newConsularTime: mockConsularTime,
        newCasDate: mockCasDate,
        newCasTime: mockCasTime,
        success: true,
      }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
    );

    pending.push(
      notifyUserTask.trigger({
        botId,
        event: 'reschedule_success',
        data: {
          dryRun: true,
          oldConsularDate: bot.currentConsularDate,
          oldConsularTime: bot.currentConsularTime,
          newConsularDate: mockConsularDate,
          newConsularTime: mockConsularTime,
          newCasDate: mockCasDate,
          newCasTime: mockCasTime,
        },
      }).catch((e) => logger.error('notify trigger failed', { error: String(e) })),
    );

    logger.info('[DRY RUN] reschedule SUCCESS (mock)', {
      botId,
      old: `${bot.currentConsularDate} ${bot.currentConsularTime}`,
      new: `${mockConsularDate} ${mockConsularTime}`,
    });

    return {
      success: true,
      date: mockConsularDate,
      consularTime: mockConsularTime,
      casDate: mockCasDate,
      casTime: mockCasTime,
    };
  }

  // --- REAL MODE ---

  // RACE CONDITION GUARD: Re-read ONLY currentConsularDate from DB (minimal query).
  // Another worker may have already rescheduled to a better date.
  const candidateDate = preFetchedDays?.[0]?.date;
  const [freshData] = await (fechaFrescaPromesa ?? db
    .select({ currentConsularDate: bots.currentConsularDate })
    .from(bots)
    .where(eq(bots.id, botId)));

  if (!freshData) {
    logger.warn('Bot not found on re-read', { botId });
    return { success: false, reason: 'bot_not_found' };
  }

  const currentConsularDate = freshData.currentConsularDate;

  // Check if candidate is still better than the FRESH currentConsularDate.
  // SNIPER MODE skips this guard: acceptance is window-based (not strictly-earlier), and the
  // attempt loop re-filters candidates to the window via filterDates(targetDateAfter) below.
  if (!sniperMode && candidateDate && currentConsularDate) {
    if (!isAtLeastNDaysEarlier(candidateDate, currentConsularDate, 1)) {
      logger.info('RACE CONDITION GUARD: candidate no longer better after DB re-read', {
        botId,
        candidate: candidateDate,
        staleCurrentDate: bot.currentConsularDate,
        freshCurrentDate: currentConsularDate,
      });
      return { success: false, reason: 'race_condition_stale_data' };
    }
  }
  // Determine if this embassy requires CAS (biometrics) appointments
  let needsCas = !!bot.ascFacilityId && !bot.skipCas;

  // Build CAS cache map for fast lookup (valid for up to 60 min, stale kept as fallback).
  // Entries with forConsularDate are keyed by "casDate:consularDate"; legacy entries keyed by "casDate:".
  // Lookup: try context-specific key first, then legacy key.
  const casCache = new Map<string, CasCacheEntry>();
  const staleCasCache = new Map<string, CasCacheEntry>();
  let casCacheAgeMin = Infinity;
  const casCacheLookup = (cache: Map<string, CasCacheEntry>, casDate: string, consularDate: string): CasCacheEntry | undefined =>
    cache.get(`${casDate}:${consularDate}`) ?? cache.get(`${casDate}:`);
  if (needsCas && casCacheJson?.entries) {
    casCacheAgeMin = (Date.now() - new Date(casCacheJson.refreshedAt).getTime()) / 60000;
    if (casCacheAgeMin < 60) {
      for (const e of casCacheJson.entries) casCache.set(`${e.date}:${e.forConsularDate ?? ''}`, e);
      logger.info('CAS cache loaded', { botId, entries: casCache.size, ageMin: Math.round(casCacheAgeMin) });
    } else {
      for (const e of casCacheJson.entries) staleCasCache.set(`${e.date}:${e.forConsularDate ?? ''}`, e);
      logger.info('CAS cache too old for primary use, kept as fallback', { botId, entries: staleCasCache.size, ageMin: Math.round(casCacheAgeMin) });
    }
  }

  // CRITICAL: refreshTokens() MUST be called before any POST reschedule.
  // performLogin() fetches the appointment page with redirect: 'follow', which doesn't
  // reliably set the server-side session state (applicant selection). Without this state,
  // the POST returns 302 → sign_in even though GETs work fine.
  // refreshTokens() uses redirect: 'manual' and properly primes the session.
  //
  // LO QUE CAMBIO (2026-08-30): esta llamada ya NO bloquea antes de `times.json`.
  //
  //  1. Si el token viene precalentado y fresco, no se pide nada: 0 ms y 0 peticiones.
  //     El precalentamiento lo hace `poll-visa` fuera del camino critico.
  //  2. Si hace falta pedirlo, sale EN PARALELO con `times.json` y se espera recien
  //     cuando su resultado importa. El costo pasa de una suma a un maximo.
  //
  // Medido en el bot 299 el 2026-08-27: 13.832 ms de esta llamada mas 3.354 ms de
  // `times.json`, en serie, con un cupo que vivio 15 segundos.
  //
  // El salto por frescura NO aplica cuando la cuenta usa CAS: ahi `getHasAscFields()`
  // solo se conoce despues de leer la pagina, y sin ese dato una cuenta de renovacion
  // se iria por la rama de CAS y fallaria siempre con `no_cas_days`.
  const tokenFresco = !needsCas && client.getTokensAgeMs() <= MAX_EDAD_TOKEN_MS;
  let errorTokens: unknown = null;
  const tokensListos: Promise<void> = tokenFresco
    ? Promise.resolve()
    : (async () => {
        logger.info('Pre-reschedule refreshTokens (priming server-side state)', { botId });
        await client.refreshTokens();
        logger.info('Pre-reschedule refreshTokens OK', { botId });
      })().catch((e: unknown) => { errorTokens = e; });
  if (tokenFresco) {
    logger.info('refreshTokens OMITIDO: token precalentado y fresco', {
      botId, edadS: Math.round(client.getTokensAgeMs() / 1000),
    });
  }

  /**
   * Espera el refresco lanzado arriba y aplica sus efectos. Se llama una sola vez,
   * apenas `times.json` responde, y es idempotente en las vueltas siguientes.
   */
  let tokensAplicados = false;
  const esperarTokens = async (): Promise<void> => {
    if (tokensAplicados) return;
    tokensAplicados = true;
    // El try cubre el refresco Y la deteccion de campos ASC, igual que antes de
    // partir esto en dos. Solo `SessionExpiredError` sube; todo lo demas es una
    // advertencia y el POST se intenta igual.
    try {
      await tokensListos;
      if (errorTokens) throw errorTokens;
      // Auto-detect: if appointment page has no ASC fields, this account doesn't need CAS
      // (e.g. visa renewal / interview waiver). Override needsCas regardless of bot config.
      if (needsCas && client.getHasAscFields() === false) {
        logger.info('Auto-detected no ASC fields in appointment HTML — overriding needsCas to false', { botId, collectsBiometrics: client.getCollectsBiometrics() });
        needsCas = false;
      }
    } catch (refreshErr) {
      if (refreshErr instanceof SessionExpiredError) throw refreshErr;
      logger.warn('Pre-reschedule refreshTokens failed (will attempt POST anyway)', {
        botId, error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
      });
    }
  };

  /**
   * Motivo por el que NO se pudo verificar el ultimo POST contra el portal.
   *
   * `null` = la cita se leyo y confirmo. Con texto, el exito se anota igual (perder un
   * reagendamiento confirmado es peor) y la fila de `reschedule_logs` queda marcada
   * `[NO VERIFICADO: ...]`, entonces `scripts/audit-reschedule-attribution.ts` la puede
   * separar de un movimiento probado.
   */
  let sinVerificar: string | null = null;

  const exhaustedDates = new Set<string>();
  const falsePositiveDates = new Set<string>(); // Persisted to blockedConsularDates by caller
  const transientFailCount = new Map<string, number>();
  const dateFailureCount = new Map<string, number>(); // total failures per date (any type)
  const REPEATEDLY_FAILING_THRESHOLD = 3;

  // Cross-poll tracker delta: seeded from casCacheJson (read-only snapshot), mutated in-place.
  const trackerDelta = new Map<string, DateFailureEntry>(
    Object.entries(casCacheJson?.dateFailureTracking ?? {}),
  );
  const newlyBlockedFromIncrements = new Set<string>();

  const bumpTracker = (date: string, dimension: FailureDimension): void => {
    // currentConsularDate safety: never increment for the date the bot is already on.
    // See .planning/phases/01-cross-poll-failure-tracker-migration/01-CONTEXT.md §currentConsularDate safety.
    if (date === bot.currentConsularDate) return;
    const prior = trackerDelta.get(date);
    const next = recordFailure(prior, dimension, Date.now());
    trackerDelta.set(date, next);
    logger.info('tracker.increment', {
      botId, date, dimension,
      totalCount: next.totalCount, windowStartedAt: next.windowStartedAt,
    });
    if (next.blockedUntil && !prior?.blockedUntil) {
      newlyBlockedFromIncrements.add(date);
      logger.info('tracker.blocked', {
        botId, date, until: next.blockedUntil,
        breakdown: next.byDimension, totalCount: next.totalCount,
      });
    }
  };
  let securedResult: RescheduleResult | null = null;
  let effectiveCurrentDate = currentConsularDate;
  let prevConsularDate = bot.currentConsularDate;
  let prevConsularTime = bot.currentConsularTime;
  let prevCasDate = bot.currentCasDate;
  let prevCasTime = bot.currentCasTime;

  // Inline re-login between failed attempts using fresh credentials
  const reloginIfPossible = async (): Promise<boolean> => {
    if (!loginCredentials) return false;
    try {
      const { performLogin } = await import('./login.js');
      const result = await performLogin({ ...loginCredentials, botId });
      // ALWAYS call refreshTokens after re-login to prime server-side session state.
      // performLogin's appointment page GET uses redirect: 'follow' which doesn't reliably
      // set the applicant selection state. Without it, POST returns 302 → sign_in.
      logger.info('Mid-reschedule re-login: calling refreshTokens to prime session', { botId, hasTokens: result.hasTokens });
      client.updateSession({ cookie: result.cookie, csrfToken: result.csrfToken || '', authenticityToken: result.authenticityToken || '' });
      try {
        await client.refreshTokens();
        const refreshed = client.getSession();
        result.csrfToken = refreshed.csrfToken;
        result.authenticityToken = refreshed.authenticityToken;
        logger.info('Mid-reschedule re-login: refreshTokens OK', { botId });
      } catch (refreshErr) {
        logger.warn('Mid-reschedule re-login: refreshTokens failed', {
          botId, error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
        });
        if (!result.hasTokens) {
          logger.error('Mid-reschedule re-login: no tokens and refreshTokens failed — POST will likely fail', { botId });
        }
      }
      client.updateSession({ cookie: result.cookie, csrfToken: result.csrfToken, authenticityToken: result.authenticityToken });
      await db.update(sessions).set({
        yatriCookie: encrypt(result.cookie),
        csrfToken: result.csrfToken,
        authenticityToken: result.authenticityToken,
        lastUsedAt: new Date(),
        createdAt: new Date(),
      }).where(eq(sessions.botId, botId));
      logger.info('Mid-reschedule re-login OK', {
        botId,
        hasTokens: result.hasTokens,
        csrfTokenLen: result.csrfToken?.length ?? 0,
        authTokenLen: result.authenticityToken?.length ?? 0,
        authTokenPrefix: result.authenticityToken?.substring(0, 16) ?? '(empty)',
        cookieLen: result.cookie?.length ?? 0,
      });
      return true;
    } catch (e) {
      logger.error('Mid-reschedule re-login FAILED', { botId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  // Track whether the most recent claim actually incremented the counter.
  // Initial bookings (currentConsularDate === null) skip the increment because the portal
  // does NOT count the first appointment booking as a reschedule. Critical for Peru (max=2).
  let lastClaimWasReal = false;

  // Atomic slot claim: UPDATE +1 WHERE rescheduleCount < maxReschedules (or unlimited).
  // Returns false if limit already reached — prevents TOCTOU race between workers.
  const claimSlot = async (): Promise<boolean> => {
    // Initial booking: no slot to claim — portal doesn't count the first booking.
    if (effectiveCurrentDate === null) {
      lastClaimWasReal = false;
      logger.info('claimSlot: skipped (initial booking)', { botId });
      return true;
    }
    // DOS topes, distintos a proposito:
    //   portal_remaining_reschedules  lo dice el portal. Duro. Al agotarlo la cita
    //                                 se BLOQUEA y no hay vuelta atras.
    //   max_reschedules               NUESTRO presupuesto. Puede ser menor.
    // Manda el mas estricto. El del portal lo llena `scripts/sync-portal-limits.ts`.
    // Un solo UPDATE: sube el contador y baja el saldo del portal a la vez. Atomico,
    // y sin viaje extra a la base de datos en el camino critico.
    // NULL en portal_remaining_reschedules significa "el portal no pone tope"
    // (Colombia, Mexico). Tiene que SEGUIR en NULL. La version con
    // COALESCE(saldo, 1) - 1 escribia 0 en el primer cobro y convertia
    // "sin tope" en "agotado" para siempre. Ver bots 298, 300, 301 y 302.
    const rows = await db.update(bots)
      .set({
        rescheduleCount: sql`${bots.rescheduleCount} + 1`,
        portalRemainingReschedules: sql`CASE WHEN ${bots.portalRemainingReschedules} IS NULL THEN NULL
                                             ELSE GREATEST(0, ${bots.portalRemainingReschedules} - 1) END`,
      })
      .where(and(
        eq(bots.id, botId),
        or(isNull(bots.maxReschedules), lt(bots.rescheduleCount, bots.maxReschedules)),
        or(isNull(bots.portalRemainingReschedules), gt(bots.portalRemainingReschedules, 0)),
      ))
      .returning({ rescheduleCount: bots.rescheduleCount });
    // Solo se bloquea cuando existe un tope de verdad. Sin topes, un UPDATE que no
    // devuelve filas se ignora, igual que antes de este cambio.
    const hayTope = maxReschedules != null || portalRemaining != null;
    if (hayTope && rows.length === 0) {
      const porElPortal = portalRemaining != null && portalRemaining <= 0;
      logger.warn('claimSlot: limit reached (atomic)', {
        botId,
        capBy: porElPortal ? 'portal' : 'nuestro presupuesto',
        maxReschedules,
        portalRemaining,
      });
      return false;
    }
    lastClaimWasReal = true;
    return true;
  };

  // Release a previously claimed slot on POST failure. Uses GREATEST to prevent underflow.
  // Skip when the corresponding claim was a no-op (initial booking).
  const releaseSlot = async (reason: string): Promise<void> => {
    if (!lastClaimWasReal) {
      logger.info('releaseSlot: skipped (initial booking)', { botId, reason });
      return;
    }
    // Devolver el cupo tiene que ser simetrico con claimSlot. Antes solo bajaba
    // rescheduleCount, entonces un intento fallido quemaba el saldo del portal
    // para siempre. El tope del portal nunca puede subir por encima de
    // portal_max_reschedules, y un saldo en NULL se queda en NULL.
    await db.update(bots)
      .set({
        rescheduleCount: sql`GREATEST(${bots.rescheduleCount} - 1, 0)`,
        portalRemainingReschedules: sql`CASE
          WHEN ${bots.portalRemainingReschedules} IS NULL THEN NULL
          WHEN ${bots.portalMaxReschedules} IS NOT NULL
            THEN LEAST(${bots.portalMaxReschedules}, ${bots.portalRemainingReschedules} + 1)
          ELSE ${bots.portalRemainingReschedules} + 1 END`,
      })
      .where(eq(bots.id, botId));
    lastClaimWasReal = false;
    logger.info('releaseSlot', { botId, reason });
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Attempt 1: use preFetchedDays if available (skip re-fetch, save ~1s)
    // Attempts 2+: always fetch fresh
    let consularDays: DaySlot[];
    if (attempt === 1 && preFetchedDays) {
      consularDays = preFetchedDays;
      logger.info(`Using pre-fetched days (attempt ${attempt}/${maxAttempts})`, { botId, count: consularDays.length });
    } else {
      logger.info(`Fetching consular days (attempt ${attempt}/${maxAttempts})`, { botId });
      try {
        consularDays = await client.getConsularDays();
      } catch (fetchErr) {
        // If we already secured a slot, don't lose it — break out of the improve loop
        // so the caller still gets the success (and the post-success path runs:
        // bookable_events insert, success notification, final verification).
        if (securedResult) {
          logger.warn('Improvement loop fetch failed but securedResult exists — returning secured', {
            botId, attempt, error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
          });
          break;
        }
        throw fetchErr;
      }
    }

    const filteredDays = filterDates(consularDays, dateExclusions, bot.targetDateBefore, minDate, bot.targetDateAfter, bot.excludedWeekdays);
    const candidates = filteredDays
      // SNIPER (before securing): accept any in-window date even if not earlier than current —
      // filteredDays is already bounded to [targetDateAfter, targetDateBefore). After securing,
      // require strictly earlier than the secured date so the improve loop only goes earlier.
      .filter((d) => (sniperFreeMove && !securedResult) ? true : (effectiveCurrentDate ? isAtLeastNDaysEarlier(d.date, effectiveCurrentDate, 1) : true))
      .filter((d) => !exhaustedDates.has(d.date))
      .filter((d) => (transientFailCount.get(d.date) ?? 0) < 2);

    logger.info('Candidates', {
      botId,
      attempt,
      total: consularDays.length,
      afterFilter: filteredDays.length,
      afterTried: candidates.length,
      first: candidates[0]?.date,
      exhausted: [...exhaustedDates],
      transient: Object.fromEntries(transientFailCount),
      current: effectiveCurrentDate,
      secured: securedResult?.date ?? null,
    });

    if (candidates.length === 0) {
      logger.info('No candidate dates remaining', { botId, attempt });
      break;
    }

    // Selection strategy:
    // - After securing: aggressive — pick best (idx 0). Safety net = securedResult.
    // - Attempt 1 (no success yet): cluster dodge — if #1 and #2 are close (≤3d gap),
    //   pick #3 (or #2 if #3 is >30d away). Avoids competing with every bot for #1.
    // - Other attempts (no success yet): pick best available (idx 0).
    const best = candidates[0]!;
    let candidateIdx = 0;
    let selectionStrategy = securedResult ? 'aggressive_upgrade' : 'best_available';

    if (!securedResult && attempt === 1 && candidates.length >= 2) {
      const bestMs = new Date(best.date).getTime();
      const gap12 = (new Date(candidates[1]!.date).getTime() - bestMs) / 864e5;
      if (gap12 <= 3) {
        if (candidates.length >= 3) {
          const gap13 = (new Date(candidates[2]!.date).getTime() - bestMs) / 864e5;
          candidateIdx = gap13 <= 30 ? 2 : 1;
        } else {
          candidateIdx = 1;
        }
        selectionStrategy = 'cluster_dodge';
      }
    }

    const candidate = candidates[candidateIdx]!;
    logger.info('Selection', {
      botId, attempt, strategy: selectionStrategy,
      picked: candidate.date, idx: candidateIdx, totalCandidates: candidates.length,
      best: best.date, secured: securedResult?.date ?? null,
    });
    const attemptStart = Date.now();
    let currentStep: RescheduleAttempt['failStep'] = 'get_consular_times';

    try {
      const consularTimesData = await client.getConsularTimes(candidate.date);
      // El refresco de tokens salio en paralelo con esta peticion. Aqui se cobra el
      // maximo de las dos, no la suma, y se aplica el override de `needsCas`.
      await esperarTokens();
      // Lo que ofrecio el portal, crudo. Se mide ANTES de filtrar y antes del
      // fallback especulativo, porque `timesSeen` tiene que responder "habia cupo
      // de verdad", no "que nos quedo despues de nuestros filtros".
      const portalTimes = consularTimesData.available_times?.filter((t): t is string => !!t) ?? [];
      const timesSeen = portalTimes.length;
      const consularTimes = filterTimes(candidate.date, portalTimes, timeExclusions)
        .reverse(); // Try later times first — less competed than early morning slots
      logger.info('Consular times (reversed)', { botId, date: candidate.date, available: consularTimesData.available_times, afterFilter: consularTimes });
      let isSpeculative = false;
      if (consularTimes.length === 0 && !needsCas && bot.speculativeTimeFallback) {
        // Las horas del bot mandan sobre la constante global: dependen del schedule.
        const tiempos = bot.speculativeTimes?.length ? bot.speculativeTimes : SPECULATIVE_TIMES;
        consularTimes.push(...tiempos);
        isSpeculative = true;
        logger.warn('No consular times -- using speculative fallback', {
          botId, date: candidate.date, speculativeTimes: tiempos,
          origen: bot.speculativeTimes?.length ? 'bot' : 'constante_global',
        });
      }
      if (consularTimes.length === 0) {
        logger.warn('No consular times, re-fetching days', { botId });
        failedAttempts.push({ date: candidate.date, failReason: 'no_times', failStep: 'get_consular_times', timesFound: portalTimes, timesSeen, durationMs: Date.now() - attemptStart });
        dateFailureCount.set(candidate.date, (dateFailureCount.get(candidate.date) ?? 0) + 1);
        bumpTracker(candidate.date, 'consularNoTimes');
        exhaustedDates.add(candidate.date);
        continue;
      }

      // ── No-CAS path (e.g. Peru): skip CAS, POST with consular only ──
      if (!needsCas) {
        // Claim slot ONCE before trying any consular time for this date.
        // This prevents concurrent workers from each claiming separate slots simultaneously.
        const claimed = await claimSlot();
        if (!claimed) {
          const rfDatesEarly = [...dateFailureCount.entries()].filter(([d, c]) => c >= REPEATEDLY_FAILING_THRESHOLD && !falsePositiveDates.has(d)).map(([d]) => d);
          const nbdEarly = [...trackerDelta.entries()].filter(([d, e]) => e.blockedUntil && !falsePositiveDates.has(d)).map(([d]) => d);
          const tdEarly = trackerDelta.size > 0 ? Object.fromEntries(trackerDelta) : undefined;
          if (securedResult) return { ...securedResult, totalDurationMs: Date.now() - totalStart, attempts: failedAttempts, falsePositiveDates: falsePositiveDates.size > 0 ? [...falsePositiveDates] : undefined, repeatedlyFailingDates: rfDatesEarly.length > 0 ? rfDatesEarly : undefined, dateFailureTrackingDelta: tdEarly, newlyBlockedDates: nbdEarly.length > 0 ? nbdEarly : undefined };
          return { success: false, reason: 'max_reschedules_reached', totalDurationMs: Date.now() - totalStart, attempts: failedAttempts, falsePositiveDates: falsePositiveDates.size > 0 ? [...falsePositiveDates] : undefined, repeatedlyFailingDates: rfDatesEarly.length > 0 ? rfDatesEarly : undefined, dateFailureTrackingDelta: tdEarly, newlyBlockedDates: nbdEarly.length > 0 ? nbdEarly : undefined };
        }
        let postAttempted = false;
        for (const consularTime of consularTimes) {
          currentStep = 'post_reschedule';
          logger.info('POSTING reschedule (no CAS)', {
            botId,
            consular: `${candidate.date} ${consularTime}`,
            speculative: isSpeculative,
          });

          const postStart = Date.now();
          const msToPost = postStart - attemptStart;
          let postSuccess = await client.reschedule(candidate.date, consularTime);
          postAttempted = true;

          // Initial-booking safety net: the success redirect for a FIRST booking can differ
          // from /instructions (used for reschedules). If redirect chain says false but the
          // appointment actually exists, treat as success to avoid retrying a completed booking.
          if (!postSuccess && effectiveCurrentDate === null) {
            try {
              const verifyAppt = await client.getCurrentAppointment();
              if (verifyAppt && verifyAppt.consularDate === candidate.date) {
                logger.info('Initial booking: redirect chain returned false but appointment created — overriding to success', {
                  botId, candidate: candidate.date, verifyAppt,
                });
                postSuccess = true;
              }
            } catch (e) {
              logger.warn('Initial booking safety net: getCurrentAppointment failed', { botId, error: e instanceof Error ? e.message : String(e) });
            }
          }

          if (!postSuccess) {
            logger.warn('Reschedule POST returned false', { botId, date: candidate.date, consularTime });
            const fa: RescheduleAttempt = { date: candidate.date, consularTime, failReason: 'post_failed', failStep: 'post_reschedule', timesFound: consularTimes, msToPost, timesSeen, durationMs: Date.now() - attemptStart };
            pending.push(
              db.insert(rescheduleLogs).values({
                botId,
                oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
                oldCasDate: prevCasDate, oldCasTime: prevCasTime,
                newConsularDate: candidate.date, newConsularTime: consularTime,
                success: false, error: isSpeculative ? 'post_returned_false (speculative)' : 'post_returned_false',
                ...diag(fa),
              }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
            );
            failedAttempts.push(fa);
            continue; // slot still claimed, try next consular time
          }

          // POST redirect chain indicated success — verify synchronously before committing
          // This prevents false positives (slot taken by another user, redirect still goes to /instructions)
          let verified = true;
          try {
            const verifyAppt = await leerCitaVerificada(client);
            if (verifyAppt.consularDate !== candidate.date) {
              logger.error('FALSE POSITIVE (no CAS): POST succeeded but appointment unchanged', {
                botId, expected: candidate.date, actual: verifyAppt.consularDate,
                consularTime, prevDate: prevConsularDate,
              });
              verified = false;
              const fa: RescheduleAttempt = { date: candidate.date, consularTime, failReason: 'verification_failed', failStep: 'post_reschedule', timesFound: consularTimes, msToPost, timesSeen, durationMs: Date.now() - attemptStart };
              pending.push(
                db.insert(rescheduleLogs).values({
                  botId,
                  oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
                  oldCasDate: prevCasDate, oldCasTime: prevCasTime,
                  newConsularDate: candidate.date, newConsularTime: consularTime,
                  success: false, error: isSpeculative ? 'false_positive_verification (speculative)' : 'false_positive_verification',
                  ...diag(fa),
                }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
              );
              failedAttempts.push(fa);
              dateFailureCount.set(candidate.date, (dateFailureCount.get(candidate.date) ?? 0) + 1);
              exhaustedDates.add(candidate.date);
              falsePositiveDates.add(candidate.date);
            }
          } catch (verifyErr) {
            const verifyErrMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
            if (isSpeculative) {
              // Speculative time: cannot verify AND we guessed the slot — high false-positive risk.
              // Release the slot rather than wasting a limited reschedule count.
              logger.error('Post-reschedule verification failed (no CAS, speculative) — releasing slot', {
                botId, date: candidate.date, consularTime, error: verifyErrMsg,
              });
              verified = false;
              await releaseSlot('verification_network_error_speculative');
              const fa: RescheduleAttempt = { date: candidate.date, consularTime, failReason: 'verification_failed', failStep: 'post_reschedule', timesFound: consularTimes, msToPost, timesSeen, durationMs: Date.now() - attemptStart };
              pending.push(
                db.insert(rescheduleLogs).values({
                  botId,
                  oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
                  oldCasDate: prevCasDate, oldCasTime: prevCasTime,
                  newConsularDate: candidate.date, newConsularTime: consularTime,
                  success: false, error: 'verification_network_error (speculative)',
                  ...diag(fa),
                }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
              );
              failedAttempts.push(fa);
              exhaustedDates.add(candidate.date);
            } else {
              // Hora real de `times.json`: dar por bueno el POST sigue siendo mas seguro
              // que perder un reagendamiento confirmado. Lo que cambia es que el exito
              // queda MARCADO como no verificado, entonces
              // `scripts/audit-reschedule-attribution.ts` lo puede separar en vez de
              // contarlo como un movimiento probado del bot.
              logger.warn('Post-reschedule verification failed (no CAS), assuming success', {
                botId, date: candidate.date, consularTime, error: verifyErrMsg,
              });
              sinVerificar = verifyErrMsg;
            }
          }

          if (!verified) {
            continue; // Try next time/date (slot still claimed for this date)
          }

          const isInitialBooking = prevConsularDate === null;
          const strategyNote = `[${selectionStrategy}] attempt ${attempt}, #${candidateIdx + 1}/${candidates.length}${isSpeculative ? ' (speculative)' : ''}${isInitialBooking ? ' [INITIAL_BOOKING]' : ''}${sinVerificar ? ` [NO VERIFICADO: ${sinVerificar}]` : ''}`;
          pending.push(
            db.insert(rescheduleLogs).values({
              botId,
              oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
              oldCasDate: prevCasDate, oldCasTime: prevCasTime,
              newConsularDate: candidate.date, newConsularTime: consularTime,
              success: true, error: strategyNote,
              ...diag(undefined, { msToPost, timesSeen }),
            }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
          );

          await db.update(bots).set({
            currentConsularDate: candidate.date,
            currentConsularTime: consularTime,
            updatedAt: new Date(),
          }).where(eq(bots.id, botId));
          successfulPosts++;

          const updatedSession = client.getSession();
          pending.push(
            db.update(sessions).set({
              yatriCookie: encrypt(updatedSession.cookie),
              csrfToken: updatedSession.csrfToken,
              authenticityToken: updatedSession.authenticityToken,
              lastUsedAt: new Date(),
            }).where(eq(sessions.botId, botId))
              .catch((e) => logger.error('session persist failed', { error: String(e) })),
          );

          securedResult = {
            success: true,
            date: candidate.date,
            consularTime,
            totalDurationMs: Date.now() - totalStart,
          };
          effectiveCurrentDate = candidate.date;
          prevConsularDate = candidate.date;
          prevConsularTime = consularTime;

          // Clear tracker entry for booked date.
          if (trackerDelta.has(candidate.date)) {
            trackerDelta.delete(candidate.date);
            logger.info('tracker.cleared', { botId, date: candidate.date, reason: 'success' });
          }

          logger.info('reschedule SUCCESS (no CAS), will try to improve', {
            botId, secured: `${candidate.date} ${consularTime}`, totalDurationMs: Date.now() - totalStart,
          });

          break;
        }

        // Release slot if no consular time succeeded for this date
        if (securedResult?.date !== candidate.date) {
          await releaseSlot('all_times_failed_for_date');
        }
        if (securedResult?.date === candidate.date) continue;
        exhaustedDates.add(candidate.date);
        if (!postAttempted) {
          logger.warn('All consular times failed for date', { botId, date: candidate.date, timesTried: consularTimes.length });
        } else {
          logger.warn('All POST attempts failed for date', { botId, date: candidate.date, timesTried: consularTimes.length });
        }
        continue; // next attempt in outer loop
      }

      // ── CAS path (e.g. Colombia): fetch CAS days/times before POST ──

      // CAS days: use cache if fresh, with temporal filter (CAS must be 1-8 days before consular)
      let casResults: { time: string; casDays: DaySlot[] }[];
      const CAS_WINDOW_DAYS = bot.maxCasGapDays ?? 8;
      const consularMs = new Date(candidate.date).getTime();
      // Only use cache entries that were fetched for THIS consular date (or legacy entries without context)
      const cachedCasDays = [...casCache.values()]
        .filter(e => {
          if (e.slots <= 0) return false;
          if (e.forConsularDate && e.forConsularDate !== candidate.date) return false;
          if (isDateExcluded(e.date, dateExclusions)) return false;
          if (e.date < minDate) return false;
          if (!casDateWithinBounds(e.date)) return false;
          const daysBefore = (consularMs - new Date(e.date).getTime()) / 864e5;
          return daysBefore >= 1 && daysBefore <= CAS_WINDOW_DAYS;
        })
        .sort((a, b) => (consularMs - new Date(a.date).getTime()) - (consularMs - new Date(b.date).getTime()))
        .map(e => ({ date: e.date, business_day: true as const }));
      const usedCache = cachedCasDays.length > 0;
      if (usedCache) {
        casResults = consularTimes.map(time => ({ time, casDays: cachedCasDays }));
        logger.info('CAS days FROM CACHE (filtered)', { botId, cachedDates: cachedCasDays.length, timesCount: consularTimes.length, window: CAS_WINDOW_DAYS });
      } else {
        currentStep = 'parallel_cas_days';
        logger.info('Fetching CAS days in parallel', { botId, date: candidate.date, timesCount: consularTimes.length });
        const casParallelStart = Date.now();
        try {
          casResults = await Promise.all(
            consularTimes.map(async (time) => ({
              time,
              casDays: await client.getCasDays(candidate.date, time),
            })),
          );
          // Apply same gap filter as cache path — API returns all CAS days, not just nearby ones
          casResults = casResults.map(({ time, casDays }) => ({
            time,
            casDays: casDays.filter(d => {
              const daysBefore = (consularMs - new Date(d.date).getTime()) / 864e5;
              return daysBefore >= 1 && daysBefore <= CAS_WINDOW_DAYS;
            }),
          }));
          logger.info('Parallel CAS days done', { botId, parallelMs: Date.now() - casParallelStart, timesCount: consularTimes.length, filteredByGap: CAS_WINDOW_DAYS });
        } catch (casFetchErr) {
          // TCP block / network error on CAS days fetch — fall back to stale cache if available
          const errMsg = casFetchErr instanceof Error ? casFetchErr.message : String(casFetchErr);
          const staleFallback = [...staleCasCache.values()]
            .filter(e => {
              if (e.slots <= 0) return false;
              if (e.forConsularDate && e.forConsularDate !== candidate.date) return false;
              if (isDateExcluded(e.date, dateExclusions)) return false;
              if (e.date < minDate) return false;
              if (!casDateWithinBounds(e.date)) return false;
              const daysBefore = (consularMs - new Date(e.date).getTime()) / 864e5;
              return daysBefore >= 1 && daysBefore <= CAS_WINDOW_DAYS;
            })
            .sort((a, b) => (consularMs - new Date(a.date).getTime()) - (consularMs - new Date(b.date).getTime()))
            .map(e => ({ date: e.date, business_day: true as const }));
          if (staleFallback.length > 0) {
            casResults = consularTimes.map(time => ({ time, casDays: staleFallback }));
            logger.warn('Parallel CAS days FAILED — using STALE cache as fallback', {
              botId, error: errMsg, staleCacheAgeMin: Math.round(casCacheAgeMin),
              fallbackDates: staleFallback.length, timesCount: consularTimes.length,
            });
          } else {
            throw casFetchErr; // No fallback available — propagate to outer catch
          }
        }
      }

      // Claim slot ONCE before trying any consular time for this date.
      // This prevents concurrent workers from each claiming separate slots simultaneously.
      const claimed = await claimSlot();
      if (!claimed) {
        const rfDatesEarly = [...dateFailureCount.entries()].filter(([d, c]) => c >= REPEATEDLY_FAILING_THRESHOLD && !falsePositiveDates.has(d)).map(([d]) => d);
        const nbdEarly = [...trackerDelta.entries()].filter(([d, e]) => e.blockedUntil && !falsePositiveDates.has(d)).map(([d]) => d);
        const tdEarly = trackerDelta.size > 0 ? Object.fromEntries(trackerDelta) : undefined;
        if (securedResult) return { ...securedResult, totalDurationMs: Date.now() - totalStart, attempts: failedAttempts, falsePositiveDates: falsePositiveDates.size > 0 ? [...falsePositiveDates] : undefined, repeatedlyFailingDates: rfDatesEarly.length > 0 ? rfDatesEarly : undefined, dateFailureTrackingDelta: tdEarly, newlyBlockedDates: nbdEarly.length > 0 ? nbdEarly : undefined };
        return { success: false, reason: 'max_reschedules_reached', totalDurationMs: Date.now() - totalStart, attempts: failedAttempts, falsePositiveDates: falsePositiveDates.size > 0 ? [...falsePositiveDates] : undefined, repeatedlyFailingDates: rfDatesEarly.length > 0 ? rfDatesEarly : undefined, dateFailureTrackingDelta: tdEarly, newlyBlockedDates: nbdEarly.length > 0 ? nbdEarly : undefined };
      }

      // Process results sequentially (best time first)
      let postAttempted = false;
      for (const { time: consularTime, casDays } of casResults) {
        // The CAS date obeys the SAME bounds as the consular date (exclusions, minDate and the
        // [targetDateAfter, targetDateBefore) window). If no CAS day fits inside the bounds, this
        // consular time fails with 'no_cas_days' and the loop moves on — the bot never books a
        // CAS outside the owner's limits just to reach an in-bounds consular date.
        const filteredCasDays = filterDates(casDays, dateExclusions, bot.targetDateBefore, minDate, bot.targetDateAfter, bot.excludedWeekdays);
        logger.info('CAS days', { botId, consularTime, total: casDays.length, afterFilter: filteredCasDays.length, first: filteredCasDays[0]?.date });
        if (filteredCasDays.length === 0) {
          // `failStep` y `timesSeen` van aqui igual que en las otras ramas. Sin ellos
          // esta rama quedaba fuera de toda consulta de diagnostico, y es la que MAS
          // falla en la flota: al 2026-08-31 `no_cas_days` es el 84% de las perdidas.
          // `timesSeen` responde "cuantas horas consulares habia cuando el CAS fallo",
          // que separa "la fecha era fantasma" de "el muro es el CAS, no el consular".
          failedAttempts.push({
            date: candidate.date, consularTime, failReason: 'no_cas_days',
            failStep: 'parallel_cas_days', timesSeen, durationMs: Date.now() - attemptStart,
          });
          dateFailureCount.set(candidate.date, (dateFailureCount.get(candidate.date) ?? 0) + 1);
          bumpTracker(candidate.date, 'casNoDays');
          continue;
        }
        const casDate = filteredCasDays[0]!.date;

        // Check CAS cache before fetching
        const cached = casCacheLookup(casCache, casDate, candidate.date);
        let casTimes: string[];
        if (cached) {
          if (cached.slots === 0) {
            logger.info('CAS times SKIP (cache: FULL)', { botId, casDate, consularTime });
            failedAttempts.push({ date: candidate.date, consularTime, casDate, failReason: 'no_cas_times_cached', durationMs: Date.now() - attemptStart });
            continue;
          }
          casTimes = filterTimes(casDate, cached.times?.filter((t): t is string => !!t) ?? [], timeExclusions);
          logger.info('CAS times FROM CACHE', { botId, casDate, slots: cached.slots, afterFilter: casTimes.length });
        } else {
          currentStep = 'get_cas_times';
          const casTimesData = await client.getCasTimes(casDate, candidate.date, consularTime);
          casTimes = filterTimes(casDate, casTimesData.available_times?.filter((t): t is string => !!t) ?? [], timeExclusions);
          logger.info('CAS times', { botId, casDate, forConsular: `${candidate.date}@${consularTime}`, available: casTimesData.available_times?.length ?? 0, afterFilter: casTimes.length });
        }
        if (casTimes.length === 0) {
          failedAttempts.push({ date: candidate.date, consularTime, casDate, failReason: 'no_cas_times', durationMs: Date.now() - attemptStart });
          dateFailureCount.set(candidate.date, (dateFailureCount.get(candidate.date) ?? 0) + 1);
          bumpTracker(candidate.date, 'casNoTimes');
          continue;
        }
        const casTime = casTimes[0]!;

        currentStep = 'post_reschedule';
        logger.info('POSTING reschedule', {
          botId,
          consular: `${candidate.date} ${consularTime}`,
          cas: `${casDate} ${casTime}`,
        });

        const postStart = Date.now();
        const msToPost = postStart - attemptStart;
        let postSuccess = await client.reschedule(candidate.date, consularTime, casDate, casTime);
        postAttempted = true;

        // Initial-booking safety net (CAS path): see no-CAS path for rationale.
        if (!postSuccess && effectiveCurrentDate === null) {
          try {
            const verifyAppt = await client.getCurrentAppointment();
            if (verifyAppt && verifyAppt.consularDate === candidate.date) {
              logger.info('Initial booking (CAS): redirect chain returned false but appointment created — overriding to success', {
                botId, candidate: candidate.date, verifyAppt,
              });
              postSuccess = true;
            }
          } catch (e) {
            logger.warn('Initial booking safety net (CAS): getCurrentAppointment failed', { botId, error: e instanceof Error ? e.message : String(e) });
          }
        }

        if (!postSuccess) {
          logger.warn('Reschedule POST returned false', { botId, date: candidate.date, consularTime });
          const fa: RescheduleAttempt = { date: candidate.date, consularTime, casDate, casTime, failReason: 'post_failed', failStep: 'post_reschedule', timesFound: consularTimes, msToPost, timesSeen, durationMs: Date.now() - attemptStart };
          pending.push(
            db.insert(rescheduleLogs).values({
              botId,
              oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
              oldCasDate: prevCasDate, oldCasTime: prevCasTime,
              newConsularDate: candidate.date, newConsularTime: consularTime,
              newCasDate: casDate, newCasTime: casTime,
              success: false, error: 'post_returned_false',
              ...diag(fa),
            }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
          );
          failedAttempts.push(fa);
          continue; // slot still claimed, try next consular time
        }

        // POST redirect chain indicated success — verify synchronously before committing
        let verified = true;
        try {
          const verifyAppt = await leerCitaVerificada(client);
          if (verifyAppt.consularDate !== candidate.date) {
            logger.error('FALSE POSITIVE (CAS): POST succeeded but appointment unchanged', {
              botId, expected: candidate.date, actual: verifyAppt.consularDate,
              consularTime, casDate, casTime, prevDate: prevConsularDate,
            });
            verified = false;
            const fa: RescheduleAttempt = { date: candidate.date, consularTime, casDate, casTime, failReason: 'verification_failed', failStep: 'post_reschedule', timesFound: consularTimes, msToPost, timesSeen, durationMs: Date.now() - attemptStart };
            pending.push(
              db.insert(rescheduleLogs).values({
                botId,
                oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
                oldCasDate: prevCasDate, oldCasTime: prevCasTime,
                newConsularDate: candidate.date, newConsularTime: consularTime,
                newCasDate: casDate, newCasTime: casTime,
                success: false, error: 'false_positive_verification',
                ...diag(fa),
              }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
            );
            failedAttempts.push(fa);
            dateFailureCount.set(candidate.date, (dateFailureCount.get(candidate.date) ?? 0) + 1);
            exhaustedDates.add(candidate.date);
            falsePositiveDates.add(candidate.date);
          }
        } catch (verifyErr) {
          // Ver la nota de la rama sin CAS: se da por bueno y queda MARCADO como no
          // verificado, para que la auditoria de atribucion lo pueda separar.
          const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
          logger.warn('Post-reschedule verification failed (CAS), assuming success', {
            botId, date: candidate.date, consularTime, casDate, casTime, error: msg,
          });
          sinVerificar = msg;
        }

        if (!verified) {
          break; // Break inner loop (slot release handled after the loop)
        }

        const isInitialBooking = prevConsularDate === null;
        const strategyNote = `[${selectionStrategy}] attempt ${attempt}, #${candidateIdx + 1}/${candidates.length}${isInitialBooking ? ' [INITIAL_BOOKING]' : ''}${sinVerificar ? ` [NO VERIFICADO: ${sinVerificar}]` : ''}`;
        pending.push(
          db.insert(rescheduleLogs).values({
            botId,
            oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
            oldCasDate: prevCasDate, oldCasTime: prevCasTime,
            newConsularDate: candidate.date, newConsularTime: consularTime,
            newCasDate: casDate, newCasTime: casTime,
            success: true,
            error: strategyNote,
            ...diag(undefined, { msToPost, timesSeen }),
          }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
        );

        // Update DB immediately (verified success)
        await db
          .update(bots)
          .set({
            currentConsularDate: candidate.date,
            currentConsularTime: consularTime,
            currentCasDate: casDate,
            currentCasTime: casTime,
            updatedAt: new Date(),
          })
          .where(eq(bots.id, botId));
        successfulPosts++;

        const updatedSession = client.getSession();
        pending.push(
          db.update(sessions)
            .set({
              yatriCookie: encrypt(updatedSession.cookie),
              csrfToken: updatedSession.csrfToken,
              authenticityToken: updatedSession.authenticityToken,
              lastUsedAt: new Date(),
            })
            .where(eq(sessions.botId, botId))
            .catch((e) => logger.error('session persist failed', { error: String(e) })),
        );

        // Track secured result and continue trying for better dates
        securedResult = {
          success: true,
          date: candidate.date,
          consularTime,
          casDate,
          casTime,
          totalDurationMs: Date.now() - totalStart,
        };
        effectiveCurrentDate = candidate.date;
        prevConsularDate = candidate.date;
        prevConsularTime = consularTime;
        prevCasDate = casDate;
        prevCasTime = casTime;

        // Clear tracker entry for booked date — successful booking means this date is no longer failing.
        if (trackerDelta.has(candidate.date)) {
          trackerDelta.delete(candidate.date);
          logger.info('tracker.cleared', { botId, date: candidate.date, reason: 'success' });
        }

        logger.info('reschedule SUCCESS, will try to improve', {
          botId,
          secured: `${candidate.date} ${consularTime}`,
          totalDurationMs: Date.now() - totalStart,
        });

        break; // break inner loop (consular times), outer loop will try better date
      }

      // Release slot if no consular time succeeded for this date
      if (securedResult?.date !== candidate.date) {
        await releaseSlot('all_times_failed_for_date');
      }

      // If this date was secured, skip exhaustion logic — outer loop will try better dates
      if (securedResult?.date === candidate.date) continue;

      // All consular times exhausted for this date
      if (usedCache) {
        // Cache CAS may have been stale/wrong — clear cache and allow retry with fresh API
        casCache.clear();
        staleCasCache.clear();
        transientFailCount.set(candidate.date, (transientFailCount.get(candidate.date) ?? 0) + 1);
        logger.warn('Cache CAS exhausted, cleared for API retry', { botId, date: candidate.date, postAttempted });
      } else {
        // Fresh API data failed — this date is truly exhausted
        exhaustedDates.add(candidate.date);
        if (!postAttempted) {
          logger.warn('All consular times failed for date (no CAS)', { botId, date: candidate.date, timesTried: consularTimes.length });
        } else {
          logger.warn('All POST attempts failed for date', { botId, date: candidate.date, timesTried: consularTimes.length });
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorCause = error instanceof Error && error.cause
        ? (error.cause instanceof Error ? error.cause.message : String(error.cause))
        : undefined;

      // SAFETY NET: If error happened during/after POST, the appointment may have
      // actually changed server-side even though we didn't complete our success path.
      // This is CRITICAL for embassies with reschedule limits (e.g. Peru: max 2).
      // Verify by checking the actual appointment, and if it changed, increment the counter.
      if (currentStep === 'post_reschedule') {
        try {
          // If session expired during redirect, re-login before verifying
          if (error instanceof SessionExpiredError) {
            await reloginIfPossible();
          }
          const verifyAppt = await client.getCurrentAppointment();
          if (verifyAppt && verifyAppt.consularDate !== prevConsularDate) {
            // Always sync DB to actual server state
            await db.update(bots).set({
              currentConsularDate: verifyAppt.consularDate,
              currentConsularTime: verifyAppt.consularTime,
              currentCasDate: verifyAppt.casDate,
              currentCasTime: verifyAppt.casTime,
              updatedAt: new Date(),
            }).where(eq(bots.id, botId));

            // ATTRIBUTION GUARD: the POST body names one exact date (candidate.date).
            // If the server landed on any OTHER date, our POST did not produce it — the
            // owner rescheduled by hand, or another tool did. Crediting it to the bot
            // inflates the "days advanced" billing. Sync state, log it as an external
            // change, and never notify it as a bot success.
            if (verifyAppt.consularDate !== candidate.date) {
              logger.error('POST error + appointment changed to a date the bot never targeted — EXTERNAL change, not attributed', {
                botId, target: candidate.date, actual: verifyAppt.consularDate,
                prevDate: prevConsularDate, error: errorMsg,
              });
              pending.push(
                db.insert(rescheduleLogs).values({
                  botId,
                  oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
                  oldCasDate: prevCasDate, oldCasTime: prevCasTime,
                  newConsularDate: verifyAppt.consularDate, newConsularTime: verifyAppt.consularTime,
                  newCasDate: verifyAppt.casDate, newCasTime: verifyAppt.casTime,
                  success: false,
                  error: `[external_change] target=${candidate.date} actual=${verifyAppt.consularDate}`,
                  ...diag({ failReason: 'post_error', failStep: 'post_reschedule', durationMs: Date.now() - attemptStart, error: errorMsg }),
                }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
              );
              // Our POST did not land — give the reschedule allowance back.
              await releaseSlot('post_error_external_change');
              effectiveCurrentDate = verifyAppt.consularDate;
              prevConsularDate = verifyAppt.consularDate;
              prevConsularTime = verifyAppt.consularTime;
              prevCasDate = verifyAppt.casDate;
              prevCasTime = verifyAppt.casTime;
              exhaustedDates.add(candidate.date);
              continue;
            }

            const isImprovement = verifyAppt.consularDate && prevConsularDate
              ? (sniperFreeMove
                  // SNIPER (appointment still outside the window): a verified in-window date counts
                  // as success unless we'd already secured an earlier one (then it must be strictly
                  // earlier to not regress). Once the appointment is in-window, sniperFreeMove is
                  // false and the strictly-earlier rule applies.
                  ? (inSniperWindow(verifyAppt.consularDate) && (!securedResult || isAtLeastNDaysEarlier(verifyAppt.consularDate, prevConsularDate, 1)))
                  : isAtLeastNDaysEarlier(verifyAppt.consularDate, prevConsularDate, 1))
              : false;

            if (isImprovement) {
              // Slot was already claimed via claimSlot() — do NOT re-increment.
              // Just update the date fields to reflect the actual appointment.
              logger.warn('POST error but appointment CHANGED (improvement) — slot already claimed, updating dates only', {
                botId, expected: candidate.date, actual: verifyAppt.consularDate,
                prevDate: prevConsularDate, error: errorMsg,
              });
              pending.push(
                db.insert(rescheduleLogs).values({
                  botId,
                  oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
                  oldCasDate: prevCasDate, oldCasTime: prevCasTime,
                  newConsularDate: verifyAppt.consularDate, newConsularTime: verifyAppt.consularTime,
                  newCasDate: verifyAppt.casDate, newCasTime: verifyAppt.casTime,
                  success: true, error: `[post_error_recovered] ${errorMsg}`,
                  ...diag({ failReason: 'post_error', failStep: 'post_reschedule', durationMs: Date.now() - attemptStart, error: errorMsg }),
                }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
              );
              pending.push(
                notifyUserTask.trigger({
                  botId, event: 'reschedule_success',
                  data: {
                    oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
                    newConsularDate: verifyAppt.consularDate, newConsularTime: verifyAppt.consularTime,
                    newCasDate: verifyAppt.casDate, newCasTime: verifyAppt.casTime,
                    recoveredFromError: true,
                  },
                }).catch((e) => logger.error('notify trigger failed', { error: String(e) })),
              );
              securedResult = {
                success: true,
                date: verifyAppt.consularDate!,
                consularTime: verifyAppt.consularTime ?? undefined,
                casDate: verifyAppt.casDate ?? undefined,
                casTime: verifyAppt.casTime ?? undefined,
                totalDurationMs: Date.now() - totalStart,
              };
              effectiveCurrentDate = verifyAppt.consularDate;
              prevConsularDate = verifyAppt.consularDate;
              prevConsularTime = verifyAppt.consularTime;
              prevCasDate = verifyAppt.casDate;
              prevCasTime = verifyAppt.casTime;
              // Don't throw/break — continue improving if possible
              continue;
            } else {
              // Portal reverted to a same/later date — do NOT notify as success
              logger.error('POST error + portal REVERTED appointment (regression) — discarding securedResult', {
                botId, expected: candidate.date, actual: verifyAppt.consularDate,
                prevDate: prevConsularDate, error: errorMsg,
              });
              pending.push(
                db.insert(rescheduleLogs).values({
                  botId,
                  oldConsularDate: prevConsularDate, oldConsularTime: prevConsularTime,
                  oldCasDate: prevCasDate, oldCasTime: prevCasTime,
                  newConsularDate: verifyAppt.consularDate, newConsularTime: verifyAppt.consularTime,
                  success: false, error: `[portal_reversion] ${errorMsg}`,
                  ...diag({ failReason: 'post_error', failStep: 'post_reschedule', durationMs: Date.now() - attemptStart, error: errorMsg }),
                }).catch((e) => logger.error('logReschedule failed', { error: String(e) })),
              );
              securedResult = null;
              effectiveCurrentDate = verifyAppt.consularDate;
              prevConsularDate = verifyAppt.consularDate;
              prevConsularTime = verifyAppt.consularTime;
              prevCasDate = verifyAppt.casDate;
              prevCasTime = verifyAppt.casTime;
              exhaustedDates.add(candidate.date);
              continue;
            }
          }
          // Appointment unchanged → POST actually failed, release the claimed slot
          await releaseSlot('post_error_no_change');
        } catch (verifyErr) {
          logger.warn('Post-error verification failed — cannot confirm appointment state', {
            botId, error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
          });
        }
      }

      if (error instanceof SessionExpiredError) {
        logger.error('Session expired during reschedule', { botId, step: currentStep, error: errorMsg });
        failedAttempts.push({ date: candidate.date, failReason: 'session_expired', failStep: currentStep, error: errorMsg, durationMs: Date.now() - attemptStart });
        dateFailureCount.set(candidate.date, (dateFailureCount.get(candidate.date) ?? 0) + 1);
        if (attempt < maxAttempts && await reloginIfPossible()) continue;
        // If we already secured a date, don't throw — return what we have
        if (securedResult) break;
        throw error;
      }

      logger.error('Error during reschedule attempt', {
        botId, date: candidate.date, step: currentStep,
        error: errorMsg, cause: errorCause,
      });
      failedAttempts.push({
        date: candidate.date,
        failReason: currentStep === 'post_reschedule' ? 'post_error' : 'fetch_error',
        failStep: currentStep,
        error: errorMsg,
        cause: errorCause,
        durationMs: Date.now() - attemptStart,
      });
      dateFailureCount.set(candidate.date, (dateFailureCount.get(candidate.date) ?? 0) + 1);
      // CAS days fetch failing (5xx) is semantically "no CAS days" — bump cross-poll tracker so
      // dates with no valid CAS window get blocked after 5 failures across polls.
      if (currentStep === 'parallel_cas_days') bumpTracker(candidate.date, 'casNoDays');
      // Transient failure — allow 1 retry (don't add to exhaustedDates)
      transientFailCount.set(candidate.date, (transientFailCount.get(candidate.date) ?? 0) + 1);
      // Re-login before next attempt on network errors
      if (attempt < maxAttempts) await reloginIfPossible();
    }
  }

  const totalDurationMs = Date.now() - totalStart;

  // Compute dates that failed 3+ times (any reason) — caller should block for 1h
  const repeatedlyFailingDates = new Set<string>();
  for (const [date, count] of dateFailureCount) {
    if (count >= REPEATEDLY_FAILING_THRESHOLD && !falsePositiveDates.has(date)) {
      repeatedlyFailingDates.add(date);
    }
  }

  // Compute dates newly blocked by the cross-poll tracker in this call
  const newlyBlockedDates: string[] = [];
  for (const [date, entry] of trackerDelta) {
    if (entry.blockedUntil && !falsePositiveDates.has(date)) {
      newlyBlockedDates.push(date);
    }
  }

  // If we secured at least one improvement, do a final verification before notifying.
  // The improvement loop can cause the portal to revert the secured booking (observed behavior:
  // POSTing a second reschedule attempt reverts the previous one server-side). We confirm the
  // actual server state before trusting securedResult and before sending the notification.
  if (securedResult) {
    securedResult.totalDurationMs = totalDurationMs;

    try {
      const finalAppt = await client.getCurrentAppointment();
      if (finalAppt && finalAppt.consularDate !== securedResult.date) {
        logger.error('Secured booking reverted by portal — final verification mismatch', {
          botId,
          secured: securedResult.date,
          actualServer: finalAppt.consularDate,
          totalDurationMs,
        });
        await releaseSlot('portal_reversion_detected');
        // Log the reversion as a failure entry so the dashboard shows it
        pending.push(
          db.insert(rescheduleLogs).values({
            botId,
            oldConsularDate: securedResult.date,
            oldConsularTime: securedResult.consularTime ?? null,
            oldCasDate: securedResult.casDate ?? null,
            oldCasTime: securedResult.casTime ?? null,
            newConsularDate: finalAppt.consularDate,
            newConsularTime: finalAppt.consularTime,
            success: false, error: 'portal_reversion',
          }).catch((e) => logger.error('logReschedule (portal_reversion) failed', { error: String(e) })),
        );
        // Sync DB to actual server state
        await db.update(bots).set({
          currentConsularDate: finalAppt.consularDate,
          currentConsularTime: finalAppt.consularTime,
          currentCasDate: finalAppt.casDate ?? null,
          currentCasTime: finalAppt.casTime ?? null,
          updatedAt: new Date(),
        }).where(eq(bots.id, botId));
        return { success: false, reason: 'portal_reversion', totalDurationMs, attempts: failedAttempts, falsePositiveDates: falsePositiveDates.size > 0 ? [...falsePositiveDates] : undefined, repeatedlyFailingDates: repeatedlyFailingDates.size > 0 ? [...repeatedlyFailingDates] : undefined, dateFailureTrackingDelta: trackerDelta.size > 0 ? Object.fromEntries(trackerDelta) : undefined, newlyBlockedDates: newlyBlockedDates.length > 0 ? newlyBlockedDates : undefined };
      }
    } catch (verifyErr) {
      // Network error on final check — proceed assuming securedResult is valid (don't lose a real success)
      logger.warn('Final post-reschedule verification failed (network), proceeding with securedResult', {
        botId, secured: securedResult.date,
        error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
      });
    }

    // Confirmed — send the single reschedule_success notification now
    pending.push(
      notifyUserTask.trigger({
        botId,
        event: 'reschedule_success',
        data: {
          oldConsularDate: bot.currentConsularDate,
          oldConsularTime: bot.currentConsularTime,
          oldCasDate: bot.currentCasDate,
          newConsularDate: securedResult.date,
          newConsularTime: securedResult.consularTime,
          newCasDate: securedResult.casDate,
          newCasTime: securedResult.casTime,
        },
      }).catch((e) => logger.error('notify trigger failed', { error: String(e) })),
    );

    logger.info('reschedule COMPLETE', {
      botId,
      original: `${bot.currentConsularDate} ${bot.currentConsularTime}`,
      final: `${securedResult.date} ${securedResult.consularTime}`,
      totalDurationMs,
      attempts: failedAttempts.length,
    });

    return { ...securedResult, repeatedlyFailingDates: repeatedlyFailingDates.size > 0 ? [...repeatedlyFailingDates] : undefined, dateFailureTrackingDelta: trackerDelta.size > 0 ? Object.fromEntries(trackerDelta) : undefined, newlyBlockedDates: newlyBlockedDates.length > 0 ? newlyBlockedDates : undefined };
  }

  logger.warn('reschedule FAILED — all attempts exhausted', { botId, exhausted: [...exhaustedDates], transient: Object.fromEntries(transientFailCount), totalDurationMs, attempts: failedAttempts });

  // Log failed reschedule attempt to reschedule_logs for traceability
  const failSummary = failedAttempts.map(a => `${a.date}:${a.failReason}${a.consularTime ? `@${a.consularTime}` : ''}`).join(', ');
  const firstAttempt = failedAttempts[0];
  pending.push(
    db.insert(rescheduleLogs).values({
      botId,
      oldConsularDate: bot.currentConsularDate,
      oldConsularTime: bot.currentConsularTime,
      oldCasDate: bot.currentCasDate,
      oldCasTime: bot.currentCasTime,
      newConsularDate: firstAttempt?.date ?? null,
      newConsularTime: firstAttempt?.consularTime ?? null,
      success: false,
      error: failSummary,
      // Se pasa el intento ENTERO, nunca una copia campo por campo.
      //
      // Antes esto reconstruia el objeto a mano y se le olvidaron `msToPost` y
      // `timesSeen`. Las otras seis ramas si los escribian; esta no. Y esta es la que
      // registra "se acabaron los intentos", por donde salen TODAS las filas
      // `no_times`, que es como falla es-pe (Peru no tiene CAS). Resultado: las 23.494
      // filas de `reschedule_logs` con `times_seen` nulo, incluidas las DOS unicas
      // detecciones del bot 299.
      //
      // `timesSeen` es lo que decide el caso: 0 = fecha fantasma (el calendario la
      // lista sin cupo real), mayor que 0 = habia cupo y perdimos la carrera. Sin el
      // no se puede saber si el fallback especulativo sirve de algo.
      //
      // `diag` recibe un `Pick`, entonces mandar el objeto completo compila igual y
      // deja de ser una lista que hay que acordarse de actualizar.
      ...diag(firstAttempt),
      ...(failedAttempts.length > 1 ? {
        detail: {
          allAttempts: failedAttempts.map(a => ({
            date: a.date, failReason: a.failReason, failStep: a.failStep,
            timesFound: a.timesFound, durationMs: a.durationMs,
            // `timesSeen` es el CONTEO que dio el portal. `timesFound` puede traer la
            // constante especulativa, entonces no sirve para contar. Ver
            // [[horas-especulativas-contaminadas]].
            timesSeen: a.timesSeen, msToPost: a.msToPost,
          })),
        },
      } : {}),
    }).catch((e) => logger.error('logReschedule (failed) insert error', { error: String(e) })),
  );

  return { success: false, reason: 'all_candidates_failed', totalDurationMs, attempts: failedAttempts, falsePositiveDates: falsePositiveDates.size > 0 ? [...falsePositiveDates] : undefined, repeatedlyFailingDates: repeatedlyFailingDates.size > 0 ? [...repeatedlyFailingDates] : undefined, dateFailureTrackingDelta: trackerDelta.size > 0 ? Object.fromEntries(trackerDelta) : undefined, newlyBlockedDates: newlyBlockedDates.length > 0 ? newlyBlockedDates : undefined };
}

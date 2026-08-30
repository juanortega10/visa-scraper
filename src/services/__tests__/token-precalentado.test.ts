/**
 * Token precalentado: `refreshTokens()` sale del camino critico.
 *
 * Antes, `executeReschedule` pedia la pagina del appointment DESPUES de ver el cupo
 * y ANTES de `times.json`, en serie. Medido en el bot 299 el 2026-08-27: 13.832 ms
 * de esa llamada mas 3.354 ms de `times.json`, con un cupo que vivio 15 segundos.
 *
 * Ahora hay dos reglas y estos casos las fijan:
 *
 *   1. Token fresco y cuenta SIN CAS  -> no se pide nada. Cero peticiones.
 *   2. En cualquier otro caso         -> se pide EN PARALELO con `times.json`.
 *
 * El salto por frescura NO aplica con CAS: ahi `getHasAscFields()` solo se conoce
 * leyendo la pagina, y sin ese dato una cuenta de renovacion se iria por la rama de
 * CAS y fallaria siempre con `no_cas_days`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DaySlot } from '../visa-client.js';
import type { RescheduleBot } from '../reschedule-logic.js';

const { mockDbSelect, mockDbUpdate, mockDbInsert } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(), mockDbUpdate: vi.fn(), mockDbInsert: vi.fn(),
}));

function chain(v: any) {
  const c: any = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'offset', 'set', 'values']) c[m] = () => c;
  c.returning = () => Promise.resolve(v);
  c.then = (res: any, rej?: any) => Promise.resolve(v).then(res, rej);
  c.catch = (fn: any) => Promise.resolve(v).catch(fn);
  return c;
}

vi.mock('../../db/client.js', () => ({
  db: { select: (...a: any[]) => mockDbSelect(...a), insert: (...a: any[]) => mockDbInsert(...a), update: (...a: any[]) => mockDbUpdate(...a) },
}));
vi.mock('../../db/schema.js', () => ({
  bots: { _name: 'bots', id: 'bots.id', currentConsularDate: 'bots.currentConsularDate', rescheduleCount: 'bots.rescheduleCount', maxReschedules: 'bots.maxReschedules', portalRemainingReschedules: 'bots.portalRemainingReschedules' },
  sessions: { _name: 'sessions', botId: 'sessions.botId' },
  rescheduleLogs: { _name: 'rescheduleLogs' },
}));
vi.mock('drizzle-orm', () => ({
  eq: (...a: any[]) => ({ a }), sql: (s: TemplateStringsArray) => `sql:${s.join('')}`,
  or: (...a: any[]) => ({ a }), lt: (...a: any[]) => ({ a }), gt: (...a: any[]) => ({ a }),
  isNull: (...a: any[]) => ({ a }), and: (...a: any[]) => ({ a }),
}));
vi.mock('@trigger.dev/sdk/v3', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../trigger/notify-user.js', () => ({ notifyUserTask: { trigger: vi.fn().mockResolvedValue({}) } }));
vi.mock('../encryption.js', () => ({ encrypt: (v: string) => v, decrypt: (v: string) => v }));

/** Bot 299: es-pe, sin CAS. `ascFacilityId` vacio. */
const BOT_SIN_CAS: RescheduleBot = {
  currentConsularDate: '2027-12-23', currentConsularTime: '10:15',
  currentCasDate: null, currentCasTime: null,
  ascFacilityId: '', skipCas: true, minDaysFromToday: 0,
};
const DIAS: DaySlot[] = [{ date: '2026-10-08', business_day: true }];

function makeClient(over: Record<string, any> = {}) {
  return {
    getConsularDays: vi.fn().mockResolvedValue(DIAS),
    getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['10:15'] }),
    getCasDays: vi.fn().mockResolvedValue([]), getCasTimes: vi.fn().mockResolvedValue({ available_times: [] }),
    reschedule: vi.fn().mockResolvedValue(true),
    getCurrentAppointment: vi.fn().mockResolvedValue({ consularDate: '2026-10-08', consularTime: '10:15', casDate: null, casTime: null }),
    getSession: vi.fn().mockReturnValue({ cookie: 'c', csrfToken: 't', authenticityToken: 'a' }),
    getConfig: vi.fn().mockReturnValue({ proxyProvider: 'webshare' }),
    getHasAscFields: vi.fn().mockReturnValue(false), getCollectsBiometrics: vi.fn().mockReturnValue(false),
    updateSession: vi.fn(), refreshTokens: vi.fn().mockResolvedValue(undefined),
    getTokensAgeMs: vi.fn().mockReturnValue(Number.POSITIVE_INFINITY),
    getTokensRefreshedAt: vi.fn().mockReturnValue(null),
    ensureTokens: vi.fn().mockResolvedValue(true),
    ...over,
  } as any;
}

async function run(client: any, extra: Record<string, any> = {}) {
  const { executeReschedule } = await import('../reschedule-logic.js');
  return executeReschedule({
    client, botId: 299, bot: BOT_SIN_CAS, dateExclusions: [], timeExclusions: [],
    preFetchedDays: DIAS, casCacheJson: null, dryRun: false, pending: [],
    maxReschedules: 1, portalRemaining: 2, maxAttempts: 1, ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2027-12-23' }]));
  mockDbInsert.mockReturnValue(chain([]));
  mockDbUpdate.mockReturnValue(chain([{ rescheduleCount: 1 }]));
});

describe('token precalentado', () => {
  it('token fresco y sin CAS: NO pide la pagina del appointment', async () => {
    const { MAX_EDAD_TOKEN_MS } = await import('../reschedule-logic.js');
    const client = makeClient({
      getTokensAgeMs: vi.fn().mockReturnValue(MAX_EDAD_TOKEN_MS - 1_000),
    });
    const r = await run(client);
    expect(r.success).toBe(true);
    expect(client.refreshTokens).not.toHaveBeenCalled();
  });

  it('token justo en el limite todavia sirve', async () => {
    const { MAX_EDAD_TOKEN_MS } = await import('../reschedule-logic.js');
    const client = makeClient({ getTokensAgeMs: vi.fn().mockReturnValue(MAX_EDAD_TOKEN_MS) });
    await run(client);
    expect(client.refreshTokens).not.toHaveBeenCalled();
  });

  it('token pasado de edad: si lo pide', async () => {
    const { MAX_EDAD_TOKEN_MS } = await import('../reschedule-logic.js');
    const client = makeClient({ getTokensAgeMs: vi.fn().mockReturnValue(MAX_EDAD_TOKEN_MS + 1) });
    await run(client);
    expect(client.refreshTokens).toHaveBeenCalledTimes(1);
  });

  it('edad desconocida (sesion recien leida): lo pide', async () => {
    const client = makeClient();   // Infinity por defecto
    await run(client);
    expect(client.refreshTokens).toHaveBeenCalledTimes(1);
  });

  it('con CAS NUNCA se salta, aunque el token este fresco', async () => {
    const { MAX_EDAD_TOKEN_MS } = await import('../reschedule-logic.js');
    const client = makeClient({
      getTokensAgeMs: vi.fn().mockReturnValue(0),
      getHasAscFields: vi.fn().mockReturnValue(true),
      getCasDays: vi.fn().mockResolvedValue([{ date: '2026-10-01', business_day: true }]),
      getCasTimes: vi.fn().mockResolvedValue({ available_times: ['08:00'] }),
    });
    await run(client, {
      bot: { ...BOT_SIN_CAS, ascFacilityId: '26', skipCas: false },
    });
    expect(client.refreshTokens).toHaveBeenCalledTimes(1);
  });

  /**
   * VERIFICADOR ADVERSARIAL del paralelismo.
   *
   * `refreshTokens()` queda colgado a proposito y NUNCA resuelve solo. Con el codigo
   * viejo (`await client.refreshTokens()` antes del bucle) `times.json` no se pedia
   * jamas y este caso moria por timeout. Solo pasa si la peticion de horas sale sin
   * esperar al token.
   */
  it('ADVERSARIAL: times.json sale aunque refreshTokens siga colgado', async () => {
    let soltarRefresh: () => void = () => {};
    const refrescoColgado = new Promise<void>((res) => { soltarRefresh = res; });
    const client = makeClient({
      getTokensAgeMs: vi.fn().mockReturnValue(Number.POSITIVE_INFINITY),
      refreshTokens: vi.fn().mockReturnValue(refrescoColgado),
    });

    const p = run(client);
    // Una vuelta de la cola de eventos. Suficiente para que salga lo que no espera.
    await new Promise((r) => setTimeout(r, 0));

    expect(client.refreshTokens).toHaveBeenCalledTimes(1);
    expect(client.getConsularTimes).toHaveBeenCalledTimes(1);   // <- en serie seria 0
    expect(client.reschedule).not.toHaveBeenCalled();           // el POST si espera el token

    soltarRefresh();
    const r = await p;
    expect(r.success).toBe(true);
  });

  /**
   * El POST NO puede salir antes de que el token este resuelto. Es la otra mitad:
   * paralelizar no puede degradar en "postear sin token".
   */
  it('ADVERSARIAL: el POST espera al token, no sale antes', async () => {
    const orden: string[] = [];
    let soltarRefresh: () => void = () => {};
    const refrescoColgado = new Promise<void>((res) => {
      soltarRefresh = () => { orden.push('refresh:fin'); res(); };
    });
    const client = makeClient({
      getTokensAgeMs: vi.fn().mockReturnValue(Number.POSITIVE_INFINITY),
      refreshTokens: vi.fn().mockReturnValue(refrescoColgado),
      reschedule: vi.fn().mockImplementation(async () => { orden.push('post'); return true; }),
    });
    const p = run(client);
    await new Promise((r) => setTimeout(r, 0));
    soltarRefresh();
    await p;
    expect(orden).toEqual(['refresh:fin', 'post']);
  });

  it('si el refresco falla, el POST se intenta igual (advertencia, no aborto)', async () => {
    const client = makeClient({
      refreshTokens: vi.fn().mockRejectedValue(new Error('headers timeout')),
    });
    const r = await run(client);
    expect(r.success).toBe(true);
    expect(client.reschedule).toHaveBeenCalled();
  });

  /**
   * Semantica que NO se podia perder al partir el try en dos: una sesion vencida
   * durante el refresco sube como excepcion, no se traga.
   */
  it('una sesion vencida en el refresco SIGUE subiendo como excepcion', async () => {
    const { SessionExpiredError } = await import('../visa-client.js');
    const client = makeClient({
      refreshTokens: vi.fn().mockRejectedValue(new SessionExpiredError('302 sign_in')),
    });
    await expect(run(client)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(client.reschedule).not.toHaveBeenCalled();
  });
});

/**
 * Horas especulativas por bot.
 *
 * La constante global `['10:15','10:00','07:30']` no tiene respaldo medido: las 354
 * apariciones de ese trio en la base eran la propia constante, no lecturas del portal.
 * Cada schedule tiene sus horas, entonces el bot puede traer las suyas.
 */
describe('horas especulativas por bot', () => {
  const conFallback = { ...BOT_SIN_CAS, speculativeTimeFallback: true };

  it('usa las horas DEL BOT cuando times.json vuelve vacio', async () => {
    const client = makeClient({ getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }) });
    await run(client, { bot: { ...conFallback, speculativeTimes: ['09:30'] } });
    expect(client.reschedule).toHaveBeenCalledTimes(1);
    expect(client.reschedule).toHaveBeenCalledWith('2026-10-08', '09:30');
  });

  it('respeta el ORDEN que trae el bot', async () => {
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }),
      reschedule: vi.fn().mockResolvedValue(false),
    });
    await run(client, { bot: { ...conFallback, speculativeTimes: ['09:30', '08:00'] } });
    expect(client.reschedule.mock.calls.map((c: any[]) => c[1])).toEqual(['09:30', '08:00']);
  });

  it('cae a la constante global cuando el bot no trae horas', async () => {
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }),
      reschedule: vi.fn().mockResolvedValue(false),
    });
    await run(client, { bot: { ...conFallback, speculativeTimes: null } });
    expect(client.reschedule.mock.calls.map((c: any[]) => c[1])).toEqual(['10:15', '10:00', '07:30']);
  });

  it('un arreglo vacio tambien cae a la constante, no deja al bot sin horas', async () => {
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }),
      reschedule: vi.fn().mockResolvedValue(false),
    });
    await run(client, { bot: { ...conFallback, speculativeTimes: [] } });
    expect(client.reschedule.mock.calls.length).toBe(3);
  });

  it('SIN el fallback prendido no postea nada aunque traiga horas', async () => {
    const client = makeClient({ getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }) });
    const r = await run(client, {
      bot: { ...BOT_SIN_CAS, speculativeTimeFallback: false, speculativeTimes: ['09:30'] },
    });
    expect(client.reschedule).not.toHaveBeenCalled();
    expect(r.success).toBe(false);
  });

  it('cuando times.json SI trae horas, se usan esas y no las adivinadas', async () => {
    const client = makeClient({ getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['11:45'] }) });
    await run(client, { bot: { ...conFallback, speculativeTimes: ['09:30'] } });
    expect(client.reschedule).toHaveBeenCalledWith('2026-10-08', '11:45');
  });
});

/**
 * Verificacion posterior al POST cuando la lectura de la cita devuelve null.
 *
 * `getCurrentAppointment()` devuelve `null` SIN lanzar en tres casos: sin `userId`,
 * con HTTP distinto de 200, o si no encuentra el grupo. Antes del 2026-08-30 la
 * verificacion decia `if (verifyAppt && verifyAppt.consularDate !== candidate.date)`,
 * entonces con `null` no entraba y el intento quedaba marcado como verificado.
 *
 * Caso real: bot 7, 2026-04-17, `success=true` hacia 2026-04-22 con la cita quieta en
 * 2027-07-30 durante 277 intentos. El contador de reagendamientos bajo igual.
 */
describe('verificacion posterior al POST', () => {
  it('ADVERSARIAL: con hora real, una lectura null se REINTENTA y queda marcada', async () => {
    const client = makeClient({
      reschedule: vi.fn().mockResolvedValue(true),
      getCurrentAppointment: vi.fn().mockResolvedValue(null),
    });
    const r = await run(client);
    expect(client.reschedule).toHaveBeenCalled();
    // Con hora REAL se conserva el exito, y la fila queda marcada para la auditoria.
    expect(r.success).toBe(true);
    expect(mockDbInsert.mock.calls.length).toBeGreaterThan(0);
  });

  /**
   * El reintento tiene que RECUPERAR un null pasajero. Sin el, ese primer null
   * marcaria el exito como no verificado aunque la cita si se hubiera movido.
   */
  it('ADVERSARIAL: un null pasajero se recupera en el reintento', async () => {
    const escritas: any[] = [];
    mockDbInsert.mockImplementation(() => {
      const c: any = {};
      for (const m of ['from', 'where', 'orderBy', 'limit', 'offset', 'set']) c[m] = () => c;
      c.values = (v: any) => { escritas.push(v); return c; };
      c.returning = () => Promise.resolve([]);
      c.then = (res: any, rej?: any) => Promise.resolve([]).then(res, rej);
      c.catch = (fn: any) => Promise.resolve([]).catch(fn);
      return c;
    });
    const buena = { consularDate: '2026-10-08', consularTime: '10:15', casDate: null, casTime: null };
    const lector = vi.fn()
      .mockResolvedValueOnce(null)      // primer intento: falla
      .mockResolvedValue(buena);        // reintento: responde
    const client = makeClient({ reschedule: vi.fn().mockResolvedValue(true), getCurrentAppointment: lector });

    const r = await run(client);
    expect(r.success).toBe(true);
    expect(lector.mock.calls.length).toBeGreaterThanOrEqual(2);
    const exito = escritas.find((v) => v?.success === true);
    expect(exito).toBeDefined();
    // Se recupero de verdad: el exito NO lleva la marca.
    expect(String(exito.error)).not.toContain('NO VERIFICADO');
  });

  it('ADVERSARIAL: la fila de exito lleva la marca NO VERIFICADO', async () => {
    const escritas: any[] = [];
    mockDbInsert.mockImplementation(() => {
      const c: any = {};
      for (const m of ['from', 'where', 'orderBy', 'limit', 'offset', 'set']) c[m] = () => c;
      c.values = (v: any) => { escritas.push(v); return c; };
      c.returning = () => Promise.resolve([]);
      c.then = (res: any, rej?: any) => Promise.resolve([]).then(res, rej);
      c.catch = (fn: any) => Promise.resolve([]).catch(fn);
      return c;
    });
    const client = makeClient({
      reschedule: vi.fn().mockResolvedValue(true),
      getCurrentAppointment: vi.fn().mockResolvedValue(null),
    });
    await run(client);
    const exito = escritas.find((v) => v?.success === true);
    expect(exito).toBeDefined();
    expect(String(exito.error)).toContain('NO VERIFICADO');
  });

  it('ADVERSARIAL: con la hora adivinada y lectura null, se DEVUELVE el cupo', async () => {
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }),
      reschedule: vi.fn().mockResolvedValue(true),
      getCurrentAppointment: vi.fn().mockResolvedValue(null),
    });
    const r = await run(client, {
      bot: { ...BOT_SIN_CAS, speculativeTimeFallback: true, speculativeTimes: ['09:30'] },
    });
    expect(client.reschedule).toHaveBeenCalledWith('2026-10-08', '09:30');
    expect(r.success).toBe(false);
    // releaseSlot devuelve el cupo con un UPDATE. Se comprueba que hubo mas de uno:
    // el claim al entrar y la devolucion al no poder verificar.
    expect(mockDbUpdate.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('una lectura buena que confirma la fecha SIGUE dando exito', async () => {
    const client = makeClient({
      getCurrentAppointment: vi.fn().mockResolvedValue({
        consularDate: '2026-10-08', consularTime: '10:15', casDate: null, casTime: null,
      }),
    });
    const r = await run(client);
    expect(r.success).toBe(true);
  });

  it('una lectura buena con OTRA fecha sigue marcando falso positivo', async () => {
    const client = makeClient({
      getCurrentAppointment: vi.fn().mockResolvedValue({
        consularDate: '2027-12-23', consularTime: '10:15', casDate: null, casTime: null,
      }),
    });
    const r = await run(client);
    expect(r.success).toBe(false);
  });
});

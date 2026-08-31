/**
 * El cupo del portal, mirado desde TODOS los paises, no desde uno.
 *
 * Historia que obliga este archivo. El 27 de agosto de 2026 el commit 2f1ad47
 * endurecio el tope de reagendamientos para Peru, que tiene un maximo real de 2.
 * El cobro del cupo quedo asi:
 *
 *     portalRemainingReschedules: GREATEST(0, COALESCE(saldo, 1) - 1)
 *
 * En Peru funciona. En Colombia el saldo es NULL, porque el portal no pone tope.
 * COALESCE(NULL, 1) - 1 da 0, y ese 0 se guardo. Desde el primer cobro, un bot
 * colombiano quedaba con "saldo agotado" para siempre y todo intento moria con
 * `max_reschedules_reached`. Cuatro bots activos quedaron mudos: 298, 300, 301
 * y 302. El 298 llevaba 9 reagendamientos buenos y se detuvo en seco.
 *
 * La leccion no es el COALESCE. Es que se construyo mirando un solo pais.
 * Por eso estas pruebas recorren una MATRIZ de paises, y cada invariante se
 * afirma para los que tienen tope y para los que no.
 *
 * Invariante central:
 *   Un bot cuyo portal no impone tope NUNCA puede quedar bloqueado por cupo.
 *   Solo un pais con tope real del portal puede bloquear.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DaySlot } from '../visa-client.js';
import type { RescheduleBot } from '../reschedule-logic.js';

const { mockDbSelect, mockDbUpdate, mockDbInsert, setCalls, insertValues, mockPerformLogin } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbInsert: vi.fn(),
  setCalls: [] as any[],
  insertValues: [] as any[],
  mockPerformLogin: vi.fn(),
}));

function chain(resolveValue: any) {
  const c: any = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'offset']) c[m] = () => c;
  c.set = (v: any) => { setCalls.push(v); return c; };
  c.values = (v: any) => { insertValues.push(v); return c; };
  c.returning = () => Promise.resolve(resolveValue);
  c.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  c.catch = (fn: any) => Promise.resolve(resolveValue).catch(fn);
  return c;
}

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: any[]) => mockDbSelect(...a),
    insert: (...a: any[]) => mockDbInsert(...a),
    update: (...a: any[]) => mockDbUpdate(...a),
  },
}));

vi.mock('../../db/schema.js', () => ({
  bots: {
    _name: 'bots', id: 'bots.id', currentConsularDate: 'bots.currentConsularDate',
    rescheduleCount: 'bots.rescheduleCount', maxReschedules: 'bots.maxReschedules',
    portalRemainingReschedules: 'bots.portalRemainingReschedules',
    portalMaxReschedules: 'bots.portalMaxReschedules',
  },
  sessions: { _name: 'sessions', botId: 'sessions.botId' },
  rescheduleLogs: { _name: 'rescheduleLogs' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: any[]) => ({ _op: 'eq', a }),
  sql: (s: TemplateStringsArray) => `sql:${s.join('')}`,
  or: (...a: any[]) => ({ _op: 'or', a }),
  lt: (...a: any[]) => ({ _op: 'lt', a }),
  gt: (...a: any[]) => ({ _op: 'gt', a }),
  isNull: (...a: any[]) => ({ _op: 'isNull', a }),
  and: (...a: any[]) => ({ _op: 'and', a }),
}));

vi.mock('@trigger.dev/sdk/v3', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  runs: { cancel: vi.fn() },
  queue: vi.fn((o: unknown) => o),
  auth: { createTriggerPublicToken: vi.fn() },
}));

vi.mock('../../trigger/notify-user.js', () => ({
  notifyUserTask: { trigger: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../encryption.js', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => String(v).replace('enc:', ''),
}));

vi.mock('../login.js', () => ({ performLogin: (...a: any[]) => mockPerformLogin(...a) }));

const NOW = new Date('2026-08-30T12:00:00Z');
const DIAS: DaySlot[] = [{ date: '2026-09-15', business_day: true }];

/**
 * La matriz. `topePortal` es el maximo real que impone cada portal.
 * `null` significa que ese portal no limita los reagendamientos, y entonces la
 * columna `portal_remaining_reschedules` vive en NULL.
 */
const PAISES = [
  { locale: 'es-co', pais: 'Colombia',   topePortal: null, saldo: null },
  { locale: 'en-co', pais: 'Colombia',   topePortal: null, saldo: null },
  { locale: 'es-mx', pais: 'Mexico',     topePortal: null, saldo: null },
  { locale: 'pt-br', pais: 'Brasil',     topePortal: null, saldo: null },
  { locale: 'es-ec', pais: 'Ecuador',    topePortal: null, saldo: null },
  { locale: 'es-cl', pais: 'Chile',      topePortal: null, saldo: null },
  { locale: 'es-ar', pais: 'Argentina',  topePortal: null, saldo: null },
  { locale: 'es-do', pais: 'R. Dominicana', topePortal: null, saldo: null },
  { locale: 'es-pe', pais: 'Peru',       topePortal: 2,    saldo: 2 },
  { locale: 'fr-ca', pais: 'Canada',     topePortal: 3,    saldo: 3 },
] as const;

const SIN_TOPE = PAISES.filter((p) => p.topePortal === null);
const CON_TOPE = PAISES.filter((p) => p.topePortal !== null);

function bot(over: Partial<RescheduleBot> = {}): RescheduleBot {
  return {
    currentConsularDate: '2027-12-23',
    currentConsularTime: '10:15',
    currentCasDate: null,
    currentCasTime: null,
    ascFacilityId: '',
    skipCas: true,
    targetDateBefore: null,
    minDaysFromToday: 0,
    ...over,
  } as RescheduleBot;
}

function makeClient(over: Record<string, any> = {}) {
  return {
    getConsularDays: vi.fn().mockResolvedValue(DIAS),
    getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['10:15'] }),
    getCasDays: vi.fn().mockResolvedValue([]),
    getCasTimes: vi.fn().mockResolvedValue({ available_times: [] }),
    reschedule: vi.fn().mockResolvedValue(true),
    getCurrentAppointment: vi.fn().mockResolvedValue({ consularDate: '2026-09-15', consularTime: '10:15', casDate: null, casTime: null }),
    getSession: vi.fn().mockReturnValue({ cookie: 'ck', csrfToken: 'cs', authenticityToken: 'auth' }),
    getConfig: vi.fn().mockReturnValue({ proxyProvider: 'webshare' }),
    getHasAscFields: vi.fn().mockReturnValue(false),
    getCollectsBiometrics: vi.fn().mockReturnValue(false),
    updateSession: vi.fn(),
    refreshTokens: vi.fn().mockResolvedValue(undefined),
    getTokensAgeMs: vi.fn().mockReturnValue(Number.POSITIVE_INFINITY),
    getTokensRefreshedAt: vi.fn().mockReturnValue(null),
    ensureTokens: vi.fn().mockResolvedValue(true),
    ...over,
  } as any;
}

async function run(extra: Record<string, any> = {}) {
  const { executeReschedule } = await import('../reschedule-logic.js');
  return executeReschedule({
    client: extra.client ?? makeClient(),
    botId: 900, bot: bot(),
    dateExclusions: [], timeExclusions: [],
    preFetchedDays: DIAS, casCacheJson: null,
    dryRun: false, pending: [],
    loginCredentials: { email: 'a@b.c', password: 'x', scheduleId: '1', applicantIds: ['2'], locale: 'es-co' },
    maxReschedules: null, portalRemaining: null,
    maxAttempts: 1,
    ...extra,
  } as any);
}

/** El .set() de claimSlot: suma en rescheduleCount. El de releaseSlot: resta. */
const claims = () => setCalls.filter((s) => 'rescheduleCount' in s && !String(s.rescheduleCount).includes('GREATEST'));
const releases = () => setCalls.filter((s) => 'rescheduleCount' in s && String(s.rescheduleCount).includes('GREATEST'));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setCalls.length = 0;
  insertValues.length = 0;
  mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2027-12-23' }]));
  mockDbInsert.mockReturnValue(chain([]));
  mockDbUpdate.mockReturnValue(chain([{ rescheduleCount: 1 }]));
  mockPerformLogin.mockResolvedValue({ cookie: 'ck2', csrfToken: 'cs2', authenticityToken: 'auth2', hasTokens: true });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('cupo del portal — paises SIN tope', () => {
  it.each(SIN_TOPE.map((p) => [p.locale, p.pais] as const))(
    '%s (%s): un UPDATE que no devuelve filas NO puede bloquear',
    async (locale) => {
      // Este es el caso exacto del 30 de agosto. Sin tope declarado, un UPDATE
      // sin filas es ruido de carrera, no un limite. Bloquear aqui deja al bot mudo.
      mockDbUpdate.mockReturnValue(chain([]));

      const r: any = await run({
        maxReschedules: null,
        portalRemaining: null,
        loginCredentials: { email: 'a@b.c', password: 'x', scheduleId: '1', applicantIds: ['2'], locale },
      });

      expect(r.reason).not.toBe('max_reschedules_reached');
      expect(r.success).toBe(true);
    },
  );

  it.each(SIN_TOPE.map((p) => [p.locale, p.pais] as const))(
    '%s (%s): cobrar el cupo deja el saldo en NULL, nunca en 0',
    async (locale) => {
      await run({
        maxReschedules: null,
        portalRemaining: null,
        loginCredentials: { email: 'a@b.c', password: 'x', scheduleId: '1', applicantIds: ['2'], locale },
      });

      expect(claims().length).toBeGreaterThan(0);
      for (const c of claims()) {
        const expr = String(c.portalRemainingReschedules);
        // La forma vieja `GREATEST(0, COALESCE(saldo, 1) - 1)` fabricaba un 0.
        expect(expr).not.toContain('COALESCE');
        expect(expr).toContain('IS NULL');
      }
    },
  );
});

describe('cupo del portal — paises CON tope', () => {
  it.each(CON_TOPE.map((p) => [p.locale, p.pais, p.topePortal] as const))(
    '%s (%s, tope %i): con el saldo agotado SI bloquea',
    async (locale, _pais, tope) => {
      // El arreglo no puede desarmar el limite real. En Peru un reagendamiento
      // de mas BLOQUEA la cita y no hay vuelta atras.
      mockDbUpdate.mockReturnValue(chain([]));

      const r: any = await run({
        maxReschedules: null,
        portalRemaining: 0,
        loginCredentials: { email: 'a@b.c', password: 'x', scheduleId: '1', applicantIds: ['2'], locale },
      });

      expect(r.success).toBe(false);
      expect(r.reason).toBe('max_reschedules_reached');
      expect(tope).toBeGreaterThan(0);
    },
  );

  it.each(CON_TOPE.map((p) => [p.locale, p.pais] as const))(
    '%s (%s): con saldo disponible reagenda normal',
    async (locale) => {
      const r: any = await run({
        maxReschedules: null,
        portalRemaining: 2,
        loginCredentials: { email: 'a@b.c', password: 'x', scheduleId: '1', applicantIds: ['2'], locale },
      });

      expect(r.success).toBe(true);
      expect(r.reason).not.toBe('max_reschedules_reached');
    },
  );
});

describe('nuestro presupuesto (max_reschedules) es independiente del portal', () => {
  it('bloquea en cualquier pais cuando el presupuesto se agota', async () => {
    // Este tope lo ponemos nosotros, no el portal. Aplica igual en Colombia.
    mockDbUpdate.mockReturnValue(chain([]));

    const r: any = await run({ maxReschedules: 1, portalRemaining: null });

    expect(r.success).toBe(false);
    expect(r.reason).toBe('max_reschedules_reached');
  });

  it('sin presupuesto y sin tope del portal, no hay nada que bloquee', async () => {
    mockDbUpdate.mockReturnValue(chain([]));

    const r: any = await run({ maxReschedules: null, portalRemaining: null });

    expect(r.success).toBe(true);
  });
});

describe('devolver el cupo es simetrico con cobrarlo', () => {
  it('releaseSlot repone el saldo del portal, no solo el contador', async () => {
    const { SessionExpiredError } = await import('../visa-client.js');
    // La cita NO cambio en el portal: si `getCurrentAppointment` devolviera la
    // fecha nueva, la red de seguridad de post_error lo contaria como exito.
    const client = makeClient({
      reschedule: vi.fn().mockRejectedValue(new SessionExpiredError()),
      getCurrentAppointment: vi.fn().mockResolvedValue({ consularDate: '2027-12-23', consularTime: '10:15', casDate: null, casTime: null }),
    });

    await run({ client, portalRemaining: 2, maxReschedules: null, maxAttempts: 2 }).catch(() => {});

    expect(releases().length).toBeGreaterThan(0);
    for (const rel of releases()) {
      // Antes releaseSlot solo escribia rescheduleCount. Un intento fallido
      // quemaba el cupo del portal para siempre.
      expect(rel).toHaveProperty('portalRemainingReschedules');
      expect(String(rel.portalRemainingReschedules)).toContain('+ 1');
      // Y nunca puede reponer por encima del maximo del portal.
      expect(String(rel.portalRemainingReschedules)).toContain('LEAST');
    }
  });

  it('un saldo en NULL sigue en NULL al devolver el cupo', async () => {
    const { SessionExpiredError } = await import('../visa-client.js');
    const client = makeClient({
      reschedule: vi.fn().mockRejectedValue(new SessionExpiredError()),
      getCurrentAppointment: vi.fn().mockResolvedValue({ consularDate: '2027-12-23', consularTime: '10:15', casDate: null, casTime: null }),
    });

    await run({ client, portalRemaining: null, maxReschedules: null, maxAttempts: 2 }).catch(() => {});

    for (const rel of releases()) {
      expect(String(rel.portalRemainingReschedules)).toContain('IS NULL');
    }
  });
});

describe('la matriz cubre de verdad los dos lados', () => {
  it('tiene paises con tope y sin tope', () => {
    // Guarda contra el error de origen: una matriz de un solo pais no prueba nada.
    expect(SIN_TOPE.length).toBeGreaterThanOrEqual(5);
    expect(CON_TOPE.length).toBeGreaterThanOrEqual(2);
  });


});

/**
 * Las dos medidas nuevas de la carrera por un cupo.
 *
 * El 31 de agosto de 2026, en Peru, 162 intentos en dos meses dieron 0 exitos y
 * 134 murieron en `verification_failed`. Con lo que se guardaba entonces era
 * imposible saber cual de las dos cosas pasaba: que el cupo no existiera, o que
 * nos ganaran la carrera. `times_seen` separa esos dos casos y `ms_to_post` mide
 * lo unico que compite.
 */
describe('medidas de la carrera: ms_to_post y times_seen', () => {
  it('times_seen cuenta los horarios del PORTAL, no los especulativos', async () => {
    // El portal no ofrece ni un horario. El bot tiene fallback especulativo, asi
    // que igual va a postear, pero el registro debe decir 0: fecha fantasma.
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: [] }),
      reschedule: vi.fn().mockResolvedValue(false),
    });

    await run({
      client,
      bot: bot({ speculativeTimeFallback: true, speculativeTimes: ['09:30'] } as never),
      portalRemaining: null, maxReschedules: null,
    }).catch(() => {});

    const log = insertValues.find((v) => v.timesSeen !== undefined);
    expect(log).toBeDefined();
    expect(log!.timesSeen).toBe(0);
  });

  it('times_seen mayor que cero cuando el cupo si existia', async () => {
    const client = makeClient({
      getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['09:00', '10:15', '11:30'] }),
      reschedule: vi.fn().mockResolvedValue(false),
    });

    await run({ client, portalRemaining: null, maxReschedules: null }).catch(() => {});

    const log = insertValues.find((v) => v.timesSeen !== undefined && v.timesSeen !== null);
    expect(log!.timesSeen).toBe(3);
  });

  it('ms_to_post se registra y NO incluye la verificacion posterior', async () => {
    // La verificacion corre despues del POST y ya no compite por el cupo. Si
    // `ms_to_post` la incluyera, seria otra copia de `duration_ms` y no serviria
    // para decidir si llegamos tarde.
    const client = makeClient({ reschedule: vi.fn().mockResolvedValue(false) });

    await run({ client, portalRemaining: null, maxReschedules: null }).catch(() => {});

    const log = insertValues.find((v) => v.msToPost !== undefined && v.msToPost !== null);
    expect(log).toBeDefined();
    expect(typeof log!.msToPost).toBe('number');
    expect(log!.msToPost).toBeLessThanOrEqual(log!.durationMs as number);
  });

  it('un EXITO tambien registra las dos medidas', async () => {
    // Sin esto no hay con que comparar: se sabria como se ve perder y no como se
    // ve ganar.
    await run({ portalRemaining: null, maxReschedules: null });

    const exito = insertValues.find((v) => v.success === true);
    expect(exito).toBeDefined();
    expect(exito!.msToPost).toEqual(expect.any(Number));
    expect(exito!.timesSeen).toEqual(expect.any(Number));
  });
});

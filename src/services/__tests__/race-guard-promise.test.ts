/**
 * Guarda de carrera con la lectura adelantada.
 *
 * `poll-visa.ts` lanza tres consultas a la vez y le pasa a `executeReschedule` la
 * de `current_consular_date` ya en vuelo. Lo unico que cambia es CUANDO sale el
 * viaje a la base de datos. La guarda se espera igual, antes de elegir candidata y
 * antes del POST, y sigue bloqueando lo mismo.
 *
 * Estos tests fijan las dos mitades: que la promesa se usa de verdad, y que la
 * guarda no se ablando.
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

const BOT: RescheduleBot = {
  currentConsularDate: '2027-12-23', currentConsularTime: '10:15',
  currentCasDate: null, currentCasTime: null,
  ascFacilityId: '', skipCas: true, minDaysFromToday: 0,
};
const DIAS: DaySlot[] = [{ date: '2026-09-15', business_day: true }];

function makeClient(over: Record<string, any> = {}) {
  return {
    getConsularDays: vi.fn().mockResolvedValue(DIAS),
    getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['10:15'] }),
    getCasDays: vi.fn().mockResolvedValue([]), getCasTimes: vi.fn().mockResolvedValue({ available_times: [] }),
    reschedule: vi.fn().mockResolvedValue(true),
    getCurrentAppointment: vi.fn().mockResolvedValue({ consularDate: '2026-09-15', consularTime: '10:15', casDate: null, casTime: null }),
    getSession: vi.fn().mockReturnValue({ cookie: 'c', csrfToken: 't', authenticityToken: 'a' }),
    getConfig: vi.fn().mockReturnValue({ proxyProvider: 'webshare' }),
    getHasAscFields: vi.fn().mockReturnValue(false), getCollectsBiometrics: vi.fn().mockReturnValue(false),
    updateSession: vi.fn(), refreshTokens: vi.fn().mockResolvedValue(undefined),
    // Edad del token precalentado. Infinity = desconocida, o sea siempre se refresca:
    // es el comportamiento historico que estos casos ya cubren.
    getTokensAgeMs: vi.fn().mockReturnValue(Number.POSITIVE_INFINITY),
    getTokensRefreshedAt: vi.fn().mockReturnValue(null),
    ensureTokens: vi.fn().mockResolvedValue(true),
    ...over,
  } as any;
}

async function run(client: any, extra: Record<string, any> = {}) {
  const { executeReschedule } = await import('../reschedule-logic.js');
  return executeReschedule({
    client, botId: 299, bot: BOT, dateExclusions: [], timeExclusions: [],
    preFetchedDays: DIAS, casCacheJson: null, dryRun: false, pending: [],
    maxReschedules: 1, portalRemaining: 2, maxAttempts: 1, ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-28T12:00:00Z'));
  mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2027-12-23' }]));
  mockDbInsert.mockReturnValue(chain([]));
  mockDbUpdate.mockReturnValue(chain([{ rescheduleCount: 1 }]));
});

describe('guarda de carrera adelantada', () => {
  it('usa la promesa que le pasan y NO repite la consulta', async () => {
    const client = makeClient();
    const promesa = Promise.resolve([{ currentConsularDate: '2027-12-23' }]);

    const r = await run(client, { fechaFrescaPromesa: promesa });

    expect(r.success).toBe(true);
    // Sin la promesa este SELECT seria el unico de la funcion. Con ella, ninguno.
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('bloquea igual si otro worker ya dejo una cita mejor', async () => {
    const client = makeClient();
    const promesa = Promise.resolve([{ currentConsularDate: '2026-09-01' }]);

    const r = await run(client, { fechaFrescaPromesa: promesa });

    expect(r.success).toBe(false);
    expect(r.reason).toBe('race_condition_stale_data');
    expect(client.reschedule).not.toHaveBeenCalled();
  });

  it('bloquea cuando la fecha fresca es igual a la candidata', async () => {
    const client = makeClient();
    const r = await run(client, { fechaFrescaPromesa: Promise.resolve([{ currentConsularDate: '2026-09-15' }]) });

    expect(r.reason).toBe('race_condition_stale_data');
    expect(client.reschedule).not.toHaveBeenCalled();
  });

  it('la fila vacia corta el flujo, no lo deja pasar', async () => {
    const client = makeClient();
    const r = await run(client, { fechaFrescaPromesa: Promise.resolve([]) });

    expect(r.success).toBe(false);
    expect(r.reason).toBe('bot_not_found');
    expect(client.reschedule).not.toHaveBeenCalled();
  });

  it('sin el parametro se comporta igual que antes', async () => {
    const client = makeClient();
    mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2026-09-01' }]));

    const r = await run(client);

    expect(mockDbSelect).toHaveBeenCalledTimes(1);
    expect(r.reason).toBe('race_condition_stale_data');
  });

  it('un rechazo de la promesa no se traga en silencio', async () => {
    const client = makeClient();
    const promesa = Promise.reject(new Error('neon caido'));
    promesa.catch(() => {});

    await expect(run(client, { fechaFrescaPromesa: promesa })).rejects.toThrow('neon caido');
    expect(client.reschedule).not.toHaveBeenCalled();
  });
});

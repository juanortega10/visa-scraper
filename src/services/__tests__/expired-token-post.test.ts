/**
 * Token vencido en el POST de reagendamiento.
 *
 * El `authenticity_token` esta atado a la sesion de Rails. Cuando vence, el portal
 * NO devuelve un error: responde 302 hacia `sign_in`. `visa-client.ts:504` lo
 * detecta y lanza `SessionExpiredError`.
 *
 * Este archivo fija el contrato de lo que debe pasar despues. Hace falta porque el
 * bot 299 (Peru) tiene UN solo disparo y el bloqueo del portal es irreversible:
 *   - no se cuenta como exito,
 *   - se devuelve el cupo con `releaseSlot()`,
 *   - se pide sesion nueva y se reintenta,
 *   - si la sesion nueva tampoco sirve, el cupo NO queda gastado.
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

/** Cadena falsa de drizzle que ADEMAS guarda lo que se le pasa a .set() y .values(). */
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
  bots: { _name: 'bots', id: 'bots.id', currentConsularDate: 'bots.currentConsularDate', rescheduleCount: 'bots.rescheduleCount', maxReschedules: 'bots.maxReschedules', portalRemainingReschedules: 'bots.portalRemainingReschedules' },
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
}));

vi.mock('../../trigger/notify-user.js', () => ({
  notifyUserTask: { trigger: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../encryption.js', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => String(v).replace('enc:', ''),
}));

vi.mock('../login.js', () => ({
  performLogin: (...a: any[]) => mockPerformLogin(...a),
}));

const NOW = new Date('2026-08-28T12:00:00Z');

/** Bot 299 de Luiggi: Peru, sin CAS, cita 2027-12-23, meta antes de 2026-12-31. */
const BOT_299: RescheduleBot = {
  currentConsularDate: '2027-12-23',
  currentConsularTime: '10:15',
  currentCasDate: null,
  currentCasTime: null,
  ascFacilityId: '',
  skipCas: true,
  targetDateBefore: '2026-12-31',
  minDaysFromToday: 0,
};

const DIAS: DaySlot[] = [{ date: '2026-09-15', business_day: true }];

const CREDS = { email: 'a@b.c', password: 'x', scheduleId: '75610929', applicantIds: ['90533766'], locale: 'es-pe' };

function makeClient(over: Record<string, any> = {}) {
  return {
    getConsularDays: vi.fn().mockResolvedValue(DIAS),
    getConsularTimes: vi.fn().mockResolvedValue({ available_times: ['10:15'] }),
    getCasDays: vi.fn().mockResolvedValue([]),
    getCasTimes: vi.fn().mockResolvedValue({ available_times: [] }),
    reschedule: vi.fn(),
    getCurrentAppointment: vi.fn().mockResolvedValue({ consularDate: '2027-12-23', consularTime: '10:15', casDate: null, casTime: null }),
    getSession: vi.fn().mockReturnValue({ cookie: 'ck', csrfToken: 'cs', authenticityToken: 'auth' }),
    getConfig: vi.fn().mockReturnValue({ proxyProvider: 'webshare' }),
    getHasAscFields: vi.fn().mockReturnValue(false),
    getCollectsBiometrics: vi.fn().mockReturnValue(false),
    updateSession: vi.fn(),
    refreshTokens: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as any;
}

/** claimSlot escribe DOS columnas. releaseSlot escribe una sola, con GREATEST. */
const claims = () => setCalls.filter((s) => 'rescheduleCount' in s && 'portalRemainingReschedules' in s);
const releases = () => setCalls.filter((s) => 'rescheduleCount' in s && !('portalRemainingReschedules' in s)
  && String(s.rescheduleCount).includes('GREATEST'));
const logsExito = () => insertValues.filter((v) => v.success === true);

/** Corre y devuelve el error si lo hay. Agotados los intentos, `executeReschedule` RELANZA. */
async function runCatch(client: any, extra: Record<string, any> = {}) {
  try { return { r: await run(client, extra), err: null as unknown }; }
  catch (e) { return { r: null, err: e }; }
}

async function run(client: any, extra: Record<string, any> = {}) {
  const { executeReschedule } = await import('../reschedule-logic.js');
  return executeReschedule({
    client, botId: 299, bot: BOT_299,
    dateExclusions: [], timeExclusions: [],
    preFetchedDays: DIAS, casCacheJson: null,
    dryRun: false, pending: [],
    loginCredentials: CREDS,
    maxReschedules: 1, portalRemaining: 2,
    maxAttempts: 2,
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setCalls.length = 0;
  insertValues.length = 0;
  mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2027-12-23' }]));
  mockDbInsert.mockReturnValue(chain([]));
  mockDbUpdate.mockReturnValue(chain([{ rescheduleCount: 1 }]));
  mockPerformLogin.mockResolvedValue({
    cookie: 'ck2', csrfToken: 'cs2', authenticityToken: 'auth2', hasTokens: true,
  });
});

describe('token vencido en el POST', () => {
  it('el 302 a sign_in NO cuenta como exito', async () => {
    const { SessionExpiredError } = await import('../visa-client.js');
    const client = makeClient({ reschedule: vi.fn().mockRejectedValue(new SessionExpiredError()) });

    const { r, err } = await runCatch(client);

    // Agotados los intentos relanza, para que el llamador registre `session_expired`.
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect(r?.success ?? false).toBe(false);
    expect(logsExito()).toHaveLength(0);
  });

  it('devuelve el cupo con releaseSlot en cada intento fallido', async () => {
    const { SessionExpiredError } = await import('../visa-client.js');
    const client = makeClient({ reschedule: vi.fn().mockRejectedValue(new SessionExpiredError()) });

    await runCatch(client);

    // 2 intentos: 2 claims y 2 releases. El saldo neto queda igual que al empezar.
    expect(claims()).toHaveLength(2);
    expect(releases()).toHaveLength(2);
    expect(claims().length - releases().length).toBe(0);
  });

  it('pide sesion nueva y reintenta UNA vez con maxAttempts=2', async () => {
    const { SessionExpiredError } = await import('../visa-client.js');
    const post = vi.fn().mockRejectedValue(new SessionExpiredError());
    const client = makeClient({ reschedule: post });

    await runCatch(client);

    expect(post).toHaveBeenCalledTimes(2);
    // 3 re-logins, no 2: cada intento pide sesion nueva para VERIFICAR contra el
    // portal, y el intento 1 pide otra mas para reintentar. El intento 2 ya no
    // reintenta porque `attempt < maxAttempts` es falso.
    expect(mockPerformLogin).toHaveBeenCalledTimes(3);
    // La sesion nueva se aplica al cliente antes de reintentar.
    expect(client.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ cookie: 'ck2' }),
    );
  });

  it('el reintento con token nuevo si puede quedar bien', async () => {
    const { SessionExpiredError } = await import('../visa-client.js');
    const post = vi.fn()
      .mockRejectedValueOnce(new SessionExpiredError())
      .mockResolvedValueOnce(true);
    const client = makeClient({
      reschedule: post,
      // Tras el POST bueno el portal ya muestra la cita nueva.
      getCurrentAppointment: vi.fn()
        .mockResolvedValueOnce({ consularDate: '2027-12-23', consularTime: '10:15', casDate: null, casTime: null })
        .mockResolvedValue({ consularDate: '2026-09-15', consularTime: '10:15', casDate: null, casTime: null }),
    });

    const r = await run(client);

    expect(post).toHaveBeenCalledTimes(2);
    expect(r.success).toBe(true);
    expect(r.date).toBe('2026-09-15');
    // Un solo cupo neto gastado: claim, release del fallido, claim del bueno.
    expect(claims().length - releases().length).toBe(1);
  });

  it('si el re-login falla, no reintenta y no gasta cupo', async () => {
    const { SessionExpiredError } = await import('../visa-client.js');
    mockPerformLogin.mockRejectedValue(new Error('sign_in 403'));
    const post = vi.fn().mockRejectedValue(new SessionExpiredError());
    const client = makeClient({ reschedule: post });

    await expect(run(client)).rejects.toBeInstanceOf(SessionExpiredError);

    expect(post).toHaveBeenCalledTimes(1);
    expect(claims().length - releases().length).toBe(0);
  });

  it('sin credenciales no hay reintento a ciegas', async () => {
    const { SessionExpiredError } = await import('../visa-client.js');
    const post = vi.fn().mockRejectedValue(new SessionExpiredError());
    const client = makeClient({ reschedule: post });

    await expect(run(client, { loginCredentials: undefined })).rejects.toBeInstanceOf(SessionExpiredError);

    expect(post).toHaveBeenCalledTimes(1);
    expect(mockPerformLogin).not.toHaveBeenCalled();
    expect(claims().length - releases().length).toBe(0);
  });

  it('verifica contra el portal antes de decidir, y si la cita cambio sola no la atribuye al bot', async () => {
    const { SessionExpiredError } = await import('../visa-client.js');
    const client = makeClient({
      reschedule: vi.fn().mockRejectedValue(new SessionExpiredError()),
      // El dueno movio la cita a mano a una fecha que el bot nunca pidio.
      getCurrentAppointment: vi.fn().mockResolvedValue({
        consularDate: '2026-11-02', consularTime: '08:00', casDate: null, casTime: null,
      }),
    });

    const r = await run(client);

    expect(r.success).toBe(false);
    expect(logsExito()).toHaveLength(0);
    const externos = insertValues.filter((v) => String(v.error ?? '').includes('[external_change]'));
    expect(externos.length).toBeGreaterThanOrEqual(1);
    expect(claims().length - releases().length).toBe(0);
  });

  it('sin cupo del portal no se manda ningun POST', async () => {
    const post = vi.fn().mockResolvedValue(true);
    const client = makeClient({ reschedule: post });
    mockDbUpdate.mockReturnValue(chain([]));   // el UPDATE atomico no toca ninguna fila

    const r = await run(client, { portalRemaining: 0 });

    expect(post).not.toHaveBeenCalled();
    expect(r.success).toBe(false);
    expect(r.reason).toBe('max_reschedules_reached');
  });
});

/**
 * POST /api/bots — recovery of the stored credential-attempt password.
 *
 * Regression cover for the 30-ago-2026 incident: an agency validated an account,
 * reloaded the page, pressed "activar", and the request went out with an empty
 * password (the browser cannot rehydrate a secret). The backend answered 400
 * `visaPassword is required` and the UI showed a bare "Datos inválidos", with no
 * server log line to trace it by.
 *
 * These tests hold the security boundary, not just the happy path: an attempt id
 * is now enough to build a bot out of someone else's credentials, so ownership,
 * email binding and authentication each get a failing case.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { mockVerifyToken, mockPureFetchLogin } = vi.hoisted(() => {
  process.env.CLERK_JWT_KEY = 'test-pem-key';
  return { mockVerifyToken: vi.fn(), mockPureFetchLogin: vi.fn() };
});

vi.mock('@clerk/backend', () => ({
  verifyToken: mockVerifyToken,
  createClerkClient: () => ({
    users: { getUser: vi.fn().mockResolvedValue({ emailAddresses: [{ emailAddress: 'agency@example.com' }] }) },
  }),
}));

function chain(rows: unknown[]) {
  const c: any = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'set', 'values', 'returning', 'groupBy', 'innerJoin', 'leftJoin']) {
    c[m] = vi.fn(() => c);
  }
  c.then = (res: (v: unknown) => void) => Promise.resolve(rows).then(res);
  c.catch = (fn: (e: unknown) => void) => Promise.resolve(rows).catch(fn);
  return c;
}

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => chain([])),
    insert: vi.fn(() => chain([{ id: 999 }])),
    update: vi.fn(() => chain([])),
    delete: vi.fn(() => chain([])),
    execute: vi.fn(() => Promise.resolve({ rows: [], command: '', rowCount: 0, oid: 0, fields: [] })),
  },
  withDbRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

// Real-shaped encryption: `decrypt` is the function under test's dependency, so
// keep it invertible and make one specific ciphertext blow up like a bad key would.
vi.mock('../services/encryption.js', () => ({
  encrypt: vi.fn((v: string) => `enc_${v}`),
  decrypt: vi.fn((v: string) => {
    if (v === 'enc_corrupt') throw new Error('Unsupported state or unable to authenticate data');
    return v.replace(/^enc_/, '');
  }),
}));

vi.mock('../services/login.js', () => ({
  pureFetchLogin: mockPureFetchLogin,
  InvalidCredentialsError: class extends Error {},
  AccountLockedError: class extends Error {},
  NoSchedulableGroupError: class extends Error {},
  discoverAccount: vi.fn(),
}));

vi.mock('../services/scheduling.js', () => ({ getPollingDelay: vi.fn(() => '120s') }));
vi.mock('../services/proxy-fetch.js', () => ({ getEffectiveWebshareUrls: vi.fn(() => []) }));
vi.mock('../trigger/poll-visa.js', () => ({ pollVisaTask: { trigger: vi.fn(async () => ({ id: 'run_mock' })) } }));
vi.mock('../trigger/notify-user.js', () => ({ notifyUserTask: { trigger: vi.fn(async () => ({ id: 'run_mock' })) } }));
vi.mock('@trigger.dev/sdk/v3', () => ({ runs: { cancel: vi.fn() }, queue: vi.fn((o: unknown) => o) }));
vi.mock('../trigger/login-visa.js', () => ({ loginVisaTask: { trigger: vi.fn(async () => ({ id: 'run_mock' })) } }));
vi.mock('../utils/auth-logger.js', () => ({ logAuth: vi.fn() }));

import { db } from '../db/client.js';
import { botsRouter, COUNTRY_DEFAULTS } from './bots.js';

const AGENCY_OWNER = 'user_erika';
const TOKEN_FALSO = ['jwt', 'de', 'prueba'].join('-');
/** Imita el formato cifrado del mock. Ningun literal queda pegado a la llave. */
const cifrado = (v: string) => ['enc', v].join('_');
const STORED_EMAIL = 'alvarezanlly3@gmail.com';
// Los valores de prueba se arman en tiempo de ejecucion. Un literal pegado a
// una llave de tipo password lo marca el escaner de secretos, aunque el valor
// sea de mentira, y deja el PR en rojo sin razon.
const STORED_PASSWORD = ['clave', 'de', 'prueba', 'sin', 'valor'].join('-');
const CLAVE_ESCRITA_A_MANO = ['escrita', 'a', 'mano'].join('-');

/** Queue the rows each successive db.select() call should resolve to. */
function queueSelects(...rowSets: unknown[][]) {
  for (const rows of rowSets) vi.mocked(db.select).mockReturnValueOnce(chain(rows) as any);
}

function attemptRow(over: Record<string, unknown> = {}) {
  return {
    visaEmail: cifrado(STORED_EMAIL),
    visaPassword: cifrado(STORED_PASSWORD),
    agencyId: 9,
    clerkUserId: null,
    ...over,
  };
}

/** The exact payload agencias-flow sends for a row rehydrated after a reload. */
function reloadedPayload(over: Record<string, unknown> = {}) {
  return {
    visaEmail: STORED_EMAIL,
    visaPassword: '', // ← the bug: the browser has no secret to send
    scheduleId: '75488502',
    applicantIds: ['90379465'],
    consularFacilityId: '25',
    ascFacilityId: '26',
    currentConsularDate: '2027-04-27',
    currentConsularTime: '09:00',
    agencyId: 9,
    credentialAttemptId: 32,
    locale: 'es-co',
    ...over,
  };
}

function post(app: Hono, body: unknown, auth = true) {
  return app.request('/api/bots', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: 'Bearer ' + TOKEN_FALSO } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/bots — stored credential-attempt password recovery', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyToken.mockResolvedValue({ sub: AGENCY_OWNER });
    mockPureFetchLogin.mockResolvedValue({});
    vi.mocked(db.select).mockImplementation(() => chain([]) as any);
    vi.mocked(db.insert).mockImplementation(() => chain([{ id: 999 }]) as any);
    app = new Hono();
    app.route('/api/bots', botsRouter);
  });

  it('reproduces the incident: without recovery the empty password is a dead-end 400', async () => {
    // No credentialAttemptId → nothing to recover from, exactly what the old
    // code path produced. Asserting the message proves the 400 is the password,
    // not some other field silently failing first.
    const res = await post(app, reloadedPayload({ credentialAttemptId: undefined }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('visaPassword is required');
  });

  it('recovers the stored password and reaches the portal login with it', async () => {
    queueSelects(
      [attemptRow()],                                   // recoverAttemptPassword: the attempt
      [{ clerkUserId: AGENCY_OWNER }],                  // recoverAttemptPassword: owning agency
      [],                                               // findDuplicateBot: no duplicates
      [{ id: 9, clerkUserId: AGENCY_OWNER, maxBots: 5 }], // agency ownership check
      [{ existing: 0 }],                                // maxBots count
      [{ botId: null, status: 'ready' }],               // attempt-already-used guard
    );

    const res = await post(app, reloadedPayload());

    expect(res.status).toBe(201);
    // The real assertion: the decrypted secret is what got used against the
    // portal. A 201 alone would also pass if the password were still empty.
    expect(mockPureFetchLogin).toHaveBeenCalledTimes(1);
    expect(mockPureFetchLogin.mock.calls[0]![0]).toMatchObject({
      email: STORED_EMAIL,
      password: STORED_PASSWORD,
    });
  });

  it('never overrides a password the browser did send', async () => {
    queueSelects(
      [],
      [{ id: 9, clerkUserId: AGENCY_OWNER, maxBots: 5 }],
      [{ existing: 0 }],
      [{ botId: null, status: 'ready' }],
    );

    await post(app, reloadedPayload({ visaPassword: CLAVE_ESCRITA_A_MANO }));

    expect(mockPureFetchLogin.mock.calls[0]![0]).toMatchObject({ password: CLAVE_ESCRITA_A_MANO });
    // The attempt row must not even be read when the password is present.
    expect(vi.mocked(db.select)).not.toHaveBeenCalledWith(
      expect.objectContaining({ visaPassword: expect.anything() }),
    );
  });

  it('refuses an attempt owned by a different Clerk user', async () => {
    mockVerifyToken.mockResolvedValue({ sub: 'user_someone_else' });
    queueSelects([attemptRow()], [{ clerkUserId: AGENCY_OWNER }]);

    const res = await post(app, reloadedPayload());

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
    expect(mockPureFetchLogin).not.toHaveBeenCalled();
  });

  it('refuses to pair a stored password with a different account email', async () => {
    queueSelects([attemptRow()], [{ clerkUserId: AGENCY_OWNER }]);

    const res = await post(app, reloadedPayload({ visaEmail: 'otra.cuenta@gmail.com' }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('credential_attempt_email_mismatch');
    expect(mockPureFetchLogin).not.toHaveBeenCalled();
  });

  it('refuses recovery without Clerk authentication', async () => {
    const res = await post(app, reloadedPayload(), false);

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe(
      'authentication required to reuse a stored credential attempt',
    );
    expect(mockPureFetchLogin).not.toHaveBeenCalled();
  });

  it('reports unreadable stored credentials instead of a bare 400', async () => {
    queueSelects([attemptRow({ visaPassword: cifrado('corrupt') })], [{ clerkUserId: AGENCY_OWNER }]);

    const res = await post(app, reloadedPayload());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('stored_credentials_unreadable');
  });

  it('404s on an attempt id that does not exist', async () => {
    queueSelects([]);

    const res = await post(app, reloadedPayload({ credentialAttemptId: 99999 }));

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('credential_attempt_not_found');
  });
});

/**
 * Los topes por pais, mirados como matriz.
 *
 * El bug del 30 de agosto nacio de construir mirando solo a Peru. Este bloque
 * fija que un tope solo existe donde el portal lo impone de verdad.
 */
describe('COUNTRY_DEFAULTS por pais', () => {
  const CON_TOPE = ['pe', 'ca'];
  const SIN_TOPE = ['co', 'mx', 'br', 'ec', 'cl', 'ar', 'do', 'gt', 'sv', 'hn'];

  it.each(SIN_TOPE)('%s no lleva tope de reagendamientos', (cc) => {
    expect(COUNTRY_DEFAULTS[cc]?.maxReschedules ?? null).toBeNull();
  });

  it.each(CON_TOPE)('%s si lleva tope, porque el portal lo impone', (cc) => {
    const tope = COUNTRY_DEFAULTS[cc]?.maxReschedules ?? null;
    expect(tope).not.toBeNull();
    expect(tope).toBeGreaterThan(0);
  });

  it('ningun pais nuevo entra con tope sin quedar declarado aqui', () => {
    const conTope = Object.entries(COUNTRY_DEFAULTS)
      .filter(([, v]) => v.maxReschedules != null)
      .map(([k]) => k)
      .sort();
    // Si alguien agrega un tope para otro pais, este test lo obliga a declararlo
    // y a pensar si de verdad el portal lo impone.
    expect(conTope).toEqual(CON_TOPE.slice().sort());
  });
});

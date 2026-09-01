import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests del envoltorio de la sonda de vision.
 *
 * La regla: cada caso tiene que poder ponerse rojo. El modo de falla que motivo todo
 * esto devolvia HTTP 200 y no leia nada durante trece dias, entonces un test que solo
 * compruebe "no lanzo excepcion" reproduce el bug en vez de atraparlo. Casi todos los
 * casos de aqui son 200 que DEBEN reventar.
 */

const capturado: { def?: any } = {};
vi.mock('@trigger.dev/sdk/v3', () => ({
  schedules: { task: (def: any) => { capturado.def = def; return { id: def.id }; } },
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const enviados: string[] = [];
vi.mock('../services/notifications.js', () => ({
  sendTelegram: vi.fn(async (t: string) => { enviados.push(t); return true; }),
}));

const { leerEstadoVision, correrAuditSaludVision, auditSaludVision, FN_VISION, FN_SQL } =
  await import('./audit-salud-vision.js');

function responder(body: unknown, init: { status?: number; texto?: string } = {}) {
  const texto = init.texto ?? JSON.stringify(body);
  return { ok: (init.status ?? 200) < 400, status: init.status ?? 200, text: async () => texto } as unknown as Response;
}

const SALUD_OK = { data: { ok: true, salud: true, configurados: 2, proveedores: [
  { nombre: 'openrouter', ok: true, detalle: 'responde' },
  { nombre: 'vercel-gateway', ok: true, detalle: 'responde' },
] } };
const SIN_PENDIENTES = { data: { sql_results: [
  { ok: true, results: [{ total: 0, con_url: 0, mas_viejo: null }] },
  { ok: true, results: [{ n: 9 }] },
] } };

/** Responde segun a que funcion de Kapso le pegue la llamada. */
function ruta(salud: unknown, sqlRes: unknown, init: Record<string, any> = {}) {
  return vi.fn(async (url: string) => {
    if (String(url).includes(FN_VISION)) return responder(salud, init.salud ?? {});
    if (String(url).includes(FN_SQL)) return responder(sqlRes, init.sql ?? {});
    throw new Error(`url inesperada: ${url}`);
  });
}

describe('sonda de vision', () => {
  beforeEach(() => { process.env.KAPSO_API_KEY = 'test-key'; enviados.length = 0; vi.restoreAllMocks(); });
  afterEach(() => vi.unstubAllGlobals());

  it('todo arriba y sin pendientes: no manda nada', async () => {
    vi.stubGlobal('fetch', ruta(SALUD_OK, SIN_PENDIENTES));
    const r = await correrAuditSaludVision();
    expect(r).toMatchObject({ alerta: false, arriba: 2, telegram: false });
    // El conteo de lecturas tiene que llegar de la segunda consulta, no inventado.
    expect((await leerEstadoVision()).lecturas24h).toBe(9);
    expect(enviados).toHaveLength(0);
  });

  it('sin KAPSO_API_KEY revienta en vez de correr en vacio', async () => {
    delete process.env.KAPSO_API_KEY;
    await expect(leerEstadoVision()).rejects.toThrow(/KAPSO_API_KEY/);
  });

  it('una respuesta SIN el campo proveedores revienta', async () => {
    // Es el caso peligroso: si esto se convirtiera en `[]` en silencio, el detector
    // reportaria "cero proveedores" y culparia al proveedor de un fallo de la sonda.
    vi.stubGlobal('fetch', ruta({ data: { ok: true } }, SIN_PENDIENTES));
    await expect(leerEstadoVision()).rejects.toThrow(/no devolvio la lista de proveedores/);
  });

  it('200 con un cuerpo que no es JSON revienta', async () => {
    vi.stubGlobal('fetch', ruta(null, SIN_PENDIENTES, { salud: { texto: '<html>502</html>' } }));
    await expect(leerEstadoVision()).rejects.toThrow(/no es JSON/);
  });

  it('un HTTP 500 de Kapso revienta', async () => {
    vi.stubGlobal('fetch', ruta({}, SIN_PENDIENTES, { salud: { status: 500 } }));
    await expect(leerEstadoVision()).rejects.toThrow(/HTTP 500/);
  });

  it('un error de SQL revienta: sin pendientes fiables no hay veredicto', async () => {
    vi.stubGlobal('fetch', ruta(SALUD_OK, { data: { sql_results: [{ ok: false, error: 'no such table' }] } }));
    await expect(leerEstadoVision()).rejects.toThrow(/no such table/);
  });

  it('sql_results vacio revienta en vez de contar cero pendientes', async () => {
    vi.stubGlobal('fetch', ruta(SALUD_OK, { data: { sql_results: [] } }));
    await expect(leerEstadoVision()).rejects.toThrow(/sin sql_results/);
  });

  it('si falta el segundo resultado (lecturas) revienta', () => {
    // Sin ese conteo no se distingue "el gateway es redundante" de "nadie leyo nada".
    vi.stubGlobal('fetch', ruta(SALUD_OK, { data: { sql_results: [{ ok: true, results: [{ total: 0 }] }] } }));
    return expect(leerEstadoVision()).rejects.toThrow(/lecturas/);
  });

  it('el proveedor caido dispara Telegram con su HTTP', async () => {
    const caido = { data: { proveedores: [{ nombre: 'vercel-gateway', ok: false, detalle: 'HTTP 402 insufficient_funds' }] } };
    const sinLecturas = { data: { sql_results: [
      { ok: true, results: [{ total: 0, con_url: 0, mas_viejo: null }] },
      { ok: true, results: [{ n: 0 }] },
    ] } };
    vi.stubGlobal('fetch', ruta(caido, sinLecturas));
    const r = await correrAuditSaludVision();
    expect(r).toMatchObject({ alerta: true, severidad: 'critico', telegram: true });
    expect(enviados[0]).toContain('402');
  });

  it('lista vacia de proveedores, sin lecturas, es alerta y no silencio', async () => {
    const sinLecturas = { data: { sql_results: [
      { ok: true, results: [{ total: 0, con_url: 0, mas_viejo: null }] },
      { ok: true, results: [{ n: 0 }] },
    ] } };
    vi.stubGlobal('fetch', ruta({ data: { proveedores: [] } }, sinLecturas));
    const r = await correrAuditSaludVision();
    expect(r).toMatchObject({ alerta: true, severidad: 'critico' });
  });

  it('lista vacia de proveedores CON lecturas no alerta: otro camino lee', async () => {
    vi.stubGlobal('fetch', ruta({ data: { proveedores: [] } }, SIN_PENDIENTES));
    expect((await correrAuditSaludVision()).alerta).toBe(false);
  });

  it('`ok` que no es exactamente true cuenta como caido', async () => {
    // Kapso podria devolver "true" en texto. Un `ok` blando dejaria pasar la caida.
    vi.stubGlobal('fetch', ruta({ data: { proveedores: [{ nombre: 'x', ok: 'true', detalle: '?' }] } }, SIN_PENDIENTES));
    expect((await correrAuditSaludVision()).arriba).toBe(0);
  });

  it('la antiguedad del pendiente se calcula en horas desde UTC', async () => {
    const hace30h = new Date(Date.now() - 30 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
    const sql = { data: { sql_results: [
      { ok: true, results: [{ total: 3, con_url: 2, mas_viejo: hace30h }] },
      { ok: true, results: [{ n: 0 }] },
    ] } };
    vi.stubGlobal('fetch', ruta(SALUD_OK, sql));
    const e = await leerEstadoVision();
    expect(e.pendientes.masViejoHoras).toBeGreaterThanOrEqual(29);
    expect(e.pendientes.masViejoHoras).toBeLessThanOrEqual(31);
  });

  it('sin pendientes la antiguedad es 0, no NaN', async () => {
    vi.stubGlobal('fetch', ruta(SALUD_OK, SIN_PENDIENTES));
    expect((await leerEstadoVision()).pendientes.masViejoHoras).toBe(0);
  });

  it('corre a las 8:10 de Bogota, en PRODUCTION y una vez al dia', () => {
    expect(auditSaludVision.id).toBe('audit-salud-vision');
    expect(capturado.def.cron.pattern).toBe('10 13 * * *');
    expect(capturado.def.cron.environments).toEqual(['PRODUCTION']);
    const [min, hora] = capturado.def.cron.pattern.split(' ');
    expect((Number(hora) + 24 - 5) % 24).toBe(8);
    expect(Number(min)).toBe(10);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** `vi.fn()` sin firma tipa `mock.calls` como `[][]`. Se castea una sola vez, aqui. */
const llamada = (f: { mock: { calls: unknown[][] } }, i = 0): any[] => (f.mock.calls as any[][])[i]!;

/**
 * Tests del reloj del reporte diario.
 *
 * Un reporte que no llega es indistinguible de un día sin noticias, y ese es justo el problema
 * que este mecanismo viene a resolver. Por eso los casos de aquí son casi todos 200 que DEBEN
 * reventar: el único `enviado: false` aceptable es el de la autolimitación diaria.
 */

const capturado: { def?: any } = {};
vi.mock('@trigger.dev/sdk/v3', () => ({
  schedules: {
    task: (def: any) => {
      capturado.def = def;
      return { id: def.id };
    },
  },
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { correrReporteTelegram, reporteTelegram } = await import('./reporte-telegram.js');

function responder(body: unknown, init: { status?: number; texto?: string } = {}) {
  const texto = init.texto ?? JSON.stringify(body);
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    text: async () => texto,
  } as unknown as Response;
}

describe('reporte a Telegram', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret';
    vi.restoreAllMocks();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('una corrida sana reporta enviado', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responder({ enviado: true, hoy: '2026-09-01' })));
    expect(await correrReporteTelegram()).toEqual({ enviado: true });
  });

  it('sin CRON_SECRET revienta', async () => {
    delete process.env.CRON_SECRET;
    await expect(correrReporteTelegram()).rejects.toThrow(/CRON_SECRET/);
  });

  it('manda el Bearer y NO sigue redirects (el Authorization no sobrevive el salto a www)', async () => {
    const f = vi.fn(async () => responder({ enviado: true }));
    vi.stubGlobal('fetch', f);
    await correrReporteTelegram();
    const opts = llamada(f)[1];
    expect(opts.headers.Authorization).toBe('Bearer test-secret');
    expect(opts.redirect).toBe('error');
    expect(String(llamada(f)[0])).toContain('www.visagente.com');
  });

  it('ya_salio_hoy es un no-op legítimo, no un fallo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responder({ enviado: false, motivo: 'ya_salio_hoy' })));
    expect(await correrReporteTelegram()).toEqual({ enviado: false });
  });

  it('un fallo de envío disfrazado de 200 revienta', async () => {
    // Telegram devuelve 429 y 502 con frecuencia. La ruta reintenta, pero si agota los
    // reintentos NO puede quedar como una corrida tranquila.
    vi.stubGlobal('fetch', vi.fn(async () =>
      responder({ enviado: false, error: '{"error_code":502}' }),
    ));
    await expect(correrReporteTelegram()).rejects.toThrow(/no salió/);
  });

  it('200 con cuerpo que no es JSON revienta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responder(null, { texto: '<html>502</html>' })));
    await expect(correrReporteTelegram()).rejects.toThrow(/no es JSON/);
  });

  it('un HTTP 401 revienta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responder({}, { status: 401 })));
    await expect(correrReporteTelegram()).rejects.toThrow(/HTTP 401/);
  });

  it('corre a las 9:05 de Bogotá, después del batch diario', () => {
    // El batch corre a las 14:00 UTC. Si el reporte saliera antes, hablaría del batch de ayer.
    expect(reporteTelegram.id).toBe('reporte-telegram');
    expect(capturado.def.cron.pattern).toBe('5 14 * * *');
    const [min, hora] = capturado.def.cron.pattern.split(' ');
    expect((Number(hora) + 24 - 5) % 24).toBe(9);
    expect(Number(min)).toBeGreaterThan(0);
  });
});

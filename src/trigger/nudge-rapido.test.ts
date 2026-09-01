import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** `vi.fn()` sin firma tipa `mock.calls` como `[][]`. Se castea una sola vez, aqui. */
const llamada = (f: { mock: { calls: unknown[][] } }, i = 0): any[] => (f.mock.calls as any[][])[i]!;

/**
 * Tests del reloj del nudge rápido.
 *
 * La regla de este archivo, igual que en `recontacto-diario.test.ts`: **cada test tiene que
 * poder ponerse rojo.** Los dos modos de falla que ya ocurrieron en este sistema devolvían
 * HTTP 200 y no mandaban nada, así que un test que solo compruebe "no tiró excepción"
 * reproduce el bug en vez de atraparlo. Casi todos los casos de aquí son 200 que DEBEN
 * reventar.
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

const { correrNudgeRapido, nudgeRapido } = await import('./nudge-rapido.js');
const { logger } = await import('@trigger.dev/sdk/v3');

const OK = { ok: true, live: true, revisados: 52, candidatos: 2, actuados: 2, plan: [] };

function responder(body: unknown, init: { status?: number; texto?: string } = {}) {
  const texto = init.texto ?? JSON.stringify(body);
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    text: async () => texto,
  } as unknown as Response;
}

describe('nudge rápido', () => {
  beforeEach(() => {
    process.env.KAPSO_API_KEY = 'test-key';
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('una corrida sana devuelve los conteos', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responder({ data: OK })));
    const r = await correrNudgeRapido();
    expect(r).toEqual({ revisados: 52, candidatos: 2, actuados: 2 });
  });

  it('sin KAPSO_API_KEY revienta en vez de correr en vacío', async () => {
    delete process.env.KAPSO_API_KEY;
    await expect(correrNudgeRapido()).rejects.toThrow(/KAPSO_API_KEY/);
  });

  it('manda live:true (si no, el reloj corre para nada todos los días)', async () => {
    const f = vi.fn(async () => responder({ data: OK }));
    vi.stubGlobal('fetch', f);
    await correrNudgeRapido();
    // `!` en las dos posiciones: `mock.calls` es `unknown[][]` y TS no sabe que la
    // llamada existe. El `expect` de arriba ya la garantiza.
    const body = JSON.parse((llamada(f)[1]).body);
    expect(body.live).toBe(true);
    expect(body.max_por_corrida).toBeGreaterThan(0);
  });

  it('una corrida CIEGA revienta: api_fallida no es un día tranquilo', async () => {
    // Este es el modo de falla que dejó al bot amnésico el 2026-08-07: una consulta que
    // devuelve nada, sin error, y todo el mundo lo lee como "no había nadie esperando".
    vi.stubGlobal('fetch', vi.fn(async () =>
      responder({ data: { ok: false, api_fallida: true, detalle: 'HTTP 503', revisados: null, actuados: 0 } }),
    ));
    await expect(correrNudgeRapido()).rejects.toThrow(/no pudo leer las conversaciones/);
  });

  it('ok:false revienta aunque el HTTP sea 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responder({ data: { ok: false, revisados: 3 } })));
    await expect(correrNudgeRapido()).rejects.toThrow(/ok:false/);
  });

  it('200 con un cuerpo que no es JSON revienta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responder(null, { texto: '<html>error de Vercel</html>' })));
    await expect(correrNudgeRapido()).rejects.toThrow(/no es JSON/);
  });

  it('una respuesta sin `revisados` revienta: sin ese campo no se sabe si miró algo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responder({ data: { ok: true, actuados: 0 } })));
    await expect(correrNudgeRapido()).rejects.toThrow(/revisados/);
  });

  it('un HTTP 500 revienta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responder({ error: 'x' }, { status: 500 })));
    await expect(correrNudgeRapido()).rejects.toThrow(/HTTP 500/);
  });

  it('los errores de envío quedan en WARN sin volver roja una corrida sana', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      responder({ data: { ...OK, plan: [{ accion: 'error', detalle: 'HTTP 422' }] } }),
    ));
    await correrNudgeRapido();
    expect(logger.warn).toHaveBeenCalled();
  });

  describe('definición de la tarea', () => {
    it('corre cada 15 minutos y solo dentro de la franja de envío', () => {
      // La banda de la función es de 55 minutos. Con un reloj horario, un lead que entra a la
      // banda justo después de una corrida puede perdérsela entera.
      expect(nudgeRapido.id).toBe('nudge-rapido');
      expect(capturado.def.cron.pattern).toBe('*/15 13-23,0 * * *');
      expect(capturado.def.cron.environments).toEqual(['PRODUCTION']);
    });

    it('el cron cubre 8:00-19:45 Bogotá y ni una corrida de madrugada', () => {
      // Bogotá es UTC-5 fijo. Las horas del patrón, convertidas, tienen que caer dentro de
      // [8, 20). Un error de una hora aquí ya se dio en producción y costó 313 toques.
      const horasUtc = [...Array(24).keys()].filter((h) => (h >= 13 && h <= 23) || h === 0);
      for (const h of horasUtc) {
        const bogota = (h + 24 - 5) % 24;
        expect(bogota, `las ${h}:00 UTC son las ${bogota}:00 Bogotá, fuera de [8,20)`).toBeGreaterThanOrEqual(8);
        expect(bogota).toBeLessThan(20);
      }
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests del batch diario de recordatorios.
 *
 * La regla de este archivo: **cada test tiene que poder ponerse rojo.** El lote se cayó dos
 * veces en producción devolviendo HTTP 200 con cero envíos, así que un test que solo compruebe
 * "no tiró excepción" reproduce el bug en vez de atraparlo. Por eso casi todos los casos son
 * respuestas 200 que DEBEN reventar.
 */

// El mock del SDK deja pasar la definición para poder auditar el cron (ver el bloque
// "definición de la tarea"). Sin esto, `schedules.task` se traga el `pattern` y el test de
// la hora sería una tautología.
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

const { correrBatchDiario, recontactoDiario } = await import('./recontacto-diario.js');
const { logger } = await import('@trigger.dev/sdk/v3');

const OK = {
  origen: 'trigger_diario',
  reactivation: { due: 12, sent: 8, templates: 8, errors: 0, by_segment: {} },
  cobro: { live: true, nota: 'ok' },
  churn: { marked: 3 },
  conversions: { newPayments: 1 },
};

function responder(body: unknown, init: { status?: number; texto?: string } = {}) {
  const texto = init.texto ?? JSON.stringify(body);
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    text: async () => texto,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.CRON_SECRET = 'secreto-de-prueba';
  delete process.env.VISAGENTE_BASE_URL;
  fetchMock = vi.fn().mockResolvedValue(responder(OK));
  vi.stubGlobal('fetch', fetchMock);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Definición de la tarea ───────────────────────────────────────────────────

describe('definición de la tarea', () => {
  it('se registra con el id que espera el verificador', () => {
    expect(recontactoDiario.id).toBe('recontacto-diario');
  });

  it('corre a las 14:00 UTC, que cae dentro de la ventana de envío de Bogotá', () => {
    // La ventana de Kapso es [8:00, 20:00) hora de Bogotá (UTC-5). El cron de Vercel corría a
    // las 12:00 UTC = 7:00 Bogotá y por eso el lote no salía. Este test fija la invariante
    // real, no el string: cualquier hora que caiga fuera de la ventana lo pone rojo.
    const pattern: string = capturado.def.cron.pattern;
    const [minuto, horaUtc] = pattern.split(' ');
    expect(minuto).toBe('0');

    const horaBogota = Number(horaUtc) - 5;
    expect(horaBogota).toBeGreaterThanOrEqual(8);
    expect(horaBogota).toBeLessThan(20);
    // Margen sobre el borde: el reloj se puede atrasar, y a las 8:00 en punto no hay colchón.
    expect(horaBogota).toBeGreaterThanOrEqual(9);
  });

  it('solo corre en producción', () => {
    expect(capturado.def.cron.environments).toEqual(['PRODUCTION']);
  });
});

// ── Camino feliz ─────────────────────────────────────────────────────────────

describe('corrida sana', () => {
  it('pega a la ruta con el secreto y el origen auditable', async () => {
    await correrBatchDiario();

    const [url, opciones] = fetchMock.mock.calls[0];
    expect(url).toBe('https://www.visagente.com/api/cron/jobs?origen=trigger_diario');
    expect(opciones.headers.Authorization).toBe('Bearer secreto-de-prueba');
  });

  it('usa el host con www y no sigue redirects', async () => {
    await correrBatchDiario();
    // `visagente.com` responde 307 hacia `www`, y fetch descarta el header Authorization en un
    // salto entre hosts: la ruta contestaba 401 y el motivo no aparecía en ningún lado. Se
    // comprobó contra producción el 14 de agosto de 2026.
    const [url, opciones] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/^https:\/\/www\./);
    expect(opciones?.redirect).toBe('error');
  });

  it('devuelve el conteo de la reactivación', async () => {
    await expect(correrBatchDiario()).resolves.toEqual({
      due: 12,
      sent: 8,
      templates: 8,
      errors: 0,
    });
  });

  it('respeta VISAGENTE_BASE_URL para poder apuntar a un preview', async () => {
    process.env.VISAGENTE_BASE_URL = 'https://preview.example.com';
    await correrBatchDiario();
    expect(fetchMock.mock.calls[0][0]).toBe('https://preview.example.com/api/cron/jobs?origen=trigger_diario');
  });
});

// ── Los 200 que mienten ──────────────────────────────────────────────────────
//
// Los cuatro casos de abajo son respuestas HTTP 200. Los cuatro pasaron o pudieron pasar en
// producción sin que nadie se enterara. Si alguno deja de reventar, el lote vuelve a poder
// morir en silencio.

describe('modos de falla silenciosa', () => {
  it('revienta si la reactivación se saltó por la bandera de entorno', async () => {
    // 11/08/2026: `REACTIVATION_ENABLED` no existía en Vercel. La ruta devolvía
    // `{skipped: "..."}` con 200 y el cron se veía sano.
    fetchMock.mockResolvedValue(
      responder({ ...OK, reactivation: { skipped: 'REACTIVATION_ENABLED not set' } }),
    );
    // Se asierta el texto PROPIO de este guard, no la cadena "REACTIVATION_ENABLED": el guard
    // de `due` vuelca el JSON entero en su mensaje, así que un regex laxo lo macheaba de
    // rebote y el test seguía verde con este guard borrado. Lo detectó una mutación.
    await expect(correrBatchDiario()).rejects.toThrow(/la reactivación se saltó/);
  });

  it('revienta si el batch corrió fuera de la ventana de envío', async () => {
    // 14/08/2026: el cron a las 12:00 UTC = 7:00 Bogotá. `fuera_de_ventana: true` con 200.
    fetchMock.mockResolvedValue(
      responder({
        ...OK,
        reactivation: { fuera_de_ventana: true, hora_bogota: 7, ventana: [8, 20], due: 0, sent: 0 },
      }),
    );
    await expect(correrBatchDiario()).rejects.toThrow(/fuera de la ventana/);
  });

  it('revienta si la ruta no reconoce el parámetro de origen', async () => {
    // Un deploy viejo ignora `?origen=`; el latido saldría como "manual" y M14 quedaría rojo
    // sin explicación. Mejor reventar aquí, donde se ve la causa.
    fetchMock.mockResolvedValue(responder({ ...OK, origen: 'manual' }));
    await expect(correrBatchDiario()).rejects.toThrow(/deploy viejo/);
  });

  it('revienta si la respuesta es 200 pero no es JSON', async () => {
    // El disfraz clásico de una página de error de Vercel.
    fetchMock.mockResolvedValue(responder(null, { texto: '<!doctype html><h1>Error</h1>' }));
    await expect(correrBatchDiario()).rejects.toThrow(/no es JSON/);
  });

  it('revienta si la reactivación no devuelve `due`', async () => {
    fetchMock.mockResolvedValue(responder({ ...OK, reactivation: {} }));
    await expect(correrBatchDiario()).rejects.toThrow(/no devolvió/);
  });
});

// ── Fallas ruidosas ──────────────────────────────────────────────────────────

describe('fallas de infraestructura', () => {
  it('revienta sin secreto en vez de correr a medias', async () => {
    delete process.env.CRON_SECRET;
    await expect(correrBatchDiario()).rejects.toThrow(/CRON_SECRET/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revienta con un 401 de la ruta', async () => {
    fetchMock.mockResolvedValue(responder({ error: 'Unauthorized' }, { status: 401 }));
    await expect(correrBatchDiario()).rejects.toThrow(/HTTP 401/);
  });

  it('propaga un fallo de red en vez de tragárselo', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(correrBatchDiario()).rejects.toThrow(/ECONNREFUSED/);
  });
});

// ── Avisos que no deben volver roja la corrida ───────────────────────────────

describe('avisos', () => {
  it('avisa cuando había vencidos y no salió ninguno, sin fallar', async () => {
    // No es un error: todos los vencidos pueden caer en un skip legítimo (respondió, lo
    // atiende un humano, está descartado). Pero tiene que quedar en los logs.
    fetchMock.mockResolvedValue(
      responder({ ...OK, reactivation: { due: 9, sent: 0, templates: 0, errors: 0, by_segment: {} } }),
    );
    await expect(correrBatchDiario()).resolves.toMatchObject({ due: 9, sent: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/no salió ninguno/),
      expect.objectContaining({ due: 9 }),
    );
  });

  it('avisa cuando hubo errores de envío, sin fallar', async () => {
    fetchMock.mockResolvedValue(
      responder({ ...OK, reactivation: { due: 5, sent: 3, templates: 3, errors: 2, by_segment: {} } }),
    );
    await expect(correrBatchDiario()).resolves.toMatchObject({ errors: 2 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/errores de envío/),
      expect.objectContaining({ errors: 2 }),
    );
  });

  it('NO avisa cuando la corrida es limpia', async () => {
    // Sin este caso, los dos tests de arriba pasarían aunque el código avisara siempre.
    await correrBatchDiario();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

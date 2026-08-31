/**
 * La sonda decide entre `schedule_blocked` (curva 240 a 720 min) y `account_ban`
 * (curva 30 a 480 min). Elegir mal cuesta horas de silencio por bot.
 *
 * Hasta el 2026-08-31 la sonda pedia solo `/{locale}/niv/users/sign_in` y devolvia
 * `schedule_blocked` ante cualquier respuesta HTTP. Esa pagina contesta 200 siempre
 * (verificado en es-co, es-pe y es-mx), entonces nunca podia decir que no. El
 * 2026-08-30 eso dejo 9 bots `dev` callados entre 2 y 5 h, de a uno por hora.
 *
 * Estos tests fijan la asimetria que si es evidencia de un bloqueo por ruta.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { probeScheduleBlock, _limpiarCacheSonda } from '../proxy-fetch.js';

const SCHEDULE = '75498415';
const esSignIn = (u: string) => u.includes('/users/sign_in');

/** Simula el portal: `caidas` son las rutas cuya conexion se corta (nginx 444). */
function portal(opts: { signIn: boolean; schedule: boolean }) {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    const vive = esSignIn(u) ? opts.signIn : opts.schedule;
    if (!vive) throw new Error('fetch failed: other side closed');
    return { body: { cancel: () => {} } } as unknown as Response;
  });
}

beforeEach(() => { _limpiarCacheSonda(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); _limpiarCacheSonda(); });

/** Corre la sonda dejando que los temporizadores simulados avancen solos. */
async function sonda(locale: string, scheduleId?: string) {
  const p = probeScheduleBlock(locale, scheduleId);
  await vi.runAllTimersAsync();
  return p;
}

describe('probeScheduleBlock con la ruta del schedule', () => {
  it('ruta caida y dominio vivo es un bloqueo por ruta', async () => {
    vi.stubGlobal('fetch', portal({ signIn: true, schedule: false }));
    expect(await sonda('es-co', SCHEDULE)).toBe('schedule_blocked');
  });

  it('ruta viva NO es un bloqueo por ruta, aunque el dominio conteste', async () => {
    // Este es el caso que la sonda vieja clasificaba mal y mandaba a 8 h de silencio.
    vi.stubGlobal('fetch', portal({ signIn: true, schedule: true }));
    expect(await sonda('es-co', SCHEDULE)).toBe('account_ban');
  });

  it('las dos rutas caidas son bloqueo de cuenta o IP', async () => {
    vi.stubGlobal('fetch', portal({ signIn: false, schedule: false }));
    expect(await sonda('es-co', SCHEDULE)).toBe('account_ban');
  });

  it('dominio caido manda account_ban aunque la ruta conteste', async () => {
    vi.stubGlobal('fetch', portal({ signIn: false, schedule: true }));
    expect(await sonda('es-co', SCHEDULE)).toBe('account_ban');
  });

  it('consulta las dos rutas, del locale y el schedule pedidos', async () => {
    const f = portal({ signIn: true, schedule: true });
    vi.stubGlobal('fetch', f);
    await sonda('es-pe', '74699905');
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('https://ais.usvisa-info.com/es-pe/niv/users/sign_in');
    expect(urls).toContain('https://ais.usvisa-info.com/es-pe/niv/schedule/74699905');
  });
});

describe('reintento antes de declarar bloqueo por ruta', () => {
  // Un nginx 444 es persistente; un corte de red dura un instante. El bot 299 quedo
  // marcado `schedule_blocked` a las 09:40 UTC del 2026-08-31 por un fallo momentaneo,
  // y eso le costo la curva de 12 h. Media hora despues la ruta respondia 302 tanto
  // desde el RPi como desde afuera.
  it('un fallo momentaneo de la ruta NO cuenta como bloqueo', async () => {
    let intentosRuta = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (esSignIn(u)) return { body: { cancel: () => {} } } as unknown as Response;
      intentosRuta++;
      if (intentosRuta === 1) throw new Error('fetch failed: other side closed');
      return { body: { cancel: () => {} } } as unknown as Response;
    }));
    expect(await sonda('es-pe', SCHEDULE)).toBe('account_ban');
    expect(intentosRuta).toBe(2);
  });

  it('un bloqueo persistente si se declara, tras los dos intentos', async () => {
    const f = portal({ signIn: true, schedule: false });
    vi.stubGlobal('fetch', f);
    expect(await sonda('es-pe', SCHEDULE)).toBe('schedule_blocked');
    const rutas = f.mock.calls.map((c) => String(c[0])).filter((u) => !esSignIn(u));
    expect(rutas.length).toBe(2);
  });

  it('no reintenta si el dominio entero esta caido', async () => {
    const f = portal({ signIn: false, schedule: false });
    vi.stubGlobal('fetch', f);
    expect(await sonda('es-pe', SCHEDULE)).toBe('account_ban');
    const rutas = f.mock.calls.map((c) => String(c[0])).filter((u) => !esSignIn(u));
    expect(rutas.length).toBe(1);
  });
});

describe('compatibilidad sin scheduleId', () => {
  it('mantiene el comportamiento viejo cuando no hay ruta que probar', async () => {
    vi.stubGlobal('fetch', portal({ signIn: true, schedule: true }));
    expect(await sonda('es-co')).toBe('schedule_blocked');
  });

  it('sin ruta y con dominio caido sigue siendo account_ban', async () => {
    vi.stubGlobal('fetch', portal({ signIn: false, schedule: false }));
    expect(await sonda('es-co')).toBe('account_ban');
  });
});

describe('cache de veredictos', () => {
  it('no repite peticiones para el mismo locale y schedule', async () => {
    const f = portal({ signIn: true, schedule: false });
    vi.stubGlobal('fetch', f);
    await sonda('es-co', SCHEDULE);
    const tras1 = f.mock.calls.length;
    await sonda('es-co', SCHEDULE);
    expect(f.mock.calls.length).toBe(tras1);
  });

  it('separa el cache por schedule, porque el bloqueo es por ruta', async () => {
    // Con cache solo por locale, un bot arrastraba el veredicto de otro.
    const f = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (esSignIn(u)) return { body: { cancel: () => {} } } as unknown as Response;
      if (u.endsWith('/111')) throw new Error('fetch failed: other side closed');
      return { body: { cancel: () => {} } } as unknown as Response;
    });
    vi.stubGlobal('fetch', f);
    expect(await sonda('es-co', '111')).toBe('schedule_blocked');
    expect(await sonda('es-co', '222')).toBe('account_ban');
  });
});

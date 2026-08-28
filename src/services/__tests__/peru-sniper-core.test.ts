import { describe, it, expect } from 'vitest';
import {
  cupoEfectivo, sumarDias, elegirFecha, verificarDisparo,
  veredictoToken, POLITICA_TOKEN, msHastaSegundo, enVentana, VENTANA_PE,
  type SniperPeruConfig,
} from '../peru-sniper-core.js';

const HOY = '2026-08-28';

/** Config real del bot 299 al 2026-08-28. */
const BASE: SniperPeruConfig = {
  citaActual: '2027-12-23',
  metaAntesDe: '2026-12-31',
  minDiasDesdeHoy: 1,
  nuestroMax: 1,
  nuestroCount: 0,
  portalRestante: 2,
  usaCas: false,
};

describe('cupoEfectivo', () => {
  it('manda el tope mas estricto: el nuestro', () => {
    expect(cupoEfectivo(BASE)).toEqual({ quedan: 1, topeDe: 'nuestro' });
  });

  it('manda el tope mas estricto: el del portal', () => {
    expect(cupoEfectivo({ ...BASE, nuestroMax: 5, portalRestante: 2 }))
      .toEqual({ quedan: 2, topeDe: 'portal' });
  });

  it('el portal en 0 gana aunque nos quede presupuesto', () => {
    expect(cupoEfectivo({ ...BASE, nuestroMax: 3, nuestroCount: 0, portalRestante: 0 }).quedan).toBe(0);
  });

  it('nuestro contador agotado da 0 aunque el portal ofrezca 2', () => {
    expect(cupoEfectivo({ ...BASE, nuestroCount: 1 }).quedan).toBe(0);
  });

  it('nunca devuelve negativo si el contador se paso', () => {
    expect(cupoEfectivo({ ...BASE, nuestroCount: 9 }).quedan).toBe(0);
  });

  it('sin ningun tope declarado no limita', () => {
    const c = cupoEfectivo({ ...BASE, nuestroMax: null, portalRestante: null });
    expect(c.topeDe).toBe('sin_tope');
    expect(c.quedan).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('sumarDias', () => {
  it('cruza el fin de mes', () => expect(sumarDias('2026-08-31', 1)).toBe('2026-09-01'));
  it('cruza el fin de ano', () => expect(sumarDias('2026-12-31', 1)).toBe('2027-01-01'));
  it('acepta anos bisiestos', () => expect(sumarDias('2028-02-28', 1)).toBe('2028-02-29'));
  it('acepta cero', () => expect(sumarDias(HOY, 0)).toBe(HOY));
});

describe('elegirFecha', () => {
  it('toma la mas temprana que sirve', () => {
    const dias = [{ date: '2026-11-20' }, { date: '2026-09-15' }, { date: '2026-10-01' }];
    expect(elegirFecha(dias, BASE, HOY)).toBe('2026-09-15');
  });

  it('descarta fechas posteriores a la cita actual', () => {
    expect(elegirFecha([{ date: '2028-01-05' }], BASE, HOY)).toBeNull();
  });

  it('descarta la fecha igual a la cita actual', () => {
    expect(elegirFecha([{ date: '2027-12-23' }], BASE, HOY)).toBeNull();
  });

  it('descarta fechas posteriores a la meta', () => {
    expect(elegirFecha([{ date: '2027-01-05' }], BASE, HOY)).toBeNull();
    expect(elegirFecha([{ date: '2026-12-31' }], BASE, HOY)).toBeNull();
    expect(elegirFecha([{ date: '2026-12-30' }], BASE, HOY)).toBe('2026-12-30');
  });

  it('descarta hoy y el pasado con minDiasDesdeHoy=1', () => {
    expect(elegirFecha([{ date: HOY }, { date: '2026-08-27' }], BASE, HOY)).toBeNull();
    expect(elegirFecha([{ date: '2026-08-29' }], BASE, HOY)).toBe('2026-08-29');
  });

  it('ignora basura de formato', () => {
    const dias = [{ date: 'manana' }, { date: '15/09/2026' }, { date: '2026-09-15' }];
    expect(elegirFecha(dias as Array<{ date: string }>, BASE, HOY)).toBe('2026-09-15');
  });

  it('lista vacia da null', () => expect(elegirFecha([], BASE, HOY)).toBeNull());

  it('sin cita actual no filtra por cita, la verificacion dura lo corta despues', () => {
    const cfg = { ...BASE, citaActual: null };
    expect(elegirFecha([{ date: '2026-09-15' }], cfg, HOY)).toBe('2026-09-15');
    expect(verificarDisparo('2026-09-15', '10:15', cfg, HOY)).toContain('V2 sin cita actual leida del portal');
  });
});

describe('verificarDisparo', () => {
  it('el caso bueno no tiene fallos', () => {
    expect(verificarDisparo('2026-09-15', '10:15', BASE, HOY)).toEqual([]);
  });

  it('V2 bloquea una fecha posterior a la cita actual', () => {
    const f = verificarDisparo('2028-01-05', '10:15', BASE, HOY);
    expect(f.some((x) => x.startsWith('V2'))).toBe(true);
  });

  it('V2 bloquea la fecha IGUAL a la cita actual', () => {
    const f = verificarDisparo('2027-12-23', '10:15', BASE, HOY);
    expect(f.some((x) => x.startsWith('V2'))).toBe(true);
  });

  it('V3 bloquea una fecha en la meta o despues', () => {
    expect(verificarDisparo('2026-12-31', '10:15', BASE, HOY).some((x) => x.startsWith('V3'))).toBe(true);
    expect(verificarDisparo('2027-06-01', '10:15', BASE, HOY).some((x) => x.startsWith('V3'))).toBe(true);
  });

  it('V4 bloquea hoy y el pasado', () => {
    expect(verificarDisparo(HOY, '10:15', BASE, HOY).some((x) => x.startsWith('V4'))).toBe(true);
    expect(verificarDisparo('2026-01-01', '10:15', BASE, HOY).some((x) => x.startsWith('V4'))).toBe(true);
  });

  it('V5 bloquea cuando nuestro cupo se agoto', () => {
    const f = verificarDisparo('2026-09-15', '10:15', { ...BASE, nuestroCount: 1 }, HOY);
    expect(f.some((x) => x.startsWith('V5'))).toBe(true);
  });

  it('V5 bloquea cuando el portal quedo en 0', () => {
    const f = verificarDisparo('2026-09-15', '10:15', { ...BASE, portalRestante: 0 }, HOY);
    expect(f.some((x) => x.startsWith('V5'))).toBe(true);
  });

  it('V6 bloquea si la cuenta pide CAS', () => {
    const f = verificarDisparo('2026-09-15', '10:15', { ...BASE, usaCas: true }, HOY);
    expect(f.some((x) => x.startsWith('V6'))).toBe(true);
  });

  it('V1 bloquea formatos malos', () => {
    expect(verificarDisparo('15-09-2026', '10:15', BASE, HOY).some((x) => x.startsWith('V1'))).toBe(true);
    expect(verificarDisparo('2026-09-15', '1015', BASE, HOY).some((x) => x.startsWith('V1'))).toBe(true);
  });

  it('V7 bloquea contadores incoherentes', () => {
    const f = verificarDisparo('2026-09-15', '10:15', { ...BASE, nuestroMax: 1, nuestroCount: 2 }, HOY);
    expect(f.some((x) => x.startsWith('V7'))).toBe(true);
  });

  it('acumula todos los fallos, no corta en el primero', () => {
    const f = verificarDisparo('2028-01-05', '10:15', { ...BASE, nuestroCount: 1, usaCas: true }, HOY);
    expect(f.length).toBeGreaterThanOrEqual(3);
  });

  it('toda fecha que elige elegirFecha pasa la verificacion dura', () => {
    const dias = Array.from({ length: 400 }, (_, i) => ({ date: sumarDias('2026-08-01', i) }));
    const pick = elegirFecha(dias, BASE, HOY);
    expect(pick).toBe('2026-08-29');
    expect(verificarDisparo(pick!, '10:15', BASE, HOY)).toEqual([]);
  });
});

describe('veredictoToken', () => {
  const T0 = Date.parse('2026-08-28T12:00:00Z');
  const estado = { emitidoMs: T0, cookie: 'ck1', token: 'abc' };

  it('recien emitido esta ok', () => {
    expect(veredictoToken(estado, 'ck1', T0 + 60_000)).toBe('ok');
  });

  it('a los 10 min pide refresco y todavia sirve', () => {
    expect(veredictoToken(estado, 'ck1', T0 + POLITICA_TOKEN.cadenciaMs)).toBe('refrescar');
    expect(veredictoToken(estado, 'ck1', T0 + 44 * 60_000)).toBe('refrescar');
  });

  it('a los 45 min queda vencido', () => {
    expect(veredictoToken(estado, 'ck1', T0 + POLITICA_TOKEN.techoMs)).toBe('vencido');
    expect(veredictoToken(estado, 'ck1', T0 + 60 * 60_000)).toBe('vencido');
  });

  it('una cookie distinta lo mata aunque sea nuevo', () => {
    expect(veredictoToken(estado, 'ck2', T0 + 1000)).toBe('vencido');
  });

  it('sin estado o sin token queda vencido', () => {
    expect(veredictoToken(null, 'ck1', T0)).toBe('vencido');
    expect(veredictoToken({ ...estado, token: '' }, 'ck1', T0)).toBe('vencido');
  });

  it('un reloj que retrocede queda vencido, nunca ok', () => {
    expect(veredictoToken(estado, 'ck1', T0 - 5_000)).toBe('vencido');
  });
});

describe('fase del minuto', () => {
  const min = Date.parse('2026-08-28T12:34:00Z');

  it('espera hasta el segundo objetivo del mismo minuto', () => {
    expect(msHastaSegundo(min + 5_000, 14)).toBe(9_000);
  });

  it('si ya paso, salta al minuto siguiente', () => {
    expect(msHastaSegundo(min + 20_000, 14)).toBe(54_000);
  });

  it('nunca devuelve 0 en el segundo exacto', () => {
    expect(msHastaSegundo(min + 14_000, 14)).toBe(60_000);
  });

  it('el disparo en el segundo 14 cae dentro de la ventana s15-24', () => {
    const t = min + 14_000 + msHastaSegundo(min + 14_000, 14);
    expect(enVentana(t + 1_500)).toBe(true);
  });

  it('la ventana es s15 a s24 inclusive', () => {
    expect(enVentana(min + 14_999)).toBe(false);
    expect(enVentana(min + 15_000)).toBe(true);
    expect(enVentana(min + 24_999)).toBe(true);
    expect(enVentana(min + 25_000)).toBe(false);
    expect(VENTANA_PE).toEqual({ inicioSeg: 15, finSeg: 25 });
  });
});

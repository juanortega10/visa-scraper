import { describe, it, expect } from 'vitest';
import {
  PLAN_DISPAROS, esMinutoLiberacion, segundosDelMinuto, msHastaProximoDisparo,
  copiaCitaUsable, CITA_COPIA_MAX_MS,
} from '../peru-sniper-core.js';
import { snipersCaidos, debeAvisar, UMBRAL_SNIPER_MIN } from '../sniper-vivo.js';

const T = (iso: string) => Date.parse(iso);

describe('plan de disparos', () => {
  it('el minuto multiplo de 5 es de liberacion', () => {
    expect(esMinutoLiberacion(T('2026-11-05T19:30:10Z'))).toBe(true);
    expect(esMinutoLiberacion(T('2026-11-05T19:31:10Z'))).toBe(false);
    expect(segundosDelMinuto(T('2026-11-05T19:35:00Z'))).toEqual(PLAN_DISPAROS.liberacion);
    expect(segundosDelMinuto(T('2026-11-05T19:36:00Z'))).toEqual(PLAN_DISPAROS.resto);
  });

  it('en el minuto de liberacion dispara en 14, 16, 18 y 20', () => {
    const m = T('2026-11-05T19:30:00Z');
    expect(msHastaProximoDisparo(m + 5_000)).toBe(9_000);
    expect(msHastaProximoDisparo(m + 14_000)).toBe(2_000);
    expect(msHastaProximoDisparo(m + 16_500)).toBe(1_500);
    expect(msHastaProximoDisparo(m + 19_000)).toBe(1_000);
  });

  it('despues del s20 de liberacion salta al s18 del minuto siguiente', () => {
    const m = T('2026-11-05T19:30:00Z');
    expect(msHastaProximoDisparo(m + 20_000)).toBe(58_000);
  });

  it('en el minuto 4 del ciclo, despues de s18, salta al s14 de liberacion', () => {
    const m = T('2026-11-05T19:34:00Z');
    expect(msHastaProximoDisparo(m + 18_000)).toBe(56_000);
  });

  it('nunca devuelve 0', () => {
    expect(msHastaProximoDisparo(T('2026-11-05T19:30:14Z'))).toBe(2_000);
  });

  it('gasta 8 pedidos cada 5 minutos', () => {
    let t = T('2026-11-05T19:30:00Z');
    const fin = t + 5 * 60_000;
    let n = 0;
    while (true) { t += msHastaProximoDisparo(t); if (t >= fin) break; n++; }
    expect(n).toBe(8);
  });
});

describe('copia de la cita', () => {
  const ahora = T('2026-11-05T19:30:16Z');
  const copia = { consularDate: '2027-12-23', consularTime: '10:15', enMs: ahora - 70_000 };

  it('sirve si es reciente y coincide con la base', () => {
    expect(copiaCitaUsable(copia, '2027-12-23', ahora)).toBe(true);
  });
  it('no sirve si es vieja', () => {
    expect(copiaCitaUsable({ ...copia, enMs: ahora - CITA_COPIA_MAX_MS - 1 }, '2027-12-23', ahora)).toBe(false);
  });
  it('no sirve si la base dice otra fecha (el dueno movio la cita)', () => {
    expect(copiaCitaUsable(copia, '2027-03-01', ahora)).toBe(false);
  });
  it('no sirve sin copia o sin fecha en la base', () => {
    expect(copiaCitaUsable(null, '2027-12-23', ahora)).toBe(false);
    expect(copiaCitaUsable(copia, null, ahora)).toBe(false);
  });
  it('no sirve con una marca del futuro', () => {
    expect(copiaCitaUsable({ ...copia, enMs: ahora + 5_000 }, '2027-12-23', ahora)).toBe(false);
  });
});

describe('vigilante del sniper', () => {
  const ahora = T('2026-11-05T19:30:00Z');
  const base = { scanKey: 'peru-299', botId: 299, botActivo: true };

  it('vivo con una fila de hace 6 min', () => {
    expect(snipersCaidos([{ ...base, ultimoMs: ahora - 6 * 60_000 }], ahora)).toEqual([]);
  });
  it('caido con 10 min sin filas', () => {
    expect(snipersCaidos([{ ...base, ultimoMs: ahora - UMBRAL_SNIPER_MIN * 60_000 }], ahora))
      .toEqual([{ scanKey: 'peru-299', botId: 299, minutos: 10 }]);
  });
  it('el corte real de 28 h se reporta', () => {
    const ultimo = T('2026-11-04T19:27:20Z');
    const ahoraReal = T('2026-11-05T23:33:10Z');
    expect(snipersCaidos([{ ...base, ultimoMs: ultimo }], ahoraReal)[0]!.minutos).toBe(1685);
  });
  it('un bot pausado no cuenta', () => {
    expect(snipersCaidos([{ ...base, botActivo: false, ultimoMs: null }], ahora)).toEqual([]);
  });
  it('avisa al cruzar el umbral y despues una vez por hora', () => {
    const ciclos = Array.from({ length: 40 }, (_, i) => 5 + i * 5);   // 5..200 min
    const avisos = ciclos.filter((m) => debeAvisar(m));
    expect(avisos).toEqual([10, 60, 120, 180]);
  });
});

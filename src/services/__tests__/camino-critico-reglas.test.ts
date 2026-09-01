import { describe, it, expect } from 'vitest';
import { evaluarParalelo, MARGEN_PARALELO_MS, type ParCarrera } from '../camino-critico-reglas.js';

describe('V4 · el paralelo es real', () => {
  it('paralelo perfecto: la carrera dura lo que la pata lenta', () => {
    const v = evaluarParalelo([{ c: 653, t: 223, a: 653 }]);
    expect(v.enSerie).toBe(0);
    expect(v.razones[0]).toBeCloseTo(1, 2);
  });

  it('el caso real que disparo la alarma falsa NO es serie', () => {
    // 2026-09-01 11:02, bot 299. La regla vieja (`c < 0,85 * (t + a)`) lo marcaba en
    // serie porque `c/(t+a) = 0,89`. La carrera duro exactamente lo que la pata lenta.
    const v = evaluarParalelo([{ c: 1721, t: 208, a: 1721 }]);
    expect(v.enSerie).toBe(0);
    expect(v.razones[0]).toBeCloseTo(1, 2);
    expect(v.razonesSuma[0]).toBeCloseTo(0.89, 2);
  });

  it('la serie de verdad se detecta: la carrera dura la SUMA', () => {
    // Razon contra el maximo: 1,12. Un umbral por porcentaje lo dejaria pasar, y son
    // 208 ms perdidos de una ranura de 9 s. Por eso el umbral va en milisegundos.
    const v = evaluarParalelo([{ c: 1929, t: 208, a: 1721 }]);
    expect(v.enSerie).toBe(1);
    expect(v.razones[0]!).toBeLessThan(1.15);
    expect(v.sobrantes[0]).toBe(208);
  });

  it('dos patas parejas en serie tambien se detectan', () => {
    expect(evaluarParalelo([{ c: 1300, t: 650, a: 650 }]).enSerie).toBe(1);
  });

  it('el techo de 10 s en una pata no marca serie', () => {
    // `times` corta en 10 s por AbortSignal. En paralelo la carrera dura esos 10 s.
    expect(evaluarParalelo([{ c: 10002, t: 10002, a: 1821 }]).enSerie).toBe(0);
  });

  it('el margen se respeta en el borde exacto', () => {
    expect(evaluarParalelo([{ c: 1000 + MARGEN_PARALELO_MS, t: 100, a: 1000 }]).enSerie).toBe(0);
    expect(evaluarParalelo([{ c: 1000 + MARGEN_PARALELO_MS + 1, t: 100, a: 1000 }]).enSerie).toBe(1);
  });

  it('el sobrante observado en produccion (0 y 1 ms) no marca serie', () => {
    expect(evaluarParalelo([{ c: 653, t: 223, a: 653 }, { c: 655, t: 223, a: 654 }]).enSerie).toBe(0);
  });

  it('cuenta cada vuelta, no un promedio: una mala entre nueve buenas se ve', () => {
    // Un promedio esconde el caso malo, y el caso malo es el que cuesta la ranura.
    const buenas: ParCarrera[] = Array.from({ length: 9 }, () => ({ c: 650, t: 220, a: 650 }));
    const v = evaluarParalelo([...buenas, { c: 870, t: 220, a: 650 }]);
    expect(v.enSerie).toBe(1);
    expect(v.sobrantes).toHaveLength(10);
  });

  it('sin vueltas devuelve cero y listas vacias', () => {
    const v = evaluarParalelo([]);
    expect(v).toEqual({ enSerie: 0, razones: [], sobrantes: [], razonesSuma: [] });
  });

  it('ceros no producen division por cero', () => {
    const v = evaluarParalelo([{ c: 0, t: 0, a: 0 }]);
    expect(Number.isFinite(v.razones[0]!)).toBe(true);
    expect(v.enSerie).toBe(0);
  });
});

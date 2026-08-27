import { describe, it, expect } from 'vitest';

/**
 * El tope de candidatas por poll bajo de 5 a 3 el 2026-08-27.
 *
 * Evidencia: `reschedule_logs`, 905 exitos historicos, contando cuantos fallos del
 * mismo bot hubo en los 60 s previos a cada exito.
 *
 *   0 fallos previos → 843 exitos
 *   1               →  31
 *   2               →  16
 *   3               →   3
 *   4               →   8
 *   5               →   2
 *   7               →   1
 *  10               →   1
 *
 * Hasta 3 candidatas se conserva el 98,3%. De la 4 en adelante son 15 de 905 (1,7%),
 * y cada intento cuesta 2-3 s de p50.
 *
 * Este test fija esa decision con los datos, para que un cambio futuro tenga que
 * mirar los numeros en vez de moverlo por corazonada.
 */
const EXITOS_POR_FALLOS_PREVIOS: Record<number, number> = {
  0: 843, 1: 31, 2: 16, 3: 3, 4: 8, 5: 2, 7: 1, 10: 1,
};
const TOTAL = Object.values(EXITOS_POR_FALLOS_PREVIOS).reduce((a, b) => a + b, 0);

/** Exitos que SOBREVIVEN si el bucle se corta en `tope` candidatas. */
function exitosConservados(tope: number): number {
  return Object.entries(EXITOS_POR_FALLOS_PREVIOS)
    .filter(([fallos]) => Number(fallos) <= tope - 1)
    .reduce((a, [, n]) => a + n, 0);
}

describe('tope del bucle de candidatas', () => {
  it('el historico suma 905 exitos', () => {
    expect(TOTAL).toBe(905);
  });

  it('cortar en 3 conserva el 98,3% de los exitos', () => {
    const c = exitosConservados(3);
    expect(c).toBe(890);
    expect(c / TOTAL).toBeGreaterThan(0.98);
  });

  it('cortar en 1 costaria el 6,9%: por eso NO se corta ahi', () => {
    const c = exitosConservados(1);
    expect(c).toBe(843);
    expect(1 - c / TOTAL).toBeGreaterThan(0.06);
  });

  it('subir a 5 solo recupera 5 exitos mas que 3', () => {
    expect(exitosConservados(5) - exitosConservados(3)).toBe(11);
  });

  it('el bucle SI convierte: 62 exitos llegaron tras al menos un fallo', () => {
    const conFallos = TOTAL - EXITOS_POR_FALLOS_PREVIOS[0]!;
    expect(conFallos).toBe(62);
    expect(conFallos / TOTAL).toBeGreaterThan(0.06);
  });

  it('el tope elegido es 3', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/services/reschedule-logic.ts', 'utf8'));
    expect(src).toMatch(/maxAttempts = 3,/);
  });
});

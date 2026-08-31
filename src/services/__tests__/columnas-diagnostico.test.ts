import { describe, it, expect } from 'vitest';
import { columnasDeIntento, type ColumnasIntento } from '../reschedule-logic.js';

/**
 * Guardas de `columnasDeIntento`, la funcion que traduce un intento fallido a las
 * columnas de `reschedule_logs`.
 *
 * Por que existen. El 2026-08-31 se encontro que las 23.494 filas de
 * `reschedule_logs` tenian `times_seen` nulo, TODAS. La rama que registra "se
 * acabaron los intentos" armaba el objeto a mano, campo por campo, y se le olvidaron
 * `msToPost` y `timesSeen`. Las otras seis ramas si los escribian.
 *
 * Duele en es-pe. Peru no tiene CAS, entonces sus intentos fallan por `no_times`, y
 * `no_times` sale SIEMPRE por esa rama. Las dos unicas detecciones del bot 299
 * (2026-10-08 y 2026-10-26, el 2026-08-27) quedaron sin el unico dato que decide el
 * caso: `timesSeen = 0` es fecha fantasma, mayor que 0 es carrera perdida.
 *
 * El test de abajo NO comprueba valores uno por uno. Comprueba que NINGUNA columna
 * salga nula cuando el intento las trae todas. Asi mata la mutacion "se me olvido un
 * campo", que es exactamente el bug que paso.
 */

/** Un intento con TODOS los campos diagnosticos puestos, y con valores distinguibles. */
const COMPLETO: ColumnasIntento = {
  failReason: 'no_times',
  failStep: 'get_consular_times',
  durationMs: 1234,
  msToPost: 567,
  timesSeen: 3,
  timesFound: ['07:30', '10:15'],
  cause: 'carrera perdida',
  error: 'times.json vacio',
};

/** Las columnas escalares que van a `reschedule_logs`. `detail` se revisa aparte. */
const COLUMNAS = ['failStep', 'failReason', 'durationMs', 'msToPost', 'timesSeen'] as const;

describe('columnasDeIntento', () => {
  it('con un intento completo NINGUNA columna sale nula', () => {
    const cols = columnasDeIntento(COMPLETO) as Record<string, unknown>;
    const nulas = COLUMNAS.filter((c) => cols[c] === null || cols[c] === undefined);
    expect(nulas, `columnas perdidas: ${nulas.join(', ')}`).toEqual([]);
  });

  it('cada campo llega con SU valor, no con el de otro', () => {
    const c = columnasDeIntento(COMPLETO);
    expect(c.failReason).toBe('no_times');
    expect(c.failStep).toBe('get_consular_times');
    expect(c.durationMs).toBe(1234);
    expect(c.msToPost).toBe(567);
    expect(c.timesSeen).toBe(3);
  });

  it('timesSeen = 0 se conserva, no se convierte en null', () => {
    // Es el caso que MAS importa. `0` significa fecha fantasma: el calendario la lista
    // y no tiene cupo real detras. Un `??` mal puesto lo volveria null y borraria la
    // unica diferencia entre "no habia nada" y "nos ganaron".
    const c = columnasDeIntento({ ...COMPLETO, timesSeen: 0, msToPost: 0 });
    expect(c.timesSeen).toBe(0);
    expect(c.msToPost).toBe(0);
  });

  it('lo que falta queda en null, nunca en undefined', () => {
    // `undefined` en un insert de Drizzle omite la columna en vez de escribir NULL.
    const c = columnasDeIntento({ failReason: 'no_times', durationMs: 10 }) as Record<string, unknown>;
    expect(c.failStep).toBeNull();
    expect(c.msToPost).toBeNull();
    expect(c.timesSeen).toBeNull();
    for (const k of COLUMNAS) expect(c[k]).not.toBeUndefined();
  });

  it('detail lleva timesFound, cause y error cuando existen', () => {
    const c = columnasDeIntento(COMPLETO);
    expect(c.detail).toEqual({
      timesFound: ['07:30', '10:15'],
      cause: 'carrera perdida',
      error: 'times.json vacio',
    });
  });

  it('detail queda vacio si no hay nada que contar', () => {
    expect(columnasDeIntento({ failReason: 'no_times', durationMs: 1 }).detail).toEqual({});
  });

  it('timesFound vacio se distingue de timesFound ausente', () => {
    // `[]` quiere decir "el portal respondio sin horas". Ausente quiere decir "ni se
    // pregunto". Son dos cosas distintas y el diagnostico depende de separarlas.
    expect(columnasDeIntento({ ...COMPLETO, timesFound: [] }).detail).toHaveProperty('timesFound', []);
    const sin = columnasDeIntento({ failReason: 'no_times', durationMs: 1 }).detail;
    expect(sin).not.toHaveProperty('timesFound');
  });
});

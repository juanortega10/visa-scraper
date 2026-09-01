/**
 * Reglas del verificador del camino critico. Ver `scripts/verificar-camino-critico.ts`.
 *
 * Viven aqui, fuera del script, porque una regla sin tests no verifica nada: avisa. El
 * 2026-09-01 V4 mando una regresion falsa y la regla era el problema, no el codigo que
 * vigilaba.
 */

export interface ParCarrera {
  /** Duracion de la carrera completa (`msCarrera`). */
  c: number;
  /** Duracion de la peticion de horas (`msTimes`). */
  t: number;
  /** Duracion de la peticion de la cita (`msApt`). */
  a: number;
}

/**
 * Margen ABSOLUTO sobre el maximo, en milisegundos.
 *
 * Se mide en ms y no en porcentaje a proposito. Con un porcentaje, una pata rapida
 * esconde la serie: `c = 1929`, `t = 208`, `a = 1721` da razon 1,12, o sea por debajo de
 * cualquier tolerancia razonable, y sin embargo son 208 ms perdidos de una ranura de 9 s.
 *
 * El numero sale del dato: sobre 100 vueltas de 24 h del bot 299, `c - max(t, a)` fue
 * 0 o 1 ms siempre. 60 ms deja sitio de sobra para el costo de armar las promesas y
 * queda muy por debajo de la pata mas corta que se ha visto (186 ms).
 */
export const MARGEN_PARALELO_MS = 60;

export interface VeredictoParalelo {
  /** Vueltas que de verdad corrieron en serie. */
  enSerie: number;
  /** `c / max(t, a)` por vuelta. 1,00 = paralelo perfecto. */
  razones: number[];
  /** `c - max(t, a)` por vuelta, en ms. Es lo que decide. */
  sobrantes: number[];
  /** `c / (t + a)`, solo informativo. NO sirve para decidir, ver abajo. */
  razonesSuma: number[];
}

/**
 * ¿Las dos peticiones salieron en paralelo?
 *
 * ── Por que se compara contra el MAXIMO y no contra la suma ─────────────────
 *
 * La regla vieja preguntaba `c < 0,85 * (t + a)`. Eso solo funciona cuando las dos
 * patas duran parecido. Cuando una domina, el paralelo perfecto se acerca a la suma y
 * la regla grita "en serie" sin motivo.
 *
 * Caso real del 2026-09-01 11:02 (bot 299): `c = 1721`, `t = 208`, `a = 1721`.
 *   c / (t + a) = 0,89  -> la regla vieja lo marcaba en serie
 *   c / max     = 1,00  -> paralelo perfecto, la carrera duro lo que la pata lenta
 *
 * Sobre 100 vueltas de 24 h: 1 marcada en serie por la regla vieja, 0 de verdad no
 * paralelas. Y el falso positivo aparece justo cuando una pata se pone lenta, o sea
 * cuando mas importa que la alarma sea confiable.
 */
export function evaluarParalelo(pares: ParCarrera[]): VeredictoParalelo {
  const sobrantes = pares.map((x) => x.c - Math.max(x.t, x.a));
  return {
    enSerie: sobrantes.filter((s) => s > MARGEN_PARALELO_MS).length,
    razones: pares.map((x) => x.c / Math.max(1, x.t, x.a)),
    sobrantes,
    razonesSuma: pares.map((x) => x.c / Math.max(1, x.t + x.a)),
  };
}

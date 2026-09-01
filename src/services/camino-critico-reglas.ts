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

// ── V7 · el token llega caliente al poll ─────────────────────────────────────

export interface SelloBot {
  botId: number;
  /** `sessions.tokens_refreshed_at`, en ms. `null` = poll-visa no escribio el sello. */
  selloMs: number | null;
  /** Momento del ultimo poll SANO (`ok` o `filtered_out`), en ms. `null` = no polleo. */
  ultimoPollSanoMs: number | null;
  /**
   * ¿El poll MAS RECIENTE del bot fue sano?
   *
   * Cuando no lo fue, el bot esta bloqueado o en error, y ahi el sello nulo es lo
   * ESPERADO: un re-login con `hasTokens: false` limpia los tokens a proposito, y
   * `refreshTokens()` los repone en el siguiente ciclo sano. Exigirle un sello fresco a
   * un bot bloqueado convierte un mecanismo que funciona en una alarma.
   */
  ultimoPollEsSano: boolean;
}

/**
 * Cuanto puede tener el sello del token en el momento del poll.
 *
 * El sniper refresca cada 30 min (`POLITICA_TOKEN.cadenciaMs`) y el TTL duro del portal
 * es de ~88 min. 15 min deja el sello holgadamente dentro de la vida util y sigue
 * detectando el caso que importa: un poll que salio con el token ya vencido.
 */
export const VENTANA_SELLO_MS = 15 * 60_000;

export interface VeredictoSello {
  /** Bots que pollearon en la ventana de lectura. */
  activos: number;
  /** De esos, los que tenian el sello fresco AL MOMENTO de pollear. */
  frescos: number;
  /** Bots sin ningun poll sano: en backoff o bloqueados. No se les exige nada. */
  dormidos: number;
  /** Bots que pollean y NO tienen sello: poll-visa no esta escribiendo. */
  sinSello: number[];
}

/**
 * ¿Los bots que pollean llevan el token caliente?
 *
 * ── Por que solo se juzga a un bot cuyo ULTIMO poll fue sano ────────────────
 *
 * El 2026-09-01 17:31 UTC el bot 7 quedo bloqueado, el re-login volvio con
 * `hasTokens: false` y limpio el sello. Dos minutos despues otro login lo repuso. Con la
 * regla que solo pedia "algun poll sano en la ventana", ese hueco de dos minutos salio
 * como REGRESION, y lo unico que pasaba era el mecanismo funcionando.
 *
 * Un bot bloqueado no tiene nada que demostrar sobre su token. Queda fuera del recuento
 * y V7 se queda sin muestra, que es la verdad.
 *
 * ── Por que la frescura se mide contra el POLL y no contra ahora ─────────────
 *
 * La version anterior comparaba `tokens_refreshed_at` contra `Date.now()` con la misma
 * ventana de 15 min que usaba para buscar polls. Eso ataba dos preguntas distintas al
 * mismo numero y producia un temblor: cuando los bots es-pe entraban en backoff de 30
 * min, ninguno habia polleado en 15 min, `activos` quedaba en 0 y V7 reportaba "sin
 * muestra". El 2026-09-01 el vigilante cambio de estado tres veces en una hora por esto,
 * sin que nada en produccion se moviera.
 *
 * Ensanchar solo la busqueda de polls no arregla nada: entonces se le exigiria un sello
 * de 15 min a un bot que polleo hace 50. La pregunta correcta es si el token estaba
 * caliente CUANDO el bot polleo, y eso no depende de cuanto tiempo lleve dormido desde
 * entonces.
 */
export function evaluarSellos(filas: SelloBot[]): VeredictoSello {
  const activos = filas.filter((f) => f.ultimoPollSanoMs !== null && f.ultimoPollEsSano);
  // El guarda de `null` es intencion explicita, no carga: con marcas de epoca,
  // `ultimoPollSanoMs - 0` ya queda muy por encima de la ventana. Se deja escrito para
  // que nadie lo borre asumiendo que sobra, porque dejaria la regla dependiendo de que
  // `null` se convierta en 0.
  const frescos = activos.filter(
    (f) => f.selloMs !== null && f.ultimoPollSanoMs! - f.selloMs < VENTANA_SELLO_MS,
  );
  return {
    activos: activos.length,
    frescos: frescos.length,
    dormidos: filas.length - activos.length,
    sinSello: activos.filter((f) => f.selloMs === null).map((f) => f.botId),
  };
}

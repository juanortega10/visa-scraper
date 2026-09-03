/**
 * Mejores practicas de fase para la flota: DONDE caer dentro del minuto.
 *
 * ── Lo que dice la curva, y por que no es lo que parece ─────────────────────
 *
 * Medido el 2026-09-03 sobre 30 h y 3.600 filas de es-co, con el segundo real del fetch:
 *
 *     s00-s08   ~5 por mil    0,09x    muerto
 *     s09-s12   sube
 *     s13-s33   ~108 por mil  1,7x     MESETA de 21 s
 *     s34-s41   baja
 *     s42-s59   ~13 por mil   0,2x
 *
 * La meseta parece una ventana ancha donde da igual caer. NO lo es.
 *
 * `date_changes.appeared` compara contra el poll ANTERIOR del mismo bot. Con la rejilla
 * de 20 s, un poll cubre los 20 s que lo preceden. Entonces una liberacion instantanea en
 * el segundo R la reporta cualquier poll en `[R, R+20]`, y en la curva se ve como una
 * meseta de 20 s que ARRANCA en R. La meseta mide 21 s, que es justo el periodo: la
 * liberacion es un instante, no un tramo.
 *
 * El borde de subida da la hora real. La mitad de la altura cae entre s11 y s13.
 *
 *     LA LIBERACION OCURRE ALREDEDOR DEL SEGUNDO 11 A 13, no en el 25.
 *
 * ── Por que eso cambia la decision ──────────────────────────────────────────
 *
 * Por tasa de `appeared`, s14 y s32 empatan: los dos caen dentro de la meseta y los dos
 * cuentan la misma rafaga. Lo que los separa es la LATENCIA. Un poll en s14 ve el cupo
 * 1 a 3 s despues de que existe; uno en s32, 19 s despues. Con cupos que duran 2 min de
 * mediana y con el 43% por debajo de eso, esos 18 s son la diferencia entre agendar y
 * llegar tarde.
 *
 * La ventana s22-31 que traiamos estaba DENTRO de la meseta, entonces medía bien y
 * llegaba tarde.
 *
 * ── La rafaga ───────────────────────────────────────────────────────────────
 *
 * El borde no es vertical: sube de s09 a s17. Parte es que la liberacion se corre de un
 * minuto a otro. Un solo poll en s12 se pierde los minutos en que la rafaga sale en s16.
 *
 * Por eso los polls se AGRUPAN al principio del borde, en vez de repartirse parejo por el
 * minuto. Mismo numero de peticiones, mismo costo, y la peor latencia baja de 19 s a la
 * separacion dentro de la rafaga.
 *
 *     rejilla de 20 s   s14, s34, s54    peor latencia 19 s
 *     rafaga            s11, s14, s18    peor latencia  3 s
 *
 * Lo que se paga: fuera de la rafaga hay un hueco de ~53 s. La curva dice que ahi vive
 * el 0,2x, o sea la parte despreciable.
 */

/**
 * Borde de subida por locale: donde ARRANCA la liberacion.
 *
 * Es el tramo a cubrir con la rafaga, y NO la meseta. Ver la explicacion de arriba.
 * `es-co` sale del borde medido s09-s17; se toma s11-s21 para dejar margen al jitter y
 * a lo que tarda la propia peticion.
 */
export const RAFAGA_LIBERACION: Record<string, { inicioSec: number; anchoSec: number }> = {
  'es-co': { inicioSec: 11, anchoSec: 10 },
};

/** Peticiones por minuto a partir del intervalo. El costo NO cambia. */
export function pollsPorMinuto(intervaloSec: number): number {
  return Math.max(1, Math.min(60, Math.round(60 / Math.max(1, intervaloSec))));
}

/**
 * Segundos del minuto en que se dispara, ordenados.
 *
 * Los disparos van DESPUES del borde, no encima de el: `inicio + paso`, `inicio + 2*paso`,
 * hasta `inicio + ancho`, con `paso = ancho / n`.
 *
 * ── Dos veces me equivoque aqui, y las dos las encontro un test ─────────────
 *
 * 1. Con `paso = ancho / n` arrancando EN `inicio`, tres polls en un borde de 10 s caian
 *    en s11, s14 y s18. El ultimo quedaba 3 s antes del final, y una liberacion en s20
 *    esperaba al s11 del minuto siguiente: 52 s, peor que los 19 s de la rejilla que se
 *    venia a mejorar.
 *
 * 2. Arrancando en `inicio` con `paso = ancho / (n-1)`, el plan tapaba el borde entero
 *    pero el PRIMER disparo caia justo cuando empieza la liberacion, o sea no alcanzaba a
 *    ver nada. Y con un solo poll (`n = 1`, el caso del bot 246) quedaba en s11: una
 *    liberacion en s20 esperaba 51 s. Un solo poll tiene que ir al FINAL del borde.
 *
 * Un poll en el segundo `s` ve lo que aparecio hasta `s`. Entonces para cubrir una
 * liberacion en cualquier punto de `[inicio, inicio + ancho]`, el ultimo disparo va en
 * `inicio + ancho` y los demas se reparten hacia atras.
 *
 *     n=1   [21]            peor latencia 10 s
 *     n=3   [14, 18, 21]    peor latencia  3 s
 *     n=5   [13, 15, 17, 19, 21]  peor latencia 2 s
 *
 * Se separan al menos un segundo: dos peticiones en el mismo segundo son una sola
 * oportunidad y el doble de carga en el peor instante.
 */
export function planRafaga(args: { inicioSec: number; anchoSec: number; n: number }): number[] {
  const n = Math.max(1, Math.min(60, Math.round(args.n)));
  const ancho = Math.max(1, Math.round(args.anchoSec));
  const paso = ancho / n;
  const vistos = new Set<number>();
  const out: number[] = [];
  for (let i = 1; i <= n; i++) {
    let s = (Math.round(args.inicioSec + i * paso) % 60 + 60) % 60;
    // Colision: se corre hacia ATRAS al segundo libre, para no pasarse del borde.
    while (vistos.has(s)) s = (s - 1 + 60) % 60;
    vistos.add(s);
    out.push(s);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Segundos hasta el proximo disparo del plan.
 *
 * Devuelve siempre un valor mayor que cero y menor o igual a 60. `minSec` es el piso, para
 * no adelantar un poll cuando la vuelta anterior tardo poco.
 */
export function siguienteEnRafaga(args: {
  nowMs: number;
  plan: number[];
  minSec?: number;
}): number {
  if (args.plan.length === 0) return 60;
  const min = Math.max(0, args.minSec ?? 0);
  const ahoraSec = args.nowMs / 1000;
  const desde = ahoraSec + min;
  const minutoBase = Math.floor(desde / 60) * 60;

  // Se prueban los disparos de este minuto y del siguiente. El plan esta ordenado.
  for (const base of [minutoBase, minutoBase + 60, minutoBase + 120]) {
    for (const s of args.plan) {
      const t = base + s;
      if (t > ahoraSec && t >= desde) return Math.round((t - ahoraSec) * 1000) / 1000;
    }
  }
  return 60;
}

/**
 * Peor latencia del plan: cuanto puede tardarse en ver una liberacion que cae dentro del
 * borde. Es la cifra que se quiere minimizar, y la que separa una fase buena de una mala.
 */
export function peorLatenciaSec(plan: number[], inicioSec: number, anchoSec: number): number {
  let peor = 0;
  for (let r = inicioSec; r < inicioSec + anchoSec; r++) {
    const rr = ((r % 60) + 60) % 60;
    // Primer disparo del plan en o despues de la liberacion, dando la vuelta al minuto.
    let mejor = 60;
    for (const s of plan) {
      const d = (s - rr + 60) % 60;
      if (d < mejor) mejor = d;
    }
    if (mejor > peor) peor = mejor;
  }
  return peor;
}

/**
 * Borde de subida de la curva: donde cruza la mitad de su altura.
 *
 * Es LO QUE EL CENTINELA VIGILA. La tasa por segundo es una meseta que arranca en la
 * liberacion y dura lo que el hueco entre polls, entonces el pico no dice la hora: el
 * borde si.
 *
 * Se busca circularmente desde el minimo de la curva, para que un borde a caballo del
 * cambio de minuto no se parta en dos.
 *
 * Devuelve `null` cuando la curva es plana (no hay meseta que encontrar) o cuando no hay
 * polls suficientes. Un borde inventado sobre ruido moveria la flota entera al lugar
 * equivocado.
 */
export function bordeDeSubida(
  curva: Array<{ segundo: number; suave: number; polls: number }>,
  minPolls = 600,
): number | null {
  if (curva.length !== 60) return null;
  if (curva.reduce((a, c) => a + c.polls, 0) < minPolls) return null;

  const alt = curva.map((c) => c.suave);
  const max = Math.max(...alt);
  const min = Math.min(...alt);
  // Una curva plana no tiene borde. El 1,8 sale del dato: la meseta medida esta a 1,7x de
  // la media y a mas de 8x del valle, entonces un contraste por debajo de 1,8 es ruido.
  if (max < min * 1.8 || max <= 0) return null;

  const mitad = (max + min) / 2;
  // Se arranca en el valle y se avanza circularmente hasta el primer cruce hacia arriba.
  const valle = alt.indexOf(min);
  for (let i = 1; i <= 60; i++) {
    const s = (valle + i) % 60;
    const prev = (s + 59) % 60;
    if (alt[prev]! < mitad && alt[s]! >= mitad) return s;
  }
  return null;
}

/** ¿El borde medido se corrio de donde apunta la rafaga? */
export function bordeSeMovio(bordeSec: number | null, config: { inicioSec: number; anchoSec: number }): boolean {
  if (bordeSec === null) return false;
  // La distancia se mide circularmente: s59 y s01 estan a 2 s, no a 58.
  const d = Math.min(Math.abs(bordeSec - config.inicioSec), 60 - Math.abs(bordeSec - config.inicioSec));
  // Media anchura de tolerancia: mas que eso y la rafaga ya no tapa la liberacion.
  return d > config.anchoSec / 2;
}

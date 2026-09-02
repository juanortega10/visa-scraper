/**
 * Estadistica del A/B de fase. Lo que decide si un numero significa algo.
 *
 * ── Por que existe este archivo ─────────────────────────────────────────────
 *
 * El primer reporte del experimento comparaba tasas por poll y exigia 20.000 polls por
 * brazo. Medido el 2026-09-01 con 20.445 polls, eso daba:
 *
 *     por poll, cada uno independiente   RR 0,785  IC95 [0,663 a 0,930]  p = 0,005
 *     por bloque bot-hora, la unidad real RR 0,787  IC95 [0,508 a 1,221]
 *
 * El primero declara un ganador. El segundo cruza 1 y no concluye nada. El segundo es el
 * correcto, porque la asignacion se hace por `(hora + botId) % 2`: dentro de una hora un
 * bot esta ENTERO en un brazo. La unidad aleatorizada es el bot-hora, y habia 159
 * bloques, no 20.445 observaciones independientes.
 *
 * Medida de la sobredispersion ese dia: `chi2/gl = 6,52`. El error verdadero es 2,55
 * veces el que asume Poisson. Y de los 578 eventos, 513 salieron de UN dia.
 *
 * ── Las tres reglas que este archivo impone ─────────────────────────────────
 *
 * 1. La muestra se cuenta en EVENTOS, no en polls. Los polls sin evento no aportan
 *    informacion sobre la diferencia de tasas.
 * 2. El intervalo de confianza sale de un bootstrap por BLOQUE, que respeta la unidad
 *    de aleatorizacion. Nunca de la formula de Poisson.
 * 3. El veredicto sale de ese intervalo. Mientras cruce 1, no hay ganador.
 */

/** Un bloque = un bot durante una hora. Es la unidad que se aleatoriza y la que se remuestrea. */
export interface BloqueExperimento {
  botId: number;
  /** Hora UTC truncada, en ms. Junto al botId define el brazo. */
  horaMs: number;
  /** Polls REALES del bloque (`SUM(polls_since_prev)`). */
  polls: number;
  /** Cupos cercanos que APARECIERON en el bloque (`date_changes->'appeared'`). */
  eventos: number;
  alineado: boolean;
}

export interface BrazoEstadistica {
  bloques: number;
  polls: number;
  eventos: number;
  /** Eventos por cada 1.000 polls reales. */
  porMil: number;
}

export type Veredicto = 'gana' | 'pierde' | 'empata' | 'sin-muestra';

export interface AnalisisExperimento {
  alineado: BrazoEstadistica;
  control: BrazoEstadistica;
  /** Razon de tasas alineado/control. 1 = sin diferencia. */
  razon: number;
  /** IC95 de la razon, por bootstrap de bloques. */
  ic95: [number, number];
  /** `chi2/gl` sobre los bloques. 1,0 = Poisson puro. */
  sobredispersion: number;
  /** Eventos que hace falta acumular POR BRAZO para el efecto objetivo. */
  eventosNecesarios: number;
  hayMuestra: boolean;
  veredicto: Veredicto;
}

/**
 * Efecto que el experimento quiere poder detectar.
 *
 * 1,20 y no 1,05: una mejora del 5% en la tasa de deteccion no cambia ninguna decision,
 * y perseguirla cuesta meses. La linea base observacional prometia 3,0x, entonces 1,20
 * es un piso comodo. Si el efecto real es mas grande, se detecta antes.
 */
export const EFECTO_OBJETIVO = 1.2;

/** Bloques minimos antes de intentar cualquier cuenta. Con menos, el bootstrap no tiene de donde. */
export const BLOQUES_MINIMOS = 40;

const Z_ALFA = 1.959964;   // dos colas, 95%
const Z_POTENCIA = 0.841621; // 80%

/**
 * Eventos por brazo para detectar `rr` con 80% de potencia, inflando por la
 * sobredispersion medida. Con `phi = 1` es la formula de Poisson de siempre.
 */
export function eventosNecesarios(rr: number, phi: number): number {
  const l = Math.log(rr);
  if (!Number.isFinite(l) || l === 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(Math.max(1, phi) * (Z_ALFA + Z_POTENCIA) ** 2 / (l * l));
}

/**
 * PRNG con semilla. El bootstrap tiene que dar el MISMO intervalo con los mismos datos:
 * un reporte diario cuyo IC baila entre corridas es imposible de leer, y un test con
 * `Math.random` no puede afirmar nada.
 */
function prng(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tasa(b: { polls: number; eventos: number }): number {
  return b.polls > 0 ? b.eventos / b.polls : 0;
}

function acumular(bloques: BloqueExperimento[]): BrazoEstadistica {
  let polls = 0, eventos = 0;
  for (const b of bloques) { polls += b.polls; eventos += b.eventos; }
  return {
    bloques: bloques.length, polls, eventos,
    porMil: polls > 0 ? Math.round((10_000 * eventos) / polls) / 10 : 0,
  };
}

/** Sobredispersion sobre los bloques con polls suficientes para que la esperanza signifique algo. */
export function sobredispersion(bloques: BloqueExperimento[], minPolls = 50): number {
  const usables = bloques.filter((b) => b.polls >= minPolls);
  if (usables.length < 2) return 1;
  const global = tasa(acumular(usables));
  let chi = 0;
  for (const b of usables) {
    const esp = global * b.polls;
    chi += (b.eventos - esp) ** 2 / Math.max(0.5, esp);
  }
  return Math.round((chi / usables.length) * 100) / 100;
}

/**
 * Bootstrap por bloque: se remuestrean BLOQUES con reemplazo, nunca polls. Asi el
 * intervalo hereda la variacion que hay ENTRE bloques, que es la que el experimento
 * no controla.
 */
export function bootstrapRazon(
  bloques: BloqueExperimento[],
  vueltas = 4000,
  semilla = 20260901,
): [number, number] {
  const rnd = prng(semilla);
  const razones: number[] = [];
  for (let i = 0; i < vueltas; i++) {
    let pa = 0, ea = 0, pc = 0, ec = 0;
    for (let k = 0; k < bloques.length; k++) {
      const b = bloques[Math.floor(rnd() * bloques.length)]!;
      if (b.alineado) { pa += b.polls; ea += b.eventos; } else { pc += b.polls; ec += b.eventos; }
    }
    if (pa > 0 && pc > 0 && ec > 0) razones.push((ea / pa) / (ec / pc));
  }
  if (razones.length < 100) return [0, Number.POSITIVE_INFINITY];
  razones.sort((x, y) => x - y);
  const q = (p: number) => razones[Math.min(razones.length - 1, Math.floor(razones.length * p))]!;
  return [Math.round(q(0.025) * 1000) / 1000, Math.round(q(0.975) * 1000) / 1000];
}

export function analizar(bloques: BloqueExperimento[]): AnalisisExperimento {
  const alineado = acumular(bloques.filter((b) => b.alineado));
  const control = acumular(bloques.filter((b) => !b.alineado));
  const phi = sobredispersion(bloques);
  const necesarios = eventosNecesarios(EFECTO_OBJETIVO, phi);
  const razonPuntual = tasa(control) > 0 ? tasa(alineado) / tasa(control) : 0;

  const suficiente = bloques.length >= BLOQUES_MINIMOS;
  const ic95: [number, number] = suficiente
    ? bootstrapRazon(bloques)
    : [0, Number.POSITIVE_INFINITY];

  const hayMuestra = suficiente
    && alineado.eventos >= necesarios
    && control.eventos >= necesarios;

  // ── El veredicto ──────────────────────────────────────────────────────────
  //
  // El INTERVALO manda, nunca el punto. Y el orden importa:
  //
  // 1. Si el IC excluye 1, ya hay respuesta. La muestra planeada contesta "¿cuanto falta
  //    para poder ver un efecto de 1,20?", que es otra pregunta: cuando el efecto real es
  //    2,8x, el IC lo excluye a 1 mucho antes de llegar a esa cifra. Exigirla igual seria
  //    callar teniendo la respuesta en la mano.
  // 2. Si el IC contiene 1 Y la muestra alcanza para haber visto 1,20, es un empate real.
  // 3. Si el IC contiene 1 con muestra corta, no se sabe todavia.
  // Sin `suficiente &&`: con pocos bloques `ic95` ya vale `[0, Infinity]`, entonces
  // ninguna de las dos comparaciones se cumple. Repetir el guarda seria codigo que
  // ningun test puede distinguir.
  const concluyente = ic95[0] > 1 || ic95[1] < 1;
  const veredicto: Veredicto = concluyente
    ? (ic95[0] > 1 ? 'gana' : 'pierde')
    : hayMuestra ? 'empata'
    : 'sin-muestra';

  return {
    alineado, control,
    razon: Math.round(razonPuntual * 1000) / 1000,
    ic95, sobredispersion: phi, eventosNecesarios: necesarios,
    hayMuestra, veredicto,
  };
}

// ── Fase por rejilla: mover la fase sin pagar throughput ─────────────────────

/**
 * ¿Cuantos segundos hasta el siguiente punto de la rejilla?
 *
 * ── El problema que resuelve ─────────────────────────────────────────────────
 *
 * `alignToReleaseWindow` ESPERA a que llegue el segundo bueno. Medido el 2026-09-01, eso
 * le costo throughput al brazo alineado: hueco p50 de 98,2 s contra 75,9 s del control,
 * o sea 23 s de mas por vuelta. Un brazo con menos polls por hora tiene menos
 * oportunidades, y la comparacion deja de medir la fase.
 *
 * Una rejilla no espera. Los instantes de aterrizaje son `fase, fase + periodo,
 * fase + 2*periodo, ...`, entonces el intervalo es SIEMPRE `periodo` y la fase es un
 * parametro libre. Mismo numero de polls, distinto lugar dentro del minuto.
 *
 * ── Por que el periodo divide a 60 ──────────────────────────────────────────
 *
 * Con `periodo = 20` los aterrizajes caen en `fase`, `fase+20` y `fase+40` de cada
 * minuto, siempre los mismos tres segundos. Con un periodo que no divide a 60 (23, por
 * ejemplo) el segundo de aterrizaje va corriendo minuto a minuto y la fase deja de
 * significar algo. `periodoValido()` lo comprueba.
 *
 * Devuelve el retraso en segundos, siempre en `(0, periodo]`.
 */
export function siguienteEnRejilla(args: {
  nowMs: number;
  periodoSec: number;
  faseSec: number;
  /** Piso del retraso, para no encadenar un poll inmediato. */
  minSec?: number;
}): number {
  const periodo = Math.max(1, Math.round(args.periodoSec));
  // Sin `% periodo`: la rejilla ya es modular, entonces `fase = 45` con periodo 20
  // aterriza en los mismos instantes que `fase = 5`. Normalizarla seria codigo que
  // ningun test puede distinguir. `Math.round` SI hace falta: una fase fraccionaria
  // corre el aterrizaje dentro del segundo.
  const fase = Math.round(args.faseSec);
  const min = Math.max(0, args.minSec ?? 0);

  const ahoraSec = args.nowMs / 1000;
  const desde = ahoraSec + min;
  // Primer punto de la rejilla en o despues de `desde`.
  const k = Math.ceil((desde - fase) / periodo);
  let objetivo = fase + k * periodo;
  // `Math.ceil` puede devolver el instante exacto de `desde`; con `min = 0` eso seria un
  // retraso de cero. Se empuja un periodo.
  if (objetivo <= ahoraSec) objetivo += periodo;
  return Math.round((objetivo - ahoraSec) * 1000) / 1000;
}

/** Un periodo sirve para fijar la fase solo si divide a 60. */
export function periodoValido(periodoSec: number): boolean {
  return Number.isInteger(periodoSec) && periodoSec > 0 && 60 % periodoSec === 0;
}

/** Periodos usables, de mas polls a menos. */
export const PERIODOS = [10, 12, 15, 20, 30, 60] as const;

/**
 * Periodo de la rejilla a partir del intervalo natural: el divisor de 60 mas cercano
 * que NO aumente la carga, o sea el primero mayor o igual al intervalo.
 *
 * Nunca se elige uno mas corto: mas polls por minuto contra el portal es exactamente
 * como se gana un bloqueo de cuenta, y este experimento no lo vale.
 */
export function periodoDesdeIntervalo(intervaloSec: number): number {
  for (const p of PERIODOS) if (p >= intervaloSec) return p;
  return 60;
}

/**
 * Fase sorteada por (bot, minuto). Determinista, entonces al analizar se recalcula sin
 * guardar nada, igual que `asignadoAlineado`.
 *
 * Sortear la fase CADA MINUTO hace dos cosas a la vez: reparte los aterrizajes por todo
 * el minuto a lo largo del dia, y convierte el minuto en un bloque. Los eventos vienen
 * en rafaga (medido: 20,5% de los minutos tienen evento, y esos tienen 2,64), entonces
 * comparar segundos DENTRO del mismo minuto quita la parte del ruido que mas estorba: la
 * sobredispersion medida baja de 6,52 por bot-hora a 2,89 por bot-minuto.
 */
export function faseAleatoria(botId: number, nowMs: number, periodoSec: number): number {
  const minuto = Math.floor(nowMs / 60_000);
  // Hash entero de (bot, minuto). Mismo mezclador que el PRNG, sin estado.
  let t = (Math.imul(minuto, 0x9e3779b1) ^ Math.imul(botId, 0x85ebca6b)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return Math.floor(u * Math.max(1, Math.round(periodoSec)));
}

// ── Curva por segundo del minuto ─────────────────────────────────────────────

export interface FilaSegundo {
  /** Segundo del minuto en que ARRANCO el fetch, 0..59. */
  segundo: number;
  polls: number;
  eventos: number;
}

export interface PuntoCurva {
  segundo: number;
  polls: number;
  eventos: number;
  /** Eventos por 1.000 polls, sin suavizar. */
  porMil: number;
  /** Eventos por 1.000 polls, suavizado en la vecindad circular. */
  suave: number;
}

/**
 * Radio del suavizado, en segundos a cada lado.
 *
 * 2 segundos y no 0: con 60 baldes independientes cada uno recibe la sesentava parte de
 * los eventos, y una tasa sobre 10 eventos salta demasiado para leer un pico. 2 y no 5:
 * la rafaga de liberacion dura pocos segundos, y un radio grande la aplana hasta
 * borrarla.
 */
export const RADIO_SUAVE = 2;

/**
 * Tasa por segundo del minuto, con suavizado CIRCULAR.
 *
 * Circular porque el segundo 59 y el 0 son vecinos: un pico a caballo del cambio de
 * minuto se partiria en dos con un suavizado lineal.
 *
 * El suavizado pesa por polls, no por segundo: un balde con 10 polls no puede mover la
 * curva igual que uno con 1.000.
 */
export function curvaPorSegundo(filas: FilaSegundo[], radio = RADIO_SUAVE): PuntoCurva[] {
  const polls = new Array(60).fill(0);
  const ev = new Array(60).fill(0);
  for (const f of filas) {
    const s = ((Math.round(f.segundo) % 60) + 60) % 60;
    polls[s] += f.polls;
    ev[s] += f.eventos;
  }
  const out: PuntoCurva[] = [];
  for (let s = 0; s < 60; s++) {
    let p = 0, e = 0;
    for (let d = -radio; d <= radio; d++) {
      const k = (s + d + 60) % 60;
      p += polls[k]; e += ev[k];
    }
    out.push({
      segundo: s, polls: polls[s], eventos: ev[s],
      porMil: polls[s] > 0 ? Math.round((10_000 * ev[s]) / polls[s]) / 10 : 0,
      suave: p > 0 ? Math.round((10_000 * e) / p) / 10 : 0,
    });
  }
  return out;
}

/**
 * Ventana de `ancho` segundos con la tasa suavizada mas alta.
 *
 * Devuelve el arranque y la tasa. Con `polls` insuficientes en toda la vuelta devuelve
 * `null`, porque un pico sobre nada es ruido con nombre.
 */
export function mejorVentana(
  curva: PuntoCurva[],
  ancho: number,
  minPollsVentana = 500,
): { startSec: number; endSec: number; porMil: number } | null {
  if (curva.length !== 60 || ancho < 1 || ancho > 60) return null;
  let mejor: { startSec: number; endSec: number; porMil: number } | null = null;
  for (let s = 0; s < 60; s++) {
    let p = 0, e = 0;
    for (let d = 0; d < ancho; d++) {
      const k = curva[(s + d) % 60]!;
      p += k.polls; e += k.eventos;
    }
    if (p < minPollsVentana) continue;
    const tasa = Math.round((10_000 * e) / p) / 10;
    if (!mejor || tasa > mejor.porMil) mejor = { startSec: s, endSec: (s + ancho) % 60, porMil: tasa };
  }
  return mejor;
}

// ── Mensaje diario ───────────────────────────────────────────────────────────

export interface ReporteFase {
  dias: number;
  curva: PuntoCurva[];
  /** Analisis dentro/fuera de la ventana configurada. */
  configurada: { ventana: { startSec: number; endSec: number }; analisis: AnalisisExperimento };
  /** La mejor ventana medida, y su analisis. Ojo: la ventana se eligio MIRANDO estos datos. */
  mejor: { ventana: { startSec: number; endSec: number }; analisis: AnalisisExperimento } | null;
  /** Hueco p50 antes del poll, dentro y fuera de la ventana configurada, en segundos. */
  huecoDentroSec: number;
  huecoFueraSec: number;
  /** Fraccion de huecos que cae sobre la rejilla. Dice si el mecanismo esta puesto. */
  enRejilla: number;
  /** Periodo de la rejilla que se esta usando, en segundos. */
  periodoSec: number;
}

/** Los huecos tienen que parecerse para que la razon signifique algo. */
export const SESGO_HUECO_MAX = 1.25;

export function huecosComparables(dentro: number, fuera: number): boolean {
  // Sin guarda explicita de `NaN` ni de cero: `NaN` e `Infinity` fallan las DOS
  // comparaciones, entonces caen solos en `false`. Un guarda aparte seria codigo que
  // ningun test puede distinguir.
  //
  // Los dos lados hacen falta. El sesgo puede correr en cualquier direccion: con el
  // mecanismo viejo los polls de dentro traian huecos MAS LARGOS (177 s contra 85 s), y
  // un fallo de la rejilla podria dejarlos mas cortos, que enmascararia el efecto en vez
  // de inflarlo.
  const c = dentro / fuera;
  return c <= SESGO_HUECO_MAX && c >= 1 / SESGO_HUECO_MAX;
}

/**
 * Mensaje para Telegram.
 *
 * El aviso de huecos va SIEMPRE cuando aplica, y va antes del numero. Un lector que ve
 * "2,8x, gana" sin saber que los huecos estan al doble toma una decision sobre un
 * artefacto, y eso ya paso el 2026-09-01.
 */
export function textoTelegramFase(r: ReporteFase): string {
  const a = r.configurada.analisis;
  const w = r.configurada.ventana;
  const limpio = huecosComparables(r.huecoDentroSec, r.huecoFueraSec);

  const titulo = !limpio
    ? '⚠️ *Fase: la muestra esta contaminada*'
    : a.veredicto === 'gana' ? '🟢 *Fase: la ventana GANA*'
    : a.veredicto === 'pierde' ? '🔴 *Fase: la ventana PIERDE*'
    : a.veredicto === 'empata' ? '⚪ *Fase: empate, con muestra suficiente*'
    : '⏳ *Fase: sin veredicto todavia*';

  const lineas = [
    titulo,
    `${r.dias} d · ventana s${w.startSec}-${(w.endSec + 59) % 60}`,
    '',
    `dentro  ${a.alineado.porMil} por mil  (${a.alineado.eventos} eventos)`,
    `fuera   ${a.control.porMil} por mil  (${a.control.eventos} eventos)`,
    `razon ${a.razon}  IC95 [${a.ic95[0]}, ${a.ic95[1]}]`,
  ];

  if (!limpio) {
    lineas.push('');
    lineas.push(`Hueco antes del poll: dentro ${Math.round(r.huecoDentroSec)} s, fuera ${Math.round(r.huecoFueraSec)} s.`);
    lineas.push('Con huecos distintos, la razon mide el hueco y no la fase. No decidas con esto.');
    // La fraccion en rejilla dice si esperar sirve. Si la rejilla esta puesta, los huecos
    // se van limpiando solos; si no lo esta, esperar no arregla nada.
    lineas.push(`Rejilla de ${r.periodoSec} s: ${Math.round(100 * r.enRejilla)}% de los huecos.`);
  } else if (a.veredicto === 'sin-muestra') {
    lineas.push('');
    lineas.push(`Faltan eventos: ${Math.max(0, a.eventosNecesarios - a.alineado.eventos)} dentro y ` +
      `${Math.max(0, a.eventosNecesarios - a.control.eventos)} fuera.`);
  }

  if (r.mejor) {
    const m = r.mejor;
    lineas.push('');
    lineas.push(`mejor ventana medida s${m.ventana.startSec}-${(m.ventana.endSec + 59) % 60} · ` +
      `${m.analisis.alineado.porMil} por mil · razon ${m.analisis.razon}`);
    // La ventana se eligio mirando estos mismos datos, entonces su cifra viene inflada.
    // Sirve para proponer la ventana siguiente, nunca para declarar un hallazgo.
    lineas.push('(elegida mirando estos datos: sirve para proponer, no para concluir)');
  }
  return lineas.join('\n');
}

/**
 * ¿Que fraccion de los huecos cae sobre la rejilla?
 *
 * ── Por que hace falta medirlo ──────────────────────────────────────────────
 *
 * El 2026-09-02 dí por hecho que la rejilla no estaba funcionando porque no aparecia su
 * linea en `journalctl`. Estaba equivocado: journalctl muestra `console.log`, y esa linea
 * es un `logger.info`, que va a la plataforma de Trigger.dev. La ausencia de un log no
 * prueba nada.
 *
 * Lo que si prueba es el DATO. Con la rejilla puesta, los huecos entre polls encadenados
 * caen en multiplos del periodo. Medido despues del despliegue, el bot 301 encadeno
 * `20, 20, 20, 21` con la fase estable: la firma es inconfundible.
 *
 * Los huecos que NO caen en la rejilla son del cron de 2 minutos y de los backoffs, que
 * la rejilla no controla. Entonces la fraccion nunca llega a 1 y no tiene que llegar.
 *
 * `tolerancia` en segundos absorbe el tiempo que tarda el propio poll.
 */
export function fraccionEnRejilla(huecosSec: number[], periodoSec: number, tolerancia = 1.5): number {
  const utiles = huecosSec.filter((h) => Number.isFinite(h) && h > 0 && h <= 600);
  if (utiles.length === 0) return 0;
  const p = Math.max(1, periodoSec);
  let dentro = 0;
  for (const h of utiles) {
    const resto = h % p;
    // Cerca de un multiplo por arriba o por abajo: `resto` chico o casi igual al periodo.
    if (Math.min(resto, p - resto) <= tolerancia) dentro += 1;
  }
  return Math.round((dentro / utiles.length) * 1000) / 1000;
}

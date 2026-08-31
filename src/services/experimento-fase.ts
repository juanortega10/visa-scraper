/**
 * Experimento de alineacion de fase: ¿sirve mover el poll al segundo donde el portal
 * libera cupos?
 *
 * ── Lo que se sabe, medido ──────────────────────────────────────────────────
 *
 * `analyze-release-clock.ts` sobre 30 dias y 66.722 filas de es-co, contando solo
 * fechas a menos de 6 meses y reconstruyendo el momento del fetch:
 *
 *     tramo    tasa   vs media
 *     14-15s   7.7%    1.18x
 *     18-19s  11.3%    1.72x
 *     20-21s  15.2%    2.31x
 *     22-23s  18.7%    2.84x
 *     24-25s  19.8%    3.01x   <- pico
 *     26-27s  19.6%    2.99x
 *     28-29s  19.7%    2.99x
 *     30-31s  18.2%    2.77x
 *     32-33s  12.6%    1.92x
 *     36-37s   4.7%    0.71x   <- por debajo de la media
 *
 * Concentracion por ventana candidata:
 *
 *     s18-35  18s  30,2% de polls  73,1% de cupos cercanos  2,42x
 *     s20-33  14s  22,3%           61,1%                    2,74x
 *     s22-31  10s  15,1%           45,4%                    3,01x
 *     s24-29   6s   9,0%           27,5%                    3,05x
 *
 * ── Por que la ventana pasa de 18 a 10 segundos ─────────────────────────────
 *
 * La alineacion NO cambia cuantos polls se hacen, cambia DONDE caen. Entonces lo
 * que importa es la tasa por poll, no la cobertura absoluta. Una ventana de 18 s
 * incluye s18-19 (1,72x) y s32-35 (1,92x y 1,21x), que arrastran el promedio hacia
 * abajo. Apretar a s22-32 sube la tasa esperada por poll de 2,42x a ~3,0x.
 *
 * No se aprieta mas: con es-co en 20-30 s de intervalo caben 2 o 3 polls por minuto,
 * y una ventana de 6 s no deja lugar para el jitter ni para que el poll se corra.
 *
 * ── El diseno del experimento ───────────────────────────────────────────────
 *
 * Comparar unos bots contra otros NO sirve: quedan 5 bots es-co activos y cada uno
 * tiene su cita, su ciudad y su ritmo. Cinco contra cero no da senal.
 *
 * Por eso cada bot es su PROPIO control y alterna por hora. En cualquier hora
 * aproximadamente la mitad de la flota esta alineada, y a lo largo de un dia cada
 * bot pasa por las dos condiciones en todas las horas. Eso controla la identidad del
 * bot y la hora del dia a la vez, que son los dos factores que mas mueven la tasa.
 *
 * La asignacion es DETERMINISTA a partir de (hora, botId). No se guarda en ninguna
 * parte: al reportar se recalcula para cada fila de `poll_logs` con su propia hora.
 * Sin tabla nueva y sin riesgo de que el registro y la realidad se separen.
 */

/** Ventana apretada que usa el brazo ALINEADO. Ver la tabla de arriba. */
export const VENTANA_EXPERIMENTO: Record<string, { startSec: number; endSec: number }> = {
  'es-co': { startSec: 22, endSec: 32 },
};

/** Horas UTC completas desde la epoca. Es la unidad de alternancia. */
export function horaEpoca(ahoraMs: number): number {
  return Math.floor(ahoraMs / 3_600_000);
}

/**
 * ¿Le toca alinearse a este bot en esta hora?
 *
 * `(hora + botId) % 2` y no `hora % 2` a proposito: con `hora % 2` toda la flota
 * cambiaria de brazo al mismo tiempo, y cualquier cosa que le pase al portal en una
 * hora concreta caeria entera sobre un solo brazo. Sumando el `botId` los dos brazos
 * coexisten en cada hora y el efecto del portal se reparte.
 */
export function asignadoAlineado(botId: number, ahoraMs: number): boolean {
  return (horaEpoca(ahoraMs) + botId) % 2 === 0;
}

// ── Lectura de resultados ────────────────────────────────────────────────────

export interface FilaPoll {
  botId: number;
  /** Momento del poll. Se usa su hora para recalcular el brazo. */
  enMs: number;
  /** Polls REALES que representa la fila (`polls_since_prev`). */
  polls: number;
  /** Cupos a menos de 6 meses que aparecieron en ese poll. */
  cercanos: number;
}

export interface BrazoResumen {
  polls: number;
  cercanos: number;
  /** Cupos cercanos por cada 1.000 polls reales. Es la unica cifra comparable. */
  porMil: number;
}

export interface ResumenExperimento {
  alineado: BrazoResumen;
  control: BrazoResumen;
  /** `alineado.porMil / control.porMil`. 1 = no hay diferencia. */
  mejora: number;
  /** true cuando los DOS brazos tienen suficiente para que la cifra signifique algo. */
  hayMuestra: boolean;
  /** Polls minimos por brazo que exige `hayMuestra`. */
  minimoPorBrazo: number;
}

/**
 * Muestra minima por brazo antes de creerle al numero.
 *
 * Con la tasa base de es-co (unos 66 cupos cercanos por cada 1.000 polls), 20.000
 * polls por brazo dan del orden de 1.300 eventos, y ahi una diferencia de 20% ya se
 * distingue del ruido. Por debajo de eso el cociente salta de un dia a otro y lleva
 * a concluir cualquier cosa.
 */
export const MIN_POLLS_POR_BRAZO = 20_000;

export function resumirExperimento(filas: FilaPoll[]): ResumenExperimento {
  const vacio = (): { polls: number; cercanos: number } => ({ polls: 0, cercanos: 0 });
  const a = vacio();
  const c = vacio();
  for (const f of filas) {
    const dest = asignadoAlineado(f.botId, f.enMs) ? a : c;
    dest.polls += f.polls;
    dest.cercanos += f.cercanos;
  }
  const porMil = (x: { polls: number; cercanos: number }) =>
    x.polls > 0 ? Math.round((10_000 * x.cercanos) / x.polls) / 10 : 0;
  const alineado: BrazoResumen = { ...a, porMil: porMil(a) };
  const control: BrazoResumen = { ...c, porMil: porMil(c) };
  return {
    alineado,
    control,
    mejora: control.porMil > 0 ? Math.round((100 * alineado.porMil) / control.porMil) / 100 : 0,
    hayMuestra: a.polls >= MIN_POLLS_POR_BRAZO && c.polls >= MIN_POLLS_POR_BRAZO,
    minimoPorBrazo: MIN_POLLS_POR_BRAZO,
  };
}

/**
 * Mensaje diario para Telegram.
 *
 * Dice el veredicto en la primera linea, porque es lo unico que se lee en una
 * notificacion. Y cuando NO hay muestra lo dice en vez de mostrar un cociente que
 * todavia no significa nada: un experimento que reporta un ganador demasiado pronto
 * es peor que uno que calla.
 */
export function textoTelegramExperimento(r: ResumenExperimento, dias: number): string {
  const pct = (r.mejora - 1) * 100;
  const titulo = !r.hayMuestra
    ? '⏳ *Fase alineada: sin veredicto todavia*'
    : r.mejora >= 1.15 ? '🟢 *Fase alineada: GANA*'
    : r.mejora <= 0.9 ? '🔴 *Fase alineada: PIERDE*'
    : '⚪ *Fase alineada: empata*';

  const falta = r.hayMuestra
    ? ''
    : `\nFalta muestra: ${Math.max(0, r.minimoPorBrazo - r.alineado.polls).toLocaleString('es-CO')} polls alineados y ` +
      `${Math.max(0, r.minimoPorBrazo - r.control.polls).toLocaleString('es-CO')} de control.`;

  return [
    titulo,
    `${dias} d · s${VENTANA_EXPERIMENTO['es-co']!.startSec}-${VENTANA_EXPERIMENTO['es-co']!.endSec - 1}`,
    '',
    `alineado  ${r.alineado.porMil} cupos/1.000 polls  (${r.alineado.polls.toLocaleString('es-CO')} polls)`,
    `control   ${r.control.porMil} cupos/1.000 polls  (${r.control.polls.toLocaleString('es-CO')} polls)`,
    '',
    r.hayMuestra
      ? `diferencia ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`
      : 'la diferencia se reporta cuando los dos brazos lleguen a la muestra minima.',
  ].join('\n') + falta;
}

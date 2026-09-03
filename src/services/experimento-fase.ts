import { RAFAGA_LIBERACION } from './mejores-practicas.js';

/**
 * Ventana de liberacion del portal para el experimento de fase.
 *
 * ── Lo que queda aqui, y lo que se fue ──────────────────────────────────────
 *
 * El 2026-09-01 este archivo tenia el diseño de dos brazos por hora (`asignadoAlineado`)
 * y su lectura por poll (`resumirExperimento`). Los dos se retiraron:
 *
 *   - Los brazos por hora hacian que el bot ENTERO cayera en un brazo durante una hora,
 *     entonces la unidad aleatorizada era el bot-hora. Leer por poll fingia 20.445
 *     observaciones donde habia 159 bloques, y producia `p = 0,005` sobre un empate.
 *   - Ademas el brazo alineado ESPERABA para entrar a la ventana, y esa espera le costaba
 *     throughput: hueco p50 de 98,2 s contra 75,9 s. El experimento medía el hueco.
 *
 * El reemplazo vive en `src/services/experimento-estadistica.ts`: fase por rejilla
 * sorteada cada minuto, brazo tomado del segundo en que REALMENTE aterrizo el poll,
 * muestra contada en eventos, e intervalo por bootstrap de bloques.
 *
 * Esta constante se queda porque sigue siendo la ventana que se esta probando.
 *
 * ── El experimento original: ¿sirve mover el poll al segundo de la liberacion? ──
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
 */

/**
 * Ventana contra la que reporta el centinela. Se DERIVA de la rafaga, para que no puedan
 * separarse: el 2026-09-03 el reporte seguia midiendo contra s22-31 mientras la flota ya
 * polleaba en s14-s21, y esa cifra no decia nada sobre lo que estaba pasando.
 *
 * OJO con la tabla de arriba: sus tramos vienen de datos con huecos largos, donde la
 * meseta de `appeared` es muy ancha. Por eso el pico aparente cae en s24-s25 y el borde
 * real esta en s11-s13. Ver `mejores-practicas.ts`.
 */
export const VENTANA_EXPERIMENTO: Record<string, { startSec: number; endSec: number }> =
  Object.fromEntries(
    Object.entries(RAFAGA_LIBERACION).map(([loc, r]) => [
      loc, { startSec: r.inicioSec, endSec: (r.inicioSec + r.anchoSec + 1) % 60 },
    ]),
  );

/**
 * Verificador de cadenas dormidas.
 *
 * Una cadena dormida es un bot que figura `active`, con `updated_at` fresco, y que
 * lleva horas sin pollear. Ver [[cadena-dormida-delayed-run]]. El caso que motivo
 * este archivo: el bot 281 estuvo 63 h sin un solo poll (2026-08-27 17:51 al
 * 2026-08-30 09:06 Bogota) y ninguna capa lo reporto.
 *
 * El runtime ya tiene un despertador: `poll-visa.ts` cancela el run DELAYED viejo
 * cuando `debeDespertar()` da true. Este archivo NO repite esa regla, la VERIFICA.
 * Usa la misma funcion y le suma un margen: si el despertador hace su trabajo, este
 * verificador nunca reporta nada. Cuando reporta, el despertador fallo de verdad.
 *
 * La logica vive aparte del script y del cron para que los tests la ejecuten sin DB.
 */
import { debeDespertar, countSustainedAccountBans, type RecentBlockRow } from './scheduling.js';

/**
 * Margen sobre el umbral del despertador antes de declarar una cadena dormida.
 *
 * El despertador actua dentro de un run del cron, y el cron corre cada 2 min. Con
 * 15 min de margen, un despertar normal ya paso hace rato cuando el verificador
 * mira. Esto elimina los falsos positivos de la ventana entre ambos.
 */
export const MARGEN_VERIFICADOR_MS = 15 * 60_000;

/** Un bot recien activado necesita este tiempo antes de que se le exija un poll. */
export const GRACIA_ARRANQUE_MS = 30 * 60_000;

/**
 * Silencio a partir del cual un bot se reporta aunque su backoff lo justifique.
 *
 * La curva de `schedule_blocked` llega a 720 min, y con el factor 1,5 la tolerancia
 * sube a 1.096 min: 18 h de silencio sin una sola alerta. El 2026-08-30 eso apago
 * 9 de 14 bots `dev` en 13 h, de a uno por hora, y nadie se entero. Bastan 2 filas
 * `schedule_blocked` seguidas para mandar un bot a 8 h de silencio.
 *
 * Un bot asi no esta roto, y tampoco esta dando servicio. Se reporta aparte de
 * `dormida` para no confundir las dos cosas.
 */
export const BACKOFF_LARGO_MS = 120 * 60_000;

export type Veredicto = 'ok' | 'dormida' | 'nunca_polleo' | 'backoff_largo';

export interface EntradaCadena {
  botId: number;
  locale: string;
  status: string;
  entornos: string[];
  /** Fecha de la fila mas nueva de `poll_logs`. `null` = el bot nunca polleo. */
  ultimoPoll: Date | null;
  /** Ultimas filas de `poll_logs`, de la mas nueva a la mas vieja. */
  ultimas: RecentBlockRow[];
  activatedAt: Date | null;
}

export interface ResultadoCadena {
  botId: number;
  locale: string;
  status: string;
  entornos: string[];
  veredicto: Veredicto;
  minSinPoll: number | null;
  bansSeguidos: number;
  blockCls: string | null;
  /** Minutos de silencio a partir de los cuales este bot cuenta como dormido. */
  toleranciaMin: number;
}

/**
 * Evalua una cadena. Funcion pura: recibe `ahora` para que los tests fijen el reloj.
 */
export function evaluarCadena(entrada: EntradaCadena, ahora: number): ResultadoCadena {
  const { botId, locale, status, entornos, ultimoPoll, ultimas, activatedAt } = entrada;
  const bansSeguidos = countSustainedAccountBans(ultimas);
  const blockCls = ultimas[0]?.blockCls ?? null;

  const base = {
    botId, locale, status, entornos, bansSeguidos, blockCls,
  };

  if (!ultimoPoll) {
    // Sin ninguna fila. Solo cuenta si el bot lleva activado mas que la gracia.
    const msDesdeAlta = activatedAt ? ahora - activatedAt.getTime() : Number.MAX_SAFE_INTEGER;
    return {
      ...base,
      veredicto: msDesdeAlta > GRACIA_ARRANQUE_MS ? 'nunca_polleo' : 'ok',
      minSinPoll: null,
      toleranciaMin: Math.round(GRACIA_ARRANQUE_MS / 60_000),
    };
  }

  const msSinPoll = ahora - ultimoPoll.getTime();

  // Busca el silencio mas corto que el despertador ya considera excesivo, y le suma
  // el margen. Se resuelve por busqueda binaria contra `debeDespertar` para que el
  // umbral salga siempre de esa funcion, nunca de una copia de la curva de backoff.
  const umbralMs = umbralDespertadorMs({ bansSeguidos, blockCls });
  const toleranciaMs = umbralMs + MARGEN_VERIFICADOR_MS;

  const veredicto: Veredicto = msSinPoll > toleranciaMs
    ? 'dormida'
    : msSinPoll > BACKOFF_LARGO_MS
      ? 'backoff_largo'
      : 'ok';

  return {
    ...base,
    veredicto,
    minSinPoll: Math.round(msSinPoll / 60_000),
    toleranciaMin: Math.round(toleranciaMs / 60_000),
  };
}

/**
 * Silencio minimo que `debeDespertar` considera excesivo, en ms.
 *
 * Se obtiene preguntandole a `debeDespertar`, nunca recalculando la curva. Asi el
 * verificador sigue al runtime aunque la curva cambie. Busqueda binaria sobre
 * [0, 24 h] con 1 min de resolucion.
 */
export function umbralDespertadorMs(args: { bansSeguidos: number; blockCls: string | null }): number {
  const MINUTO = 60_000;
  let bajo = 0;
  let alto = 24 * 60 * MINUTO;
  if (!debeDespertar({ msSinPoll: alto, bansSeguidos: args.bansSeguidos, blockCls: args.blockCls })) {
    return alto;
  }
  while (alto - bajo > MINUTO) {
    const medio = Math.floor((bajo + alto) / 2);
    if (debeDespertar({ msSinPoll: medio, bansSeguidos: args.bansSeguidos, blockCls: args.blockCls })) {
      alto = medio;
    } else {
      bajo = medio;
    }
  }
  // Al minuto redondo hacia arriba: el umbral queda estable y legible en los reportes.
  return Math.ceil(alto / MINUTO) * MINUTO;
}

/**
 * Cadenas que exigen accion: `dormida` y `nunca_polleo`. Deja fuera `backoff_largo`,
 * que se reporta aparte con {@link cadenasEnBackoffLargo} porque no requiere despertar
 * nada, solo saber que ese bot no da servicio.
 */
export function cadenasConProblema(resultados: ResultadoCadena[]): ResultadoCadena[] {
  return resultados
    .filter((r) => r.veredicto === 'dormida' || r.veredicto === 'nunca_polleo')
    .sort((a, b) => (b.minSinPoll ?? Number.MAX_SAFE_INTEGER) - (a.minSinPoll ?? Number.MAX_SAFE_INTEGER));
}

/** Cadenas calladas por un backoff largo pero legitimo, de mas callada a menos. */
export function cadenasEnBackoffLargo(resultados: ResultadoCadena[]): ResultadoCadena[] {
  return resultados
    .filter((r) => r.veredicto === 'backoff_largo')
    .sort((a, b) => (b.minSinPoll ?? 0) - (a.minSinPoll ?? 0));
}

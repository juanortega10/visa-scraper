/**
 * Las tres decisiones que mantienen viva la cadena de un bot, en un solo lugar.
 *
 * Hay tres guardianes y cada uno decide por su cuenta:
 *
 *   1. `poll-cron` cada 2 min: dispara un run salvo que ya haya uno vivo.
 *   2. El DEDUP FALLBACK de `poll-visa`: dentro de un run, cancela el DELAYED viejo si
 *      el silencio ya paso el backoff.
 *   3. `ensure-chain` cada 10 min: cancela y re-dispara lo que quedo colgado.
 *
 * El problema de tener la regla escrita tres veces es que se puede abrir un hueco donde
 * NINGUNO actua. Paso el 2026-08-31 con los bots 240 (69 min) y 223 (64 min): `poll-cron`
 * veia el run DELAYED y hacia `continue`, el despertador de `poll-visa` vive dentro de un
 * run que por eso nunca existia, y `ensure-chain` devolvia `cron_ok` sin mirar el reloj.
 * Los tres se pasaban la pelota y el bot quedaba dormido para siempre.
 *
 * Estas funciones son la fuente unica de esas decisiones. El test las barre de forma
 * exhaustiva y verifica la invariante: pasado el techo, alguno actua siempre.
 */
import { debeDespertar } from './scheduling.js';

/** Estados en que Trigger.dev considera un run pendiente o corriendo. */
export const ESTADOS_VIVOS = ['EXECUTING', 'DELAYED', 'QUEUED', 'DEQUEUED', 'WAITING'];

/**
 * Techo absoluto de silencio, en minutos.
 *
 * Ningun bot activo puede pasar de aca sin que alguien actue, por mas bloqueado que
 * este. La curva mas larga (`schedule_blocked`, 720 min) por el margen de 1,5 da 1.080,
 * y se redondea a 1.140 (19 h) para cubrir el jitter del cron de 10 min.
 */
export const TECHO_SILENCIO_MIN = 1_140;

/**
 * Silencio con un run en EXECUTING a partir del cual ese run se da por colgado.
 *
 * Un run de `poll-visa` vive segundos o pocos minutos, y mientras trabaja escribe. Un
 * EXECUTING que lleva media hora sin dejar una sola fila esta trabado, y nadie lo tocaba:
 * `poll-cron` respeta el run vivo y `ensure-chain` devolvia `false` para EXECUTING sin
 * mirar el reloj. El barrido exhaustivo de `guardianes-invariante.test.ts` encontro ese
 * hueco el 2026-08-31.
 */
export const TECHO_EXECUTING_MIN = 30;

export interface EstadoCadena {
  /** Estado del run al que apunta `activeRunId`, o `null` si no hay run. */
  status: string | null;
  /** Minutos desde la fila mas nueva de `poll_logs`. */
  minSinPoll: number;
  /** Bloqueos sostenidos seguidos, de `countSustainedAccountBans`. */
  bansSeguidos: number;
  blockCls: string | null;
}

/**
 * ¿`poll-cron` dispara un run nuevo? Refleja `poll-cron.ts:52-71`.
 *
 * Salta cuando hay un run vivo, con una excepcion: un `EXECUTING` de mas de 3 min se
 * toma por huerfano (reinicio del worker, deploy).
 */
export function cronDispara(status: string | null, edadRunMs = 0): boolean {
  if (!status) return true;
  if (!ESTADOS_VIVOS.includes(status)) return true;
  if (status === 'EXECUTING' && edadRunMs > 180_000) return true;
  return false;
}

/**
 * ¿`ensure-chain` cancela y re-dispara? Refleja la rama de bloqueo de `ensure-chain.ts`.
 *
 * Con un run vivo solo actua si el silencio ya paso el backoff que le toca al bot. Sin
 * run vivo actua salvo que el bot haya polleado hace poco.
 */
export function ensureChainActua(e: EstadoCadena, silencioCronMin: number): boolean {
  const msSinPoll = e.minSinPoll * 60_000;
  const vencido = debeDespertar({
    msSinPoll,
    bansSeguidos: e.bansSeguidos,
    blockCls: e.blockCls,
  });

  // Un EXECUTING que no escribe hace media hora esta colgado, no trabajando.
  if (e.status === 'EXECUTING') return e.minSinPoll >= TECHO_EXECUTING_MIN;
  if (e.status === 'DELAYED' || e.status === 'QUEUED') return vencido;
  // Run terminal o inexistente: se respeta la actividad reciente.
  return e.minSinPoll >= silencioCronMin;
}

/**
 * La invariante del sistema: pasado el techo, alguno de los guardianes actua.
 *
 * Devuelve `true` si el bot puede quedar dormido sin que nadie lo levante. En un sistema
 * sano esto es `false` para todo estado cuyo silencio pase {@link TECHO_SILENCIO_MIN}.
 */
export function quedaHuerfano(e: EstadoCadena, silencioCronMin: number): boolean {
  if (cronDispara(e.status)) return false;
  if (ensureChainActua(e, silencioCronMin)) return false;
  return true;
}

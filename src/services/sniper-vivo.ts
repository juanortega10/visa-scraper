/**
 * Vigilante de snipers: avisa cuando un sniper deja de escribir en `sniper_scans`.
 *
 * El sniper del bot 299 estuvo apagado 1.083 h de 1.645 h entre el 2026-08-28 y el
 * 2026-10-27, y nadie aviso. `audit-chains` no lo ve porque el bot tiene
 * `pollEnvironments: []`. El sniper escribe un latido cada 5 min aunque nada cambie,
 * entonces 10 min sin filas significa que el proceso no corre.
 */

/** Snipers a vigilar. El bot tiene que estar `active` para que el silencio cuente. */
export const SNIPERS_VIGILADOS = [{ scanKey: 'peru-299', botId: 299 }] as const;

/** Minutos sin filas a partir de los cuales el sniper se da por caido. */
export const UMBRAL_SNIPER_MIN = 10;

/** Cada cuanto se repite el aviso mientras siga caido. */
export const REPETIR_AVISO_MIN = 60;

export interface EstadoSniper {
  scanKey: string;
  botId: number;
  botActivo: boolean;
  /** Epoch ms de la fila mas nueva, o null si no hay ninguna. */
  ultimoMs: number | null;
}

export interface SniperCaido {
  scanKey: string;
  botId: number;
  /** Minutos desde la ultima fila. null = nunca escribio. */
  minutos: number | null;
}

/** Devuelve los snipers caidos. Un bot pausado no cuenta. */
export function snipersCaidos(
  estados: EstadoSniper[],
  ahoraMs: number,
  umbralMin = UMBRAL_SNIPER_MIN,
): SniperCaido[] {
  const caidos: SniperCaido[] = [];
  for (const e of estados) {
    if (!e.botActivo) continue;
    if (e.ultimoMs === null) { caidos.push({ scanKey: e.scanKey, botId: e.botId, minutos: null }); continue; }
    const minutos = Math.floor((ahoraMs - e.ultimoMs) / 60_000);
    if (minutos >= umbralMin) caidos.push({ scanKey: e.scanKey, botId: e.botId, minutos });
  }
  return caidos;
}

/**
 * True si este ciclo del cron debe avisar. El cron corre cada `cadenciaMin`.
 * Avisa en el primer ciclo que cruza el umbral y despues una vez por hora.
 * Sin esto, un corte de 28 h mandaria 336 mensajes.
 */
export function debeAvisar(
  minutos: number | null,
  cadenciaMin = 5,
  umbralMin = UMBRAL_SNIPER_MIN,
  repetirMin = REPETIR_AVISO_MIN,
): boolean {
  if (minutos === null) return true;
  if (minutos < umbralMin) return false;
  if (minutos < umbralMin + cadenciaMin) return true;
  return Math.floor(minutos / repetirMin) !== Math.floor((minutos - cadenciaMin) / repetirMin);
}

export function textoSniperCaido(c: SniperCaido): string {
  const hace = c.minutos === null ? 'nunca escribio' : `${c.minutos} min sin filas`;
  return [
    `*Sniper caido* · \`${c.scanKey}\` (bot ${c.botId}) · ${hace}`,
    'Revisar en el RPi: `systemctl status peru-sniper-299` y `journalctl -u peru-sniper-299 -n 50`.',
    'Prender: `sudo systemctl start peru-sniper-299`.',
  ].join('\n');
}

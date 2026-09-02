/**
 * Ruta de schedule cerrada: el portal responde, pero la URL del bot no.
 *
 * ── Que es ──────────────────────────────────────────────────────────────────
 *
 * `probeScheduleBlock()` en `proxy-fetch.ts` ya distingue los dos bloqueos. Pide
 * `/users/sign_in` y `/schedule/{id}` a la vez:
 *
 *   dominio cae            -> `account_ban`      curva 30 a 480 min
 *   dominio vive, ruta cae -> `schedule_blocked` curva 240 a 720 min
 *
 * El segundo es un nginx 444 sobre esa ruta. Cambiar de IP, de proxy o de cuenta no
 * sirve: la ruta esta cerrada para todos.
 *
 * ── Por que hace falta un aviso ─────────────────────────────────────────────
 *
 * La clasificacion existe, el aviso no. El 2026-08-30 la ruta del schedule 75610929
 * (bot 299, el de Luiggi) quedo cerrada 17,4 h y nadie se entero. El bot quedaba
 * `active`, `updated_at` fresco, y con el backoff largo pasaba horas entre polls, o
 * sea ni siquiera se veia raro en el tablero.
 *
 * `audit-cadenas-dormidas` NO lo agarra: la cadena esta viva, solo va muy lenta a
 * proposito. `audit-citas-vencidas` tampoco: la cita esta en el futuro.
 *
 * ── La regla y sus dos trampas ──────────────────────────────────────────────
 *
 * 1. La duracion se mide contra AHORA, nunca contra la fila mas nueva. Con la curva
 *    larga pueden pasar 12 h entre dos polls; medir de fila a fila reportaria 0 min
 *    en un corte de medio dia.
 *
 * 2. Solo cuenta si la fila MAS NUEVA sigue bloqueada. Un bloqueo viejo con polls
 *    buenos encima ya se resolvio solo, y avisar de eso entrena a no leer el aviso.
 *
 * El umbral de 60 min sale de la sonda misma: `probeScheduleBlock` ya reintenta la
 * ruta una vez antes de declarar el bloqueo, entonces un fallo de un instante no
 * llega aqui. Lo que dura una hora es un corte de verdad.
 */

export const MINUTOS_ALERTA = 60;
export const MINUTOS_CRITICO = 360;

export interface FilaBloqueo {
  botId: number;
  locale: string;
  scheduleId: string | null;
  /** `tcp_blocked`, `ok`, `filtered_out`, `error`, ... */
  status: string;
  /** `connection_info->>'blockClassification'`. */
  cls: string | null;
  enMs: number;
}

export type SeveridadRuta = 'critico' | 'alto';

export interface RutaCerrada {
  scheduleId: string;
  locale: string;
  bots: number[];
  /** Momento del primer poll del episodio en curso. */
  desdeMs: number;
  minutos: number;
  severidad: SeveridadRuta;
  /** Polls bloqueados del episodio. Con la curva larga son pocos, y eso es normal. */
  polls: number;
}

function esBloqueoDeRuta(f: FilaBloqueo): boolean {
  return f.status === 'tcp_blocked' && f.cls === 'schedule_blocked';
}

/**
 * Episodio EN CURSO de un bot: se camina desde la fila mas nueva hacia atras mientras
 * las filas sigan siendo bloqueo de ruta. La primera fila que no lo sea corta.
 *
 * Devuelve null cuando la fila mas nueva ya no esta bloqueada, o sea cuando el bot
 * volvio a pollear.
 */
function episodioEnCurso(filas: FilaBloqueo[]): { desdeMs: number; polls: number } | null {
  const orden = [...filas].sort((a, b) => b.enMs - a.enMs);
  if (orden.length === 0 || !esBloqueoDeRuta(orden[0]!)) return null;
  let polls = 0;
  let desdeMs = orden[0]!.enMs;
  for (const f of orden) {
    if (!esBloqueoDeRuta(f)) break;
    polls += 1;
    desdeMs = f.enMs;
  }
  return { desdeMs, polls };
}

export function detectarRutasCerradas(filas: FilaBloqueo[], ahoraMs: number): RutaCerrada[] {
  const porBot = new Map<number, FilaBloqueo[]>();
  for (const f of filas) {
    const l = porBot.get(f.botId);
    if (l) l.push(f); else porBot.set(f.botId, [f]);
  }

  // Se agrupa por schedule porque la ruta bloqueada ES el schedule. Dos bots del mismo
  // schedule caen juntos y avisar dos veces del mismo corte es ruido.
  const porRuta = new Map<string, RutaCerrada>();
  for (const [botId, susFilas] of porBot) {
    const ep = episodioEnCurso(susFilas);
    if (!ep) continue;
    const minutos = Math.floor((ahoraMs - ep.desdeMs) / 60_000);
    if (minutos < MINUTOS_ALERTA) continue;

    const cab = susFilas[0]!;
    const clave = cab.scheduleId ?? `bot-${botId}`;
    const previo = porRuta.get(clave);
    if (previo) {
      previo.bots.push(botId);
      previo.polls += ep.polls;
      // El episodio de la ruta empieza con el PRIMER bot que la vio caer.
      if (ep.desdeMs < previo.desdeMs) previo.desdeMs = ep.desdeMs;
    } else {
      porRuta.set(clave, {
        scheduleId: clave, locale: cab.locale, bots: [botId],
        desdeMs: ep.desdeMs, minutos, severidad: 'alto', polls: ep.polls,
      });
    }
  }

  const salida = [...porRuta.values()];
  for (const r of salida) {
    r.minutos = Math.floor((ahoraMs - r.desdeMs) / 60_000);
    r.severidad = r.minutos >= MINUTOS_CRITICO ? 'critico' : 'alto';
    r.bots.sort((a, b) => a - b);
  }
  return salida.sort((a, b) => b.minutos - a.minutos);
}

function horas(min: number): string {
  return min >= 120 ? `${(min / 60).toFixed(1)} h` : `${min} min`;
}

/** Mensaje para Telegram. Solo se llama cuando hay hallazgos. */
export function textoRutaCerrada(rutas: RutaCerrada[]): string {
  const critico = rutas.some((r) => r.severidad === 'critico');
  const lineas = [
    critico ? '🔴 *Ruta de schedule cerrada*' : '🟠 *Ruta de schedule cerrada*',
    `${rutas.length} ruta${rutas.length === 1 ? '' : 's'} sin responder`,
    '',
  ];
  for (const r of rutas.slice(0, 6)) {
    lineas.push(
      `${r.severidad === 'critico' ? '🔴' : '🟠'} schedule ${r.scheduleId} · ${r.locale} · ${horas(r.minutos)}` +
      `\n   bot ${r.bots.join(', ')} · ${r.polls} polls bloqueados`,
    );
  }
  if (rutas.length > 6) lineas.push(`… y ${rutas.length - 6} mas.`);
  lineas.push('');
  lineas.push('El dominio responde y la ruta no: es un nginx 444 sobre esa URL.');
  lineas.push('Cambiar de IP o de proxy NO sirve. Se espera, o se mueve el schedule.');
  return lineas.join('\n');
}

// ── Segunda fuente: el sniper ────────────────────────────────────────────────

/**
 * Bot al que pertenece un `scan_key` de `sniper_scans`.
 *
 * La convencion es `<locale-corto>-<botId>`, por ejemplo `peru-299`. Se leen los digitos
 * finales. Un `scan_key` sin digitos finales devuelve `null` y se ignora, porque atribuir
 * un corte al bot equivocado es peor que no verlo.
 */
export function botIdDeScanKey(scanKey: string): number | null {
  const m = /-(\d+)$/.exec(scanKey.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Fase que el sniper escribe cuando `/groups` responde y la ruta del schedule no. */
export const FASE_RUTA_CERRADA = 'ruta_cerrada';

export interface FilaSniper {
  scanKey: string;
  fase: string;
  enMs: number;
  locale: string;
  scheduleId: string | null;
}

/**
 * Traduce filas del sniper a la MISMA forma que las de `poll_logs`, para que la regla de
 * arriba se aplique sin cambios. Una regla, dos fuentes.
 *
 * ── Por que hace falta la segunda fuente ────────────────────────────────────
 *
 * `audit-ruta-cerrada` lee `poll_logs`. El bot 299 dejo de escribir ahi cuando se le puso
 * `pollEnvironments: []` para sacarle carga a la ruta bloqueada. El 2026-09-02 la ruta se
 * cerro otra vez y el detector devolvio `ninguna`: era ciego justo para el bot que lo
 * motivo. El sniper si lo sabe, porque distingue "la ruta murio" de "la sesion murio".
 */
export function filasDesdeSniper(filas: FilaSniper[]): FilaBloqueo[] {
  const out: FilaBloqueo[] = [];
  for (const f of filas) {
    const botId = botIdDeScanKey(f.scanKey);
    if (botId === null) continue;
    const cerrada = f.fase === FASE_RUTA_CERRADA;
    out.push({
      botId,
      locale: f.locale,
      scheduleId: f.scheduleId,
      status: cerrada ? 'tcp_blocked' : 'ok',
      cls: cerrada ? 'schedule_blocked' : null,
      enMs: f.enMs,
    });
  }
  return out;
}

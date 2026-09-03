/**
 * Reporte diario de la fase, a Telegram.
 *
 * ── Que cambio el 2026-09-01 ────────────────────────────────────────────────
 *
 * Antes este reporte comparaba dos brazos asignados por `(hora + botId) % 2` y contaba la
 * muestra en polls. Eso daba un veredicto falso: `p = 0,005` calculado sobre 20.445 polls
 * que en realidad eran 159 bloques bot-hora.
 *
 * Ahora el brazo sale del segundo en que REALMENTE aterrizo cada poll, la muestra se
 * cuenta en eventos, y el intervalo sale de un bootstrap por bloque. Ver
 * `src/services/experimento-estadistica.ts`.
 *
 * El mensaje lleva SIEMPRE el hueco antes del poll junto a la razon. Si los huecos de los
 * dos grupos no se parecen, la razon mide el hueco y el mensaje lo dice antes del numero.
 */
import { schedules, logger } from '@trigger.dev/sdk/v3';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  curvaPorSegundo, mejorVentana, analizar, textoTelegramFase, huecosComparables,
  veredictoEstratificado,
  fraccionEnRejilla, periodoDesdeIntervalo, ESTRATOS_HUECO,
  type FilaSegundo, type BloqueExperimento, type ReporteFase, type EstratoResultado,
} from '../services/experimento-estadistica.js';
import { VENTANA_EXPERIMENTO } from '../services/experimento-fase.js';
import { DEFAULT_POLL_INTERVAL_S } from '../services/scheduling.js';
import { sendTelegram } from '../services/notifications.js';

/** Dias hacia atras que mira el reporte. El experimento es acumulativo. */
export const DIAS_REPORTE = 14;

/**
 * Momento en que la fase por REJILLA entro en produccion (version 20260902.1, RPi
 * reiniciado a las 20:47:50 -05 del 2026-09-01).
 *
 * Nada anterior entra en el analisis. Antes de este instante el mecanismo ESPERABA para
 * entrar a la ventana, y esa espera dejaba los huecos al doble dentro de la ventana
 * (182 s contra 84 s): mezclar los dos mecanismos en una misma cuenta es exactamente la
 * contaminacion que la rejilla viene a quitar.
 */
export const REJILLA_DESDE = '2026-09-02T01:47:50Z';
/** Ancho de la ventana que se busca, en segundos. El mismo que la configurada. */
export const ANCHO_VENTANA = 10;

export interface FilaFase {
  botId: number;
  /** Segundo del minuto en que arranco el fetch. */
  segundo: number;
  horaMs: number;
  polls: number;
  eventos: number;
  /** Segundos desde el poll anterior del mismo bot. `null` si es el primero. */
  huecoSec: number | null;
}

export async function leerFilasFase(dias = DIAS_REPORTE): Promise<FilaFase[]> {
  // El instante del fetch se reconstruye quitando el tiempo de respuesta y sumando lo que
  // se gasto ANTES de pedir (`load` y `fetch` de `phase_timings`). Es la misma expresion
  // que usaba `analyze-release-clock`.
  const r = await db.execute<Record<string, unknown>>(sql`
    WITH x AS (
      SELECT p.bot_id, p.created_at,
             p.created_at
               - make_interval(secs => COALESCE(p.response_time_ms,0)/1000.0)
               + make_interval(secs => (COALESCE((p.phase_timings->>'load')::int,0)
                                      + COALESCE((p.phase_timings->>'fetch')::int,0))/1000.0) AS t_fetch,
             COALESCE(p.polls_since_prev, 1) AS polls,
             (SELECT count(*) FROM jsonb_array_elements_text(COALESCE(p.date_changes->'appeared','[]'::jsonb)) d
               WHERE d.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                 AND d.value::date < (now() + interval '6 months')::date) AS eventos,
             extract(epoch FROM (p.created_at
               - lag(p.created_at) OVER (PARTITION BY p.bot_id ORDER BY p.created_at))) AS hueco
      FROM poll_logs p JOIN bots b ON b.id = p.bot_id
      WHERE b.phase_experiment = true
        AND p.created_at > now() - make_interval(days => ${dias})
        AND p.created_at >= ${REJILLA_DESDE}::timestamp
    )
    SELECT bot_id,
           floor(extract(second FROM t_fetch))::int AS segundo,
           extract(epoch FROM date_trunc('hour', created_at)) * 1000 AS hora_ms,
           polls, eventos, hueco
    FROM x
  `);
  return r.rows.map((f) => ({
    botId: Number(f.bot_id),
    segundo: Number(f.segundo),
    horaMs: Number(f.hora_ms),
    polls: Number(f.polls ?? 1),
    eventos: Number(f.eventos ?? 0),
    huecoSec: f.hueco === null || f.hueco === undefined ? null : Number(f.hueco),
  }));
}

/** ¿Cae `seg` dentro de la ventana? Sirve tambien para una ventana que cruza el minuto. */
export function dentroDeVentana(seg: number, w: { startSec: number; endSec: number }): boolean {
  return w.endSec > w.startSec
    ? seg >= w.startSec && seg < w.endSec
    : seg >= w.startSec || seg < w.endSec;
}

/** Bloques bot-hora, separados por si el poll aterrizo dentro de la ventana. */
export function bloquesPorVentana(filas: FilaFase[], w: { startSec: number; endSec: number }): BloqueExperimento[] {
  const mapa = new Map<string, BloqueExperimento>();
  for (const f of filas) {
    const alineado = dentroDeVentana(f.segundo, w);
    const k = `${f.botId}|${f.horaMs}|${alineado}`;
    const b = mapa.get(k) ?? { botId: f.botId, horaMs: f.horaMs, polls: 0, eventos: 0, alineado };
    b.polls += f.polls;
    b.eventos += f.eventos;
    mapa.set(k, b);
  }
  return [...mapa.values()];
}

/** Hueco p50 antes del poll, dentro y fuera de la ventana. Se descartan los absurdos. */
export function huecoP50(filas: FilaFase[], w: { startSec: number; endSec: number }): { dentro: number; fuera: number } {
  const d: number[] = [], f: number[] = [];
  for (const x of filas) {
    const h = x.huecoSec;
    if (h === null || !Number.isFinite(h) || h <= 0 || h > 600) continue;
    (dentroDeVentana(x.segundo, w) ? d : f).push(h);
  }
  const p50 = (xs: number[]) => {
    if (xs.length === 0) return NaN;
    const y = [...xs].sort((a, b) => a - b);
    return y[Math.floor(y.length / 2)]!;
  };
  return { dentro: p50(d), fuera: p50(f) };
}

export function armarReporte(filas: FilaFase[], dias = DIAS_REPORTE): ReporteFase | null {
  const cfg = VENTANA_EXPERIMENTO['es-co'];
  if (!cfg || filas.length === 0) return null;

  const porSeg: FilaSegundo[] = filas.map((f) => ({ segundo: f.segundo, polls: f.polls, eventos: f.eventos }));
  const curva = curvaPorSegundo(porSeg);
  const mv = mejorVentana(curva, ANCHO_VENTANA);
  const h = huecoP50(filas, cfg);
  // Los bots del experimento son es-co, entonces el periodo sale del intervalo por
  // defecto. Si alguno llevara un intervalo propio, el numero de abajo lo subestimaria.
  const periodoSec = periodoDesdeIntervalo(DEFAULT_POLL_INTERVAL_S);
  const huecos = filas.map((f) => f.huecoSec).filter((x): x is number => x !== null);

  // Un estrato por mecanismo. Ver `ESTRATOS_HUECO`.
  const estratos: EstratoResultado[] = ESTRATOS_HUECO.map((e) => {
    const dentro = filas.filter((f) => f.huecoSec !== null && f.huecoSec >= e.minSec && f.huecoSec <= e.maxSec);
    const hh = huecoP50(dentro, cfg);
    return {
      nombre: e.nombre, minSec: e.minSec, maxSec: e.maxSec, filas: dentro.length,
      analisis: analizar(bloquesPorVentana(dentro, cfg)),
      huecoDentroSec: hh.dentro, huecoFueraSec: hh.fuera,
      comparable: huecosComparables(hh.dentro, hh.fuera),
    };
  });

  return {
    dias, curva, estratos,
    enRejilla: fraccionEnRejilla(huecos, periodoSec),
    periodoSec,
    configurada: { ventana: cfg, analisis: analizar(bloquesPorVentana(filas, cfg)) },
    mejor: mv
      ? { ventana: { startSec: mv.startSec, endSec: mv.endSec }, analisis: analizar(bloquesPorVentana(filas, { startSec: mv.startSec, endSec: mv.endSec })) }
      : null,
    huecoDentroSec: h.dentro,
    huecoFueraSec: h.fuera,
  };
}

export const reporteExperimentoFaseSchedule = schedules.task({
  id: 'reporte-experimento-fase',
  cron: {
    // 13:05 UTC = 08:05 Bogota, justo despues del detector de citas vencidas.
    pattern: '5 13 * * *',
    environments: ['PRODUCTION'],
  },
  machine: { preset: 'micro' },
  maxDuration: 120,

  run: async () => {
    const filas = await leerFilasFase();
    const rep = armarReporte(filas);
    if (!rep) {
      logger.info('experimento-fase: sin filas o sin ventana configurada');
      return { filas: filas.length, enviado: false };
    }
    const a = rep.configurada.analisis;
    const est = veredictoEstratificado(rep.estratos);
    logger.info('experimento-fase', {
      veredicto: est.veredicto,
      estratosLimpios: est.usables.length,
      estratos: rep.estratos.map((e) => ({
        nombre: e.nombre, razon: e.analisis.razon, ic95: e.analisis.ic95,
        phi: e.analisis.sobredispersion, comparable: e.comparable, filas: e.filas,
      })),
      agrupado: { razon: a.razon, phi: a.sobredispersion },
      huecoDentro: rep.huecoDentroSec, huecoFuera: rep.huecoFueraSec,
      enRejilla: rep.enRejilla,
    });
    const enviado = await sendTelegram(textoTelegramFase(rep));
    return {
      filas: filas.length, veredicto: est.veredicto,
      estratosLimpios: est.usables.length, agrupado: a.razon, enviado,
    };
  },
});

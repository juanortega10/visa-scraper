import { schedules, logger } from '@trigger.dev/sdk/v3';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/**
 * Resumen por bot y por hora — cron cada hora, minuto 7.
 *
 * Por que existe. El panel escaneaba `poll_logs` entera para responder cualquier
 * pregunta de cobertura. En agosto de 2026 esos escaneos costaron 77,73 USD de
 * compute en Neon. Esta tarea lee UNA vez la hora recien cerrada, por el indice
 * `poll_logs_bot_created_idx`, y deja una fila por bot. Despues el panel lee
 * enteros, no escanea telemetria.
 *
 * Lo que NO hace: no agrega ninguna escritura al camino caliente del polleo. Ese
 * fue el error que llevo `auth_logs` a 434 MB, una fila por evento en la ruta
 * critica. Aca se paga una consulta por hora, no una por poll.
 *
 * Idempotente por construccion: hace upsert contra `bot_hourly_bot_hour_idx`, asi
 * que reprocesar una hora corrige la fila en vez de duplicarla o sumar dos veces.
 * Por eso tambien puede recalcular horas viejas sin riesgo.
 */

/** Minuto 7 para no chocar con los cron que todos ponen en punto. */
export const rollupHourlySchedule = schedules.task({
  id: 'rollup-hourly',
  cron: {
    pattern: '7 * * * *',
    environments: ['PRODUCTION'],
  },
  machine: { preset: 'micro' },
  maxDuration: 300,

  run: async (payload: { timestamp: Date }) => {
    // La hora recien cerrada. Se usa el reloj de la corrida, no now(), para que
    // un reintento tardio siga apuntando a la misma hora.
    const ref = payload?.timestamp ? new Date(payload.timestamp) : new Date();
    const desde = new Date(Math.floor(ref.getTime() / 3_600_000) * 3_600_000 - 3_600_000);
    return await rollupHour(desde);
  },
});

/**
 * Calcula y guarda el resumen de UNA hora. Exportada aparte del cron para poder
 * rellenar horas viejas y para poder probarla contra una base real.
 *
 * @param desde inicio de la hora, en UTC.
 */
export async function rollupHour(desde: Date): Promise<{ hour: string; bots: number }> {
  const hasta = new Date(desde.getTime() + 3_600_000);

  const res = await db.execute(sql`
    WITH
    -- Filas de poll de la hora. Es el unico escaneo, y va por indice.
    p AS (
      SELECT bot_id, created_at, status, blind_ms, polls_since_prev, relogin_happened
      FROM poll_logs
      WHERE created_at >= ${desde} AND created_at < ${hasta}
    ),
    cobertura AS (
      SELECT bot_id,
             count(*)::int                                                    AS poll_rows,
             coalesce(sum(coalesce(polls_since_prev, 1)), 0)::int             AS polls,
             coalesce(sum(coalesce(blind_ms, 0)), 0)::bigint                  AS blind_ms,
             count(*) FILTER (WHERE status = 'tcp_blocked')::int              AS blocked,
             count(*) FILTER (WHERE status = 'error')::int                    AS errors,
             count(*) FILTER (WHERE relogin_happened)::int                    AS relogins
      FROM p GROUP BY bot_id
    ),
    -- Ventanas ciegas de cada bot: cada fila con blind_ms cubre el hueco que va
    -- desde created_at - blind_ms hasta created_at. Con eso se puede preguntar
    -- si un instante cualquiera cayo dentro de un hueco de ESE bot.
    ciego AS (
      SELECT bot_id,
             created_at - (blind_ms || ' milliseconds')::interval AS ini,
             created_at                                           AS fin
      FROM p WHERE blind_ms IS NOT NULL AND blind_ms > 60000
    ),
    -- Cupos que el bot vio y que servian para su propia meta.
    vistos AS (
      SELECT s.bot_id, count(*)::int AS sightings
      FROM date_sightings s JOIN bots b ON b.id = s.bot_id
      WHERE s.appeared_at >= ${desde} AND s.appeared_at < ${hasta}
        AND (b.target_date_before IS NULL OR s.date < b.target_date_before)
        AND (b.current_consular_date IS NULL OR s.date < b.current_consular_date)
      GROUP BY s.bot_id
    ),
    -- Lo que perdimos por no estar mirando: un cupo que vio un bot HERMANO del
    -- mismo consulado, mientras este bot estaba dentro de una ventana ciega, y
    -- que ademas le servia a este bot. No cuesta un solo poll extra: sale de
    -- cruzar lo que ya guardamos.
    perdidos AS (
      SELECT c.bot_id, count(DISTINCT (s.bot_id, s.date, s.appeared_at))::int AS missed
      FROM ciego c
      JOIN bots yo       ON yo.id = c.bot_id
      JOIN bots hermano  ON hermano.consular_facility_id = yo.consular_facility_id
                        AND hermano.locale = yo.locale
                        AND hermano.id <> yo.id
      JOIN date_sightings s ON s.bot_id = hermano.id
                        AND s.appeared_at >= c.ini AND s.appeared_at < c.fin
      WHERE s.appeared_at >= ${desde} AND s.appeared_at < ${hasta}
        AND (yo.target_date_before IS NULL OR s.date < yo.target_date_before)
        AND (yo.current_consular_date IS NULL OR s.date < yo.current_consular_date)
      GROUP BY c.bot_id
    ),
    -- Conversion. ms_to_post es lo unico que compite en la carrera y
    -- times_seen = 0 marca la fecha fantasma.
    conv AS (
      SELECT bot_id,
             count(*)::int                                              AS attempts,
             count(*) FILTER (WHERE success)::int                       AS wins,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ms_to_post)    AS p50_ms_to_post,
             count(*) FILTER (WHERE NOT success AND times_seen = 0)::int AS phantom_dates
      FROM reschedule_logs
      WHERE created_at >= ${desde} AND created_at < ${hasta}
      GROUP BY bot_id
    ),
    todos AS (
      SELECT bot_id FROM cobertura
      UNION SELECT bot_id FROM vistos
      UNION SELECT bot_id FROM conv
    )
    INSERT INTO bot_hourly (
      bot_id, hour, poll_rows, polls, blind_ms, blocked, errors, relogins,
      sightings, missed_while_blind, attempts, wins, p50_ms_to_post, phantom_dates
    )
    SELECT t.bot_id, ${desde},
           coalesce(c.poll_rows, 0), coalesce(c.polls, 0),
           -- Un entero de 32 bits aguanta 24 dias en milisegundos, y aca el techo
           -- es una hora, pero se recorta igual por si una fila trae basura.
           least(coalesce(c.blind_ms, 0), 3600000)::int,
           coalesce(c.blocked, 0), coalesce(c.errors, 0), coalesce(c.relogins, 0),
           coalesce(v.sightings, 0), coalesce(m.missed, 0),
           coalesce(k.attempts, 0), coalesce(k.wins, 0),
           round(k.p50_ms_to_post)::int, coalesce(k.phantom_dates, 0)
    FROM todos t
    LEFT JOIN cobertura c ON c.bot_id = t.bot_id
    LEFT JOIN vistos    v ON v.bot_id = t.bot_id
    LEFT JOIN perdidos  m ON m.bot_id = t.bot_id
    LEFT JOIN conv      k ON k.bot_id = t.bot_id
    ON CONFLICT (bot_id, hour) DO UPDATE SET
      poll_rows          = EXCLUDED.poll_rows,
      polls              = EXCLUDED.polls,
      blind_ms           = EXCLUDED.blind_ms,
      blocked            = EXCLUDED.blocked,
      errors             = EXCLUDED.errors,
      relogins           = EXCLUDED.relogins,
      sightings          = EXCLUDED.sightings,
      missed_while_blind = EXCLUDED.missed_while_blind,
      attempts           = EXCLUDED.attempts,
      wins               = EXCLUDED.wins,
      p50_ms_to_post     = EXCLUDED.p50_ms_to_post,
      phantom_dates      = EXCLUDED.phantom_dates
  `);

  const bots = res.rowCount ?? 0;
  logger.info('rollup-hourly', { hour: desde.toISOString(), bots });
  return { hour: desde.toISOString(), bots };
}

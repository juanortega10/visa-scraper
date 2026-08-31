/**
 * Reporte diario del A/B de alineacion de fase, a Telegram.
 *
 * El experimento y su porque viven en `src/services/experimento-fase.ts`. Aqui solo
 * se lee la base y se manda el mensaje.
 *
 * La asignacion NO se guarda: se recalcula para cada fila con su propia hora, con la
 * misma funcion que decidio el brazo en el momento del poll. Asi el registro y la
 * realidad no se pueden separar.
 */
import { schedules, logger } from '@trigger.dev/sdk/v3';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { resumirExperimento, textoTelegramExperimento, type FilaPoll } from '../services/experimento-fase.js';
import { sendTelegram } from '../services/notifications.js';

/** Dias hacia atras que mira el reporte. El experimento es acumulativo. */
export const DIAS_REPORTE = 14;

export async function leerFilasExperimento(dias = DIAS_REPORTE): Promise<FilaPoll[]> {
  const r = await db.execute<{ bot_id: number; t: string; polls: string; cercanos: string }>(sql`
    SELECT p.bot_id,
           p.created_at
             - make_interval(secs => COALESCE(p.response_time_ms,0)/1000.0)
             + make_interval(secs => (COALESCE((p.phase_timings->>'load')::int,0)
                                    + COALESCE((p.phase_timings->>'fetch')::int,0))/1000.0) AS t,
           COALESCE(p.polls_since_prev, 1) AS polls,
           (SELECT count(*) FROM jsonb_array_elements_text(COALESCE(p.date_changes->'appeared','[]'::jsonb)) d
             WHERE d.value ~ '^\\d{4}-\\d{2}-\\d{2}$'
               AND d.value::date < (now() + interval '6 months')::date) AS cercanos
    FROM poll_logs p JOIN bots b ON b.id = p.bot_id
    WHERE b.phase_experiment = true
      AND p.created_at > now() - (${dias} || ' days')::interval
  `);
  return r.rows.map((f) => ({
    botId: Number(f.bot_id),
    enMs: Date.parse(String(f.t).replace(' ', 'T') + (String(f.t).endsWith('Z') ? '' : 'Z')),
    polls: Number(f.polls ?? 1),
    cercanos: Number(f.cercanos ?? 0),
  }));
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
    const filas = await leerFilasExperimento();
    if (filas.length === 0) {
      logger.info('experimento-fase: ningun bot con phase_experiment');
      return { bots: 0, enviado: false };
    }
    const r = resumirExperimento(filas);
    logger.info('experimento-fase', {
      alineadoPolls: r.alineado.polls, alineadoPorMil: r.alineado.porMil,
      controlPolls: r.control.polls, controlPorMil: r.control.porMil,
      mejora: r.mejora, hayMuestra: r.hayMuestra,
    });
    const enviado = await sendTelegram(textoTelegramExperimento(r, DIAS_REPORTE));
    return {
      filas: filas.length, alineado: r.alineado, control: r.control,
      mejora: r.mejora, hayMuestra: r.hayMuestra, enviado,
    };
  },
});

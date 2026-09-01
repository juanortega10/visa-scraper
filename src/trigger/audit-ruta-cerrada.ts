/**
 * Vigilante de rutas de schedule cerradas — corre cada hora y avisa por Telegram.
 *
 * Ver `src/services/ruta-cerrada.ts` para la regla y el porque. Aqui solo se lee la
 * base y se avisa; la decision vive en la funcion pura, que es la que tiene tests.
 *
 * ── Por que cada hora y no una vez al dia ───────────────────────────────────
 *
 * El corte del 2026-08-30 duro 17,4 h. Un cron diario lo habria visto una sola vez y
 * quizas ya cerrado. El umbral de la regla son 60 min, entonces revisar cada hora es
 * la cadencia que corresponde. El aviso se repite mientras el corte siga abierto: un
 * corte que sigue vivo a la tercera hora es informacion nueva, no ruido.
 *
 * Corre SOLO en PRODUCTION. La regla mira toda la flota sin importar el entorno de
 * cada bot, entonces correrlo en los dos mandaria el mismo aviso dos veces.
 */
import { schedules, logger } from '@trigger.dev/sdk/v3';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { detectarRutasCerradas, textoRutaCerrada, type FilaBloqueo } from '../services/ruta-cerrada.js';
import { sendTelegram } from '../services/notifications.js';

/**
 * Ventana de lectura. Tiene que superar el techo del backoff de `schedule_blocked`
 * (720 min) mas un margen, o un corte largo se veria empezando dentro de la ventana
 * y el detector reportaria menos horas de las reales.
 */
export const HORAS_VENTANA = 24;

export async function leerFilasBloqueo(): Promise<FilaBloqueo[]> {
  const filas = await db.execute<Record<string, unknown>>(sql`
    SELECT p.bot_id, b.locale, b.schedule_id, p.status,
           p.connection_info->>'blockClassification' AS cls,
           extract(epoch from p.created_at) * 1000 AS en_ms
    FROM poll_logs p
    JOIN bots b ON b.id = p.bot_id
    WHERE b.status IN ('active','error')
      AND p.created_at > now() - make_interval(hours => ${HORAS_VENTANA})
  `);
  return filas.rows.map((f) => ({
    botId: Number(f.bot_id),
    locale: String(f.locale ?? ''),
    scheduleId: f.schedule_id === null || f.schedule_id === undefined ? null : String(f.schedule_id),
    status: String(f.status ?? ''),
    cls: f.cls === null || f.cls === undefined ? null : String(f.cls),
    enMs: Number(f.en_ms),
  }));
}

export const auditRutaCerrada = schedules.task({
  id: 'audit-ruta-cerrada',
  cron: {
    // Al minuto 25 de cada hora, lejos de los crons de las horas en punto.
    pattern: '25 * * * *',
    environments: ['PRODUCTION'],
  },
  machine: { preset: 'micro' },
  maxDuration: 120,

  run: async () => {
    const rutas = detectarRutasCerradas(await leerFilasBloqueo(), Date.now());
    if (rutas.length === 0) {
      logger.info('audit-ruta-cerrada: ninguna');
      return { rutas: 0, telegram: false };
    }
    logger.warn('audit-ruta-cerrada: hallazgos', {
      rutas: rutas.map((r) => ({ schedule: r.scheduleId, minutos: r.minutos, bots: r.bots })),
    });
    const telegram = await sendTelegram(textoRutaCerrada(rutas));
    return {
      rutas: rutas.length,
      criticas: rutas.filter((r) => r.severidad === 'critico').length,
      minutosMax: rutas[0]!.minutos,
      telegram,
    };
  },
});

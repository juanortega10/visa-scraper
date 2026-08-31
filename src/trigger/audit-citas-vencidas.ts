/**
 * Vigilante de citas vencidas — corre una vez al dia y avisa por correo Y por Telegram.
 *
 * Un bot solo puede reagendar a una fecha estrictamente ANTERIOR a la que tiene. Con la
 * cita ya vencida no existe ninguna fecha valida, entonces el bot pollea para siempre
 * sin poder ganar. No falla, no alerta, no sale en ningun tablero: `bots.status` sigue
 * `active` y `updated_at` sigue fresco.
 *
 * `audit-blind-bots` NO los ve: ese busca bots que pollean SIN ver fechas, y estos si
 * ven fechas, solo que ninguna les sirve. Se corrio el 2026-08-31 con 16 bots vencidos
 * en la flota y devolvio `ninguno`.
 *
 * Esto ya paso una vez: 14 bots asi el 2026-07-06, arreglados a mano, sin detector. El
 * 2026-08-31 eran 16 gastando 22.850 polls reales cada 24 h, el 45,5% de la carga de
 * toda la flota, contra un portal que ese mes cerro la ruta del schedule 75610929 dos
 * veces. Este cron existe para que no vuelva a pasar en silencio.
 *
 * DOS canales a proposito. El correo lleva la tabla completa; Telegram suena en el
 * telefono y lleva solo lo que decide si vale la pena abrir el correo. Una alerta que
 * depende de un canal se puede perder entera, y este problema estuvo dos meses sin que
 * nadie lo viera.
 *
 * Corre SOLO en PRODUCTION. La regla mira toda la flota, sin importar el entorno de
 * cada bot, entonces correrlo en los dos mandaria el mismo correo dos veces.
 */
import { schedules, logger } from '@trigger.dev/sdk/v3';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  evaluarCitaVencida, ordenarHallazgos, resumir, textoTelegram,
  type EntradaCitaVencida, type ResultadoCitaVencida,
} from '../services/citas-vencidas.js';
import { sendCitasVencidasEmail, sendTelegram } from '../services/notifications.js';

interface FilaBot extends Record<string, unknown> {
  id: number;
  locale: string;
  status: string;
  cita: string | null;
  agencia: string | null;
  polls24h: string;
}

/**
 * Lee la flota en UNA consulta. `polls24h` es `SUM(polls_since_prev)`, o sea polls
 * REALES: la escritura reducida solo guarda ~6% de las filas, entonces `count(*)`
 * subestima el gasto entre 2 y 6 veces segun el bot.
 */
export async function leerFlota(): Promise<{ entradas: EntradaCitaVencida[]; pollsFlota: number }> {
  const filas = await db.execute<FilaBot>(sql`
    select b.id, b.locale, b.status, b.current_consular_date::text as cita,
           ag.name as agencia,
           coalesce((select sum(p.polls_since_prev) from poll_logs p
                     where p.bot_id = b.id and p.created_at > now() - interval '24 hours'), 0) as polls24h
    from bots b left join agencies ag on ag.id = b.agency_id
    where b.status in ('active','error') and b.current_consular_date is not null
  `);
  const total = await db.execute<{ t: string }>(sql`
    select coalesce(sum(polls_since_prev), 0) as t from poll_logs
    where created_at > now() - interval '24 hours'
  `);
  return {
    entradas: filas.rows.map((f) => ({
      botId: Number(f.id),
      locale: String(f.locale ?? ''),
      status: String(f.status ?? ''),
      cita: f.cita,
      polls24h: Number(f.polls24h ?? 0),
      agencia: f.agencia,
    })),
    pollsFlota: Number(total.rows[0]?.t ?? 0),
  };
}

export const auditCitasVencidasSchedule = schedules.task({
  id: 'audit-citas-vencidas',
  cron: {
    // 13:00 UTC = 08:00 Bogota. Temprano, para que se pueda actuar el mismo dia.
    pattern: '0 13 * * *',
    environments: ['PRODUCTION'],
  },
  machine: { preset: 'micro' },
  maxDuration: 120,

  run: async () => {
    const { entradas, pollsFlota } = await leerFlota();
    const hoy = new Date().toISOString().slice(0, 10);

    const hallazgos: ResultadoCitaVencida[] = [];
    for (const e of entradas) {
      const v = evaluarCitaVencida(e, hoy);
      if (v) hallazgos.push(v);
    }
    const orden = ordenarHallazgos(hallazgos);
    const resumen = resumir(orden, pollsFlota);

    if (orden.length === 0) {
      logger.info('audit-citas-vencidas: ninguno', { revisados: entradas.length });
      return { revisados: entradas.length, vencidos: 0, correo: false, telegram: false };
    }

    logger.warn('audit-citas-vencidas: hallazgos', {
      total: resumen.total, criticos: resumen.criticos,
      pollsDesperdiciados: resumen.pollsDesperdiciados,
      porcentajeDeFlota: resumen.porcentajeDeFlota,
      bots: orden.map((f) => f.botId),
    });

    // Los dos canales van en PARALELO y ninguno puede tumbar al otro. `sendTelegram`
    // nunca lanza; el correo se envuelve para que un fallo de Resend no impida el
    // aviso por Telegram. Y ninguno de los dos puede tumbar el cron.
    const admin = process.env.ADMIN_NOTIFICATION_EMAIL ?? '';
    const [correo, tg] = await Promise.allSettled([
      sendCitasVencidasEmail(admin, orden.map((f) => ({
        botId: f.botId, locale: f.locale, cita: f.cita as string, diasVencida: f.diasVencida,
        polls24h: f.polls24h, severidad: f.severidad, motivo: f.motivo, agencia: f.agencia,
      })), resumen),
      sendTelegram(textoTelegram(orden, resumen)),
    ]);
    if (correo.status === 'rejected') {
      logger.error('audit-citas-vencidas: fallo el correo', { error: String(correo.reason) });
    }

    return {
      revisados: entradas.length,
      vencidos: resumen.total,
      criticos: resumen.criticos,
      pollsDesperdiciados: resumen.pollsDesperdiciados,
      porcentajeDeFlota: resumen.porcentajeDeFlota,
      correo: correo.status === 'fulfilled',
      telegram: tg.status === 'fulfilled' && tg.value === true,
    };
  },
});

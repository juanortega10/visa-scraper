/**
 * Vigilante de cadenas dormidas — corre cada 15 min y avisa por correo.
 *
 * Un bot `active` que deja de pollear no dispara ninguna alarma del sistema: el
 * dashboard mira `bots.status` y `updated_at`, y los dos siguen frescos. El bot 281
 * estuvo 63 h asi (2026-08-27 al 2026-08-30) y volvio solo cuando un deploy reinicio
 * el worker. Los bots 7, 223, 240, 283, 285 y 299 cayeron igual esos mismos dias.
 *
 * Este cron cierra ese hueco. La regla vive en `chain-health.ts` y sale de la misma
 * funcion que usa el despertador de `poll-visa.ts` (`debeDespertar`), mas 15 min de
 * margen. Mientras el despertador funcione, este cron no manda ningun correo.
 *
 * Corre en los dos entornos y cada uno revisa su propia flota. Asi la alerta sigue
 * saliendo aunque el RPi quede aislado, que es justo cuando mas hace falta.
 */
import { schedules, logger, runs } from '@trigger.dev/sdk/v3';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bots } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { evaluarCadena, cadenasConProblema, cadenasEnBackoffLargo, type EntradaCadena } from '../services/chain-health.js';
import { sendCadenasDormidasEmail } from '../services/notifications.js';
import type { RecentBlockRow } from '../services/scheduling.js';

interface FilaBot extends Record<string, unknown> {
  id: number;
  locale: string;
  status: string;
  poll_environments: string[] | null;
  activated_at: string | null;
  ultimo_poll: string | null;
  ultimas: Array<{ status: string; blockCls: string | null; createdAt: string | null }> | null;
}

/** Una sola consulta para toda la flota: el `lateral` evita 240 consultas sueltas. */
export async function leerCadenas(): Promise<EntradaCadena[]> {
  const filas = await db.execute<FilaBot>(sql`
    select b.id, b.locale, b.status, b.poll_environments, b.activated_at,
           u.ultimo_poll, u.ultimas
    from bots b
    left join lateral (
      select max(p.created_at) as ultimo_poll,
             jsonb_agg(jsonb_build_object(
               'status', p.status,
               'blockCls', p.connection_info->>'blockClassification',
               'createdAt', p.created_at
             ) order by p.id desc) as ultimas
      from (
        select id, status, connection_info, created_at
        from poll_logs where bot_id = b.id order by id desc limit 5
      ) p
    ) u on true
    where b.status in ('active', 'error')
  `);
  return filas.rows.map((f) => ({
    botId: f.id,
    locale: f.locale,
    status: f.status,
    entornos: f.poll_environments ?? ['dev'],
    // Los timestamps de la DB no llevan zona y son UTC. Ver el gotcha en CLAUDE.md.
    ultimoPoll: f.ultimo_poll ? new Date(`${f.ultimo_poll}Z`) : null,
    // El timestamp llega como texto sin zona y es UTC. Ver el gotcha en CLAUDE.md.
    ultimas: (f.ultimas ?? []).map((u) => ({
      status: u.status, blockCls: u.blockCls,
      createdAt: u.createdAt ? new Date(`${u.createdAt}Z`) : null,
    })) as RecentBlockRow[],
    activatedAt: f.activated_at ? new Date(`${f.activated_at}Z`) : null,
  }));
}

export const auditChainsSchedule = schedules.task({
  id: 'audit-chains',
  cron: {
    pattern: '*/15 * * * *',
    environments: ['DEVELOPMENT', 'PRODUCTION'],
  },
  machine: { preset: 'micro' },
  maxDuration: 120,

  run: async (_payload, { ctx }) => {
    const entorno = ctx.environment.type === 'PRODUCTION' ? 'prod' : 'dev';
    const todas = await leerCadenas();
    const mias = todas.filter((c) => c.entornos.includes(entorno));
    const evaluadas = mias.map((c) => evaluarCadena(c, Date.now()));
    const malas = cadenasConProblema(evaluadas);
    const enBackoff = cadenasEnBackoffLargo(evaluadas);

    // El backoff largo no pide despertar nada, y aun asi son bots sin servicio.
    // Se deja en el log para que quede el rastro sin mandar correo por eso.
    if (enBackoff.length > 0) {
      logger.warn('audit-chains: cadenas calladas por backoff largo', {
        entorno,
        bots: enBackoff.map((m) => ({ botId: m.botId, minSinPoll: m.minSinPoll, bloqueo: m.blockCls })),
      });
    }

    if (malas.length === 0) {
      logger.info('audit-chains: sin cadenas dormidas', { entorno, revisadas: mias.length, backoffLargo: enBackoff.length });
      // `levantadas` va siempre, incluso en cero. Sin el campo no se puede distinguir
      // "corre la version con auto-levantado y no hubo nada que hacer" de "corre una
      // version vieja que no sabe levantar". Ese hueco aparecio al revisar el cron el
      // 2026-08-31: los runs salian sin el campo y no habia forma de saber cual era.
      return { entorno, revisadas: mias.length, dormidas: 0, levantadas: 0, backoffLargo: enBackoff.length };
    }

    logger.error('audit-chains: CADENAS DORMIDAS', {
      entorno,
      revisadas: mias.length,
      dormidas: malas.length,
      bots: malas.map((m) => ({ botId: m.botId, minSinPoll: m.minSinPoll, toleranciaMin: m.toleranciaMin })),
    });

    // Levantar lo que se detecto. El correo avisa; esto arregla.
    //
    // Se cancela el run colgado y se limpia `activeRunId` para que el proximo ciclo del
    // cron dispare uno nuevo. Es lo mismo que hace `scripts/wake-bot.ts` a mano, y hasta
    // el 2026-08-31 habia que correrlo bot por bot cada vez que llegaba el correo.
    const levantados: number[] = [];
    for (const m of malas) {
      try {
        const [fila] = await db.select({
          activeRunId: bots.activeRunId, activeCloudRunId: bots.activeCloudRunId,
        }).from(bots).where(eq(bots.id, m.botId));
        const runId = entorno === 'prod' ? fila?.activeCloudRunId : fila?.activeRunId;
        if (runId) await runs.cancel(runId).catch(() => {});
        await db.update(bots)
          .set(entorno === 'prod'
            ? { activeCloudRunId: null, updatedAt: new Date() }
            : { activeRunId: null, updatedAt: new Date() })
          .where(eq(bots.id, m.botId));
        levantados.push(m.botId);
        logger.warn('audit-chains: cadena levantada', {
          botId: m.botId, entorno, runIdCancelado: runId ?? null, minSinPoll: m.minSinPoll,
        });
      } catch (e) {
        logger.error('audit-chains: fallo al levantar', { botId: m.botId, error: String(e) });
      }
    }

    const admin = process.env.ADMIN_NOTIFICATION_EMAIL;
    if (admin) {
      await sendCadenasDormidasEmail(admin, malas.map((m) => ({
        botId: m.botId,
        locale: m.locale,
        entornos: m.entornos,
        minSinPoll: m.minSinPoll,
        toleranciaMin: m.toleranciaMin,
        bloqueo: m.bansSeguidos > 0 ? `${m.blockCls} x${m.bansSeguidos}` : '-',
        levantada: levantados.includes(m.botId),
      }))).catch((e) => logger.error('audit-chains: fallo el correo', { error: String(e) }));
    }

    return { entorno, revisadas: mias.length, dormidas: malas.length, levantadas: levantados.length, backoffLargo: enBackoff.length };
  },
});

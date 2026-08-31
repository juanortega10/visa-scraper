import { schedules, logger, runs } from '@trigger.dev/sdk/v3';
import { db } from '../db/client.js';
import { bots, pollLogs } from '../db/schema.js';
import { HEARTBEAT_MS } from '../services/poll-logging.js';
import { eq, inArray, and, desc, sql } from 'drizzle-orm';
import { notifyUserTask } from './notify-user.js';
import { visaPollingPerBotQueue } from './queues.js';
import { calculatePriority, blockBackoffMs, SUSTAINED_BLOCK_CLASSES, countSustainedAccountBans, debeDespertar } from '../services/scheduling.js';
import { TECHO_EXECUTING_MIN } from '../services/guardianes.js';

type RunAction = 'executing' | 'pulled_forward' | 'resurrected' | 'cron_ok';

/**
 * Silencio que hace sospechar de un bot cron, en minutos.
 *
 * Tiene que quedar POR ENCIMA de `HEARTBEAT_MS`, que es el intervalo minimo entre filas
 * de un bot sano. Con el heartbeat en 5 min, los huecos observados llegan a 9 min, y el
 * triple del heartbeat deja margen para el jitter del cron sin tapar un bot muerto de
 * verdad: la cadena dormida se detecta igual, solo que 10 min mas tarde.
 */
export const SILENCIO_CRON_MIN = (HEARTBEAT_MS / 60_000) * 3;

async function getRunStatus(runId: string | null): Promise<string | null> {
  if (!runId) return null;
  try {
    const run = await runs.retrieve(runId);
    return run.status;
  } catch {
    return null;
  }
}

/**
 * Detect an intentional TCP account-ban backoff.
 *
 * When a bot's account is banned, poll-visa schedules a long DELAYED self-trigger
 * (30m → 60m → 120m → 240m → 480m as the ban is confirmed sustained — see scheduling.ts).
 * ensure-chain must NOT cancel+pull-forward that DELAYED run, nor resurrect a
 * dead run early: doing either re-polls the banned account every ~10 min and
 * defeats the backoff (the bot 231 incident — 100% account_ban for ~116h at a
 * ~10 min cadence instead of the intended long backoff).
 *
 * Returns `banned` + how long the intended backoff is, computed the SAME way as
 * poll-visa (last 5 poll_logs, consecutive block count → tier) using the shared
 * `blockBackoffMs` helper so the two can never drift. Cubre las dos clases sostenidas:
 * `account_ban` (30m→480m) y `schedule_blocked` (240m→720m).
 */
async function getBanBackoff(
  botId: number,
): Promise<{ banned: boolean; count: number; blockCls: string | null; lastPollAgeMs: number; backoffMs: number }> {
  const recent = await db
    .select({
      status: pollLogs.status,
      createdAt: pollLogs.createdAt,
      blockCls: sql<string | null>`${pollLogs.connectionInfo}->>'blockClassification'`,
    })
    .from(pollLogs)
    .where(eq(pollLogs.botId, botId))
    .orderBy(desc(pollLogs.id))
    .limit(5);

  const last = recent[0];
  if (!last || last.status !== 'tcp_blocked' || !SUSTAINED_BLOCK_CLASSES.includes(last.blockCls ?? '')) {
    return { banned: false, count: 0, blockCls: null, lastPollAgeMs: 0, backoffMs: 0 };
  }

  // Fuente unica del recuento: `countSustainedAccountBans`. Antes esto era una copia con
  // `findIndex`, y por eso se quedaba sin el corte por tiempo que esa funcion aplica.
  // Tres lectores tienen que ver el mismo numero: poll-visa, chain-health y este.
  const count = countSustainedAccountBans(recent);

  return {
    banned: true,
    count,
    blockCls: last.blockCls,
    lastPollAgeMs: Date.now() - last.createdAt.getTime(),
    backoffMs: blockBackoffMs(last.blockCls, count),
  };
}

/**
 * If EXECUTING → leave it alone.
 * If DELAYED/QUEUED → cancel and re-trigger now (pull forward into pre-warm/super-critical schedule).
 * If dead/null → trigger new chain.
 */
async function ensureChainForBot(
  botId: number,
  runId: string | null,
  concurrencyKey: string,
  activatedAt: Date | null,
  tags: string[],
  /** Sin uso desde el 2026-08-31: la comprobacion de vida ya no depende de esto. */
  _usesCron: boolean,
  chainId?: 'dev' | 'cloud',
): Promise<{ action: RunAction; newRunId?: string }> {
  const status = await getRunStatus(runId);

  if (status === 'EXECUTING') {
    // Un run de `poll-visa` vive segundos o pocos minutos, y mientras trabaja escribe en
    // `poll_logs`. Un EXECUTING que lleva media hora sin dejar una fila esta trabado.
    // Nadie lo tocaba: `poll-cron` respeta el run vivo y esta rama salia sin mirar el
    // reloj. Lo encontro el barrido exhaustivo de `guardianes-invariante.test.ts`.
    const [ultima] = await db.select({ createdAt: pollLogs.createdAt })
      .from(pollLogs).where(eq(pollLogs.botId, botId))
      .orderBy(desc(pollLogs.createdAt)).limit(1);
    const minSinPoll = ultima ? (Date.now() - ultima.createdAt.getTime()) / 60_000 : Number.MAX_SAFE_INTEGER;
    if (minSinPoll < TECHO_EXECUTING_MIN) return { action: 'executing' };
    logger.warn('ensure-chain: run EXECUTING colgado, se cancela', {
      botId, runId, minSinPoll: Math.round(minSinPoll),
    });
    try { await runs.cancel(runId!); } catch {}
    // Cae al re-disparo de mas abajo.
  }

  // Respect an intentional account-ban backoff (poll-visa scheduled a long DELAYED run).
  // Without this guard the guardian re-polls the banned account every ~10 min and defeats
  // the 30m→60m→120m→240m→480m escalation. Mirrors poll-visa's DEDUP FALLBACK (poll-visa.ts:229-238).
  const ban = await getBanBackoff(botId);
  if (ban.banned) {
    // Live backoff run → leave it; it fires when the delay elapses (like EXECUTING).
    //
    // SALVO que el retraso ya se haya pasado de largo. Sin esa salida habia un abrazo
    // mortal: `poll-cron` ve el run DELAYED y hace `continue` sin disparar nada
    // (poll-cron.ts:55), el despertador de `poll-visa` vive DENTRO de un run que por eso
    // nunca existe, y `ensure-chain` devolvia `cron_ok` sin mirar el reloj. Si el run
    // DELAYED no se ejecutaba, ninguno de los tres creaba uno nuevo y el bot quedaba
    // dormido para siempre.
    //
    // Casos reales del 2026-08-31: bots 240 (69 min) y 223 (64 min), los dos con
    // `account_ban x1`, o sea 30 min de backoff. El correo del cron los reporto y
    // hubo que despertarlos a mano.
    //
    // El umbral sale de `debeDespertar`, la misma funcion que usa el DEDUP FALLBACK de
    // `poll-visa` y el verificador de `chain-health`. Una sola fuente para los tres.
    if (status === 'DELAYED' || status === 'QUEUED') {
      const vencido = debeDespertar({
        msSinPoll: ban.lastPollAgeMs,
        bansSeguidos: ban.count,
        blockCls: ban.blockCls,
      });
      if (!vencido) return { action: 'cron_ok' };

      logger.warn('ensure-chain: CADENA DORMIDA — el retraso vencio y el run no arranco', {
        botId, runId, status,
        minSinPoll: Math.round(ban.lastPollAgeMs / 60_000),
        backoffMin: Math.round(ban.backoffMs / 60_000),
        bansSeguidos: ban.count,
      });
      // Cae a la cancelacion + re-disparo de mas abajo.
    }
    // Dead/null run: only resurrect once the intended backoff has actually elapsed.
    // (When the ban clears, the next probe recovers within one backoff window.)
    if (ban.lastPollAgeMs < ban.backoffMs) {
      logger.info('ensure-chain: bot in account-ban backoff, skipping', {
        botId,
        lastPollAgeMin: Math.round(ban.lastPollAgeMs / 60_000),
        backoffMin: Math.round(ban.backoffMs / 60_000),
      });
      return { action: 'cron_ok' };
    }
    // Backoff elapsed and no live run → fall through to resurrect a single fresh probe.
  }

  // For cron bots, null activeRunId is normal (cleared between cron ticks).
  // El bot escribe una fila cada HEARTBEAT_MS como MINIMO, no cada poll: el ahorro de
  // escrituras de `poll-logging.ts` se salta los polls tranquilos. Un bot sano tiene su
  // fila mas nueva con 5 a 9 min de antiguedad, entonces exigir menos de 5 min era pedir
  // algo que casi nunca pasa.
  //
  // Efecto medido el 2026-08-31: 80 de los ultimos 100 `notify-user` de prod eran
  // `chain_resurrected`, sobre 11 de los 12 bots. `ensure-chain` resucitaba TODA la flota
  // en CADA corrida, y cada resurreccion disparaba un `poll-visa` que chocaba con el del
  // cron; el dedup mataba a uno de los dos y el bot perdia el turno.
  //
  // La comprobacion vale para CUALQUIER bot sin run vivo, encadenado o no. Antes estaba
  // detras de `usesCron = envs.length > 1`, o sea "corre en dev Y en prod". Los 12 bots
  // de prod tienen `["prod"]`, largo 1, entonces nunca entraban aca. Medido el
  // 2026-08-31: 80 de los ultimos 100 `notify-user` de prod eran `chain_resurrected`,
  // sobre 11 de los 12 bots, 8 veces cada uno.
  //
  // Una fila reciente prueba que el bot esta polleando, y con eso no hay nada que
  // resucitar. El caso de un backoff legitimo ya se resolvio mas arriba, en la rama de
  // DELAYED, entonces llegar aca con actividad reciente significa bot vivo.
  //
  // La condicion mira el ESTADO del run, no si el id existe. `activeCloudRunId` casi
  // siempre apunta a un run CANCELED: el dedup de `poll-visa` cancela el run anterior
  // en cuanto llega el del cron siguiente, y eso pasa hasta en los bots sanos (medido el
  // 2026-08-31: bots 242 y 185, sanos, con 11 de 11 runs CANCELED). Con `if (!runId)` el
  // flujo saltaba esta comprobacion y caia derecho a resucitar. En este punto EXECUTING
  // ya se descarto arriba, y DELAYED/QUEUED se manejan abajo, entonces lo que queda es
  // un run terminal o inexistente: los dos significan "sin run vivo".
  const sinRunVivo = !runId || (status !== 'DELAYED' && status !== 'QUEUED');
  if (sinRunVivo) {
    const [recentLog] = await db.select({ createdAt: pollLogs.createdAt })
      .from(pollLogs)
      .where(eq(pollLogs.botId, botId))
      .orderBy(desc(pollLogs.createdAt))
      .limit(1);

    if (recentLog) {
      const minSince = (Date.now() - recentLog.createdAt.getTime()) / 60000;
      if (minSince < SILENCIO_CRON_MIN) {
        logger.info('ensure-chain: bot con poll reciente, no se resucita', { botId, minSince: Math.round(minSince) });
        return { action: 'cron_ok' };
      }
    }
    // No recent activity — fall through to resurrect
  }

  if (status === 'DELAYED' || status === 'QUEUED') {
    // Cancel stale run (DELAYED waiting 10min, QUEUED, etc.)
    if (runId) {
      try { await runs.cancel(runId); } catch {}
    }
  }

  const { pollVisaTask } = await import('./poll-visa.js');
  const handle = await pollVisaTask.trigger(
    { botId, ...(chainId === 'cloud' ? { chainId: 'cloud' as const } : {}) },
    {
      delay: '1s',
      idempotencyKey: `ensure-restart-${botId}-${chainId ?? 'dev'}-${Math.floor(Date.now() / 60_000)}`,
      queue: 'visa-polling-per-bot',
      concurrencyKey,
      priority: calculatePriority(activatedAt),
      tags,
    },
  );

  const action: RunAction = status === 'DELAYED' || status === 'QUEUED' ? 'pulled_forward' : 'resurrected';
  return { action, newRunId: handle.id };
}

/**
 * Chain Guardian — runs every 10 min in BOTH dev (RPi) and prod (cloud).
 *
 * Each runtime env (DEVELOPMENT / PRODUCTION) only manages chains for ITS env:
 * - dev worker → bot.activeRunId      (concurrencyKey `poll-${id}`)
 * - cloud worker → bot.activeCloudRunId (concurrencyKey `poll-cloud-${id}`)
 *
 * Triggering across envs is unsafe (the spawned run would execute in the wrong
 * env and bypass the pollEnvironments guard).
 *
 * Behavior per chain:
 * - EXECUTING → no-op (already running)
 * - DELAYED / QUEUED → cancel + re-trigger now (releases stuck queue slot)
 * - Dead/null → resurrect (unless cron bot with recent poll_logs)
 *
 * Bursty Tuesday-drop window (8:50–8:59 Bogota) is still covered — the 10 min
 * cadence + per-minute self-chain make sure no bot stays idle for more than
 * ~10 min during normal operation.
 */
export const ensureChainSchedule = schedules.task({
  id: 'ensure-chain',
  cron: {
    // Every 10 minutes — catches orphans within 10 min anywhere in the system.
    pattern: '*/10 * * * *',
    environments: ['DEVELOPMENT', 'PRODUCTION'],
  },
  machine: { preset: 'micro' },
  maxDuration: 60,

  run: async (_payload, { ctx }) => {
    const isCloud = ctx.environment.type === 'PRODUCTION';
    const envLabel = isCloud ? 'cloud' : 'dev';

    // SELECT only columns needed for chain management
    const targetBots = await db.select({
      id: bots.id, status: bots.status,
      activeRunId: bots.activeRunId, activeCloudRunId: bots.activeCloudRunId,
      pollEnvironments: bots.pollEnvironments, cloudEnabled: bots.cloudEnabled,
      activatedAt: bots.activatedAt, locale: bots.locale,
    }).from(bots)
      .where(inArray(bots.status, ['active', 'error']));

    if (targetBots.length === 0) {
      logger.info('ensure-chain: no bots', { env: envLabel });
      return;
    }

    const results: Record<number, RunAction> = {};

    for (const bot of targetBots) {
      const envs = (bot.pollEnvironments as string[] | null) ?? ['dev'];
      const botUsesCloud = envs.includes('prod');
      const botUsesDev = envs.includes('dev');
      const usesCron = envs.length > 1; // dual-source = cron-driven

      // Only manage chains for the env we're running in.
      const manageThisBot = isCloud ? botUsesCloud : botUsesDev;
      if (!manageThisBot) continue;

      const runId = isCloud ? bot.activeCloudRunId : bot.activeRunId;
      const concurrencyKey = isCloud ? `poll-cloud-${bot.id}` : `poll-${bot.id}`;
      const tags = [`bot:${bot.id}`, ...(isCloud ? ['cloud'] : []), 'guardian'];

      const result = await ensureChainForBot(
        bot.id,
        runId,
        concurrencyKey,
        bot.activatedAt,
        tags,
        usesCron,
        isCloud ? 'cloud' : 'dev',
      );

      if (result.newRunId) {
        const updateField = isCloud
          ? { activeCloudRunId: result.newRunId }
          : { activeRunId: result.newRunId };
        await db.update(bots)
          .set({ ...updateField, updatedAt: new Date() })
          .where(eq(bots.id, bot.id));
      }
      results[bot.id] = result.action;

      // Notify only on real resurrections (not pull-forwards or cron_ok)
      if (result.action === 'resurrected') {
        await notifyUserTask.trigger({
          botId: bot.id,
          event: 'chain_resurrected',
          data: { env: envLabel, action: result.action, trigger: 'guardian_10min' },
        }, { tags: [`bot:${bot.id}`] }).catch(() => {});
      }
    }

    logger.info('ensure-chain done', { env: envLabel, results });
  },
});

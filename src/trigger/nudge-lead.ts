import { task, logger } from '@trigger.dev/sdk/v3';

/**
 * nudge-lead - un solo lead, una sola etapa.
 *
 * Reemplaza el barrido por cron cada 3 minutos con una programacion event-driven.
 * En cada mensaje OUTBOUND del bot, Kapso llama la API de Trigger.dev para programar
 * 4 delayed runs (10, 30, 90, 240 min). Cada run re-chequea el estado del lead antes
 * de disparar el bot: si el lead ya respondio, la funcion nudge-rapido de Kapso
 * (la que ya existe) se encarga de decidir si vale la pena tocar.
 *
 * POR QUE SIN CANCELACION. Cancelar por tag cuando entra un inbound anade un hop de
 * red por cada mensaje del lead. En vez de eso, cada nudge-lead RE-CHEQUEA el estado
 * al momento de disparar y skipea si el lead respondio. Es idempotente y mas simple.
 *
 * POR QUE APOYARSE EN nudge-rapido. La logica de clasificacion (que turnos son
 * "tocables"), la tregua de 3h con el motor diario y la ventana Meta de 24h ya
 * viven en la funcion nudge-rapido de Kapso. Re-implementar aca duplicaria
 * decisiones que ya estan verificadas. Este task solo dispara la funcion; ella
 * decide si el lead entra o no.
 *
 * PAYLOAD.
 *   { phone: "573001234567", etapa: 1|2|3|4, scheduledAt: ISO string }
 *   La etapa es informativa; nudge-rapido decide sobre el clasificador real. El
 *   scheduledAt permite ignorar disparos viejos si algo se demoro mucho.
 */
export const nudgeLead = task({
  id: 'nudge-lead',
  maxDuration: 60,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 30000,
  },
  run: async (payload: { phone: string; etapa: number; scheduledAt: string }) => {
    const apiKey = process.env.KAPSO_API_KEY;
    const baseUrl = process.env.KAPSO_API_BASE_URL ?? 'https://app.kapso.ai';
    if (!apiKey) throw new Error('KAPSO_API_KEY no definido');
    if (!payload.phone) throw new Error('phone requerido');

    const NUDGE_FN = '6306721f-693a-48d4-9970-55177495c09a';

    // Le paso el phone especifico a la funcion. La funcion sigue haciendo el
    // clasificador y la tregua, pero solo evalua ESTE lead (mucho mas barato
    // que barrer 300 conversaciones cada 3 min).
    // `solo` filtra el barrido a un solo telefono. La funcion sigue aplicando
    // clasificador + tregua + ventana Meta; solo cambia el conjunto de leads.
    const r = await fetch(`${baseUrl}/api/v1/functions/${NUDGE_FN}/invoke`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        live: true,
        solo: [payload.phone],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`nudge-rapido HTTP ${r.status}: ${body.slice(0, 200)}`);
    }

    const data = (await r.json()) as any;
    const inner = data?.data ?? data;
    const plan = inner?.plan ?? [];
    const actuados = inner?.actuados ?? 0;
    const skipReason = plan.length === 0 ? 'not_a_candidate' : plan[0]?.accion ?? 'unknown';

    logger.info('nudge-lead', {
      phone: payload.phone,
      etapa: payload.etapa,
      scheduledAt: payload.scheduledAt,
      actuados,
      skipReason,
    });

    return { phone: payload.phone, etapa: payload.etapa, actuados, skipReason };
  },
});

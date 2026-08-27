import { schedules, logger } from '@trigger.dev/sdk/v3';

/**
 * Recontacto por horas — reloj del follow-up de cotizaciones (Visagente / Kapso).
 *
 * POR QUÉ VIVE AQUÍ. Kapso no tiene crons: sus únicos triggers son `inbound_message`,
 * `api_call` y `whatsapp_event`, así que el motor de recontacto necesita que alguien de
 * afuera le toque la puerta. Vercel tampoco sirve: el plan Hobby solo permite crons diarios,
 * y ese cron ya lo usa el batch de las 8:00 am. Trigger.dev es el reloj que ya existe.
 *
 * QUÉ DISPARA. La función `reactivation-scheduler` de Kapso, restringida al segmento
 * `cotizado_sin_respuesta`: leads a los que el bot les pasó un precio y no respondieron.
 * Primer toque a las 3 horas, en texto libre (la ventana de 24h suele seguir abierta, así
 * que lo escribe el bot nativo leyendo el historial, sin costo de plantilla).
 *
 * DOS CANDADOS PARA NO PISAR EL BATCH DIARIO:
 *  1. `segments` limita esta corrida al segmento por horas. Los segmentos medidos en días
 *     (churned_frio, etc.) no pueden salir por aquí ni por accidente.
 *  2. El cron corre en el minuto :30, y el batch diario de Vercel en el :00. Sin ese
 *     desfase, las dos corridas podrían ver al mismo lead vencido y mandarle dos mensajes.
 *
 * LA VENTANA HORARIA NO SE DECIDE AQUÍ. La función de Kapso solo envía entre las 8:00 y las
 * 20:00 de Bogotá, y una corrida fuera de ese rango es un no-op que devuelve
 * `fuera_de_ventana: true`. El cron cubre justo esa franja (13:00-00:59 UTC) para no gastar
 * corridas de madrugada, pero si el rango cambia, manda la función, no este archivo.
 */

const RECONTACTO_FN = '1c8b1c4d-59ac-4523-9eac-efcac4375d2d'; // reactivation-scheduler
const MAX_SENDS = 20; // tope por corrida: 12 corridas al día, nunca una avalancha

export const recontactoHorario = schedules.task({
  id: 'recontacto-horario',
  cron: {
    // 13:00-23:30 y 00:30 UTC = 08:30-19:30 Bogotá, o sea la ventana de envío completa.
    // Minuto :30 a propósito: el batch diario de Vercel corre en el :00.
    pattern: '30 13-23,0 * * *',
    environments: ['PRODUCTION'],
  },
  machine: { preset: 'micro' },
  maxDuration: 120,

  run: async () => {
    const apiKey = process.env.KAPSO_API_KEY;
    const baseUrl = process.env.KAPSO_API_BASE_URL ?? 'https://app.kapso.ai';
    if (!apiKey) {
      // Un reloj que no puede llamar no es "una corrida tranquila": es un reloj parado.
      // Se falla ruidosamente para que aparezca en Trigger.dev y no como silencio.
      throw new Error('KAPSO_API_KEY no está definida: el recontacto por horas no puede correr');
    }

    const res = await fetch(`${baseUrl}/api/v1/functions/${RECONTACTO_FN}/invoke`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        live: true,
        max_sends: MAX_SENDS,
        segments: ['cotizado_sin_respuesta'],
      }),
    });

    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const data = (raw.data ?? raw) as Record<string, unknown>;

    if (!res.ok || data.ok === false) {
      throw new Error(`recontacto falló: HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    }

    if (data.fuera_de_ventana === true) {
      logger.log('recontacto: fuera de la ventana de envío', { hora_bogota: data.hora_bogota });
      return { skipped: 'fuera_de_ventana', hora_bogota: data.hora_bogota };
    }

    logger.log('recontacto horario', {
      due: data.due,
      sent: data.sent,
      free_text: data.free_text,
      templates: data.templates,
      errors: data.errors,
    });

    return {
      due: data.due as number,
      sent: data.sent as number,
      free_text: data.free_text as number,
      templates: data.templates as number,
      errors: data.errors as number,
    };
  },
});

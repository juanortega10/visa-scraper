import { schedules, logger } from '@trigger.dev/sdk/v3';

/**
 * Batch diario de recordatorios — el reloj de las 9:00 am Bogotá (Visagente / Kapso).
 *
 * POR QUÉ VIVE AQUÍ. Vivía en `vercel.json` como cron del plan Hobby y se cayó dos veces
 * en silencio:
 *
 *  - 13/08/2026: las llamadas al motor de recontacto no estaban commiteadas y un deploy
 *    desde git las borró. El cron siguió devolviendo 200.
 *  - 14/08/2026: el cron corría a las 12:00 UTC = 7:00 Bogotá, antes de la ventana de envío
 *    [8:00, 20:00). El scheduler devolvía `fuera_de_ventana: true` con 200 y cero envíos.
 *    Quedaron 313 toques vencidos. La hora correcta tampoco estaba en git.
 *
 * El plan Hobby además **desvía el disparo hacia adelante** sin avisar: ese día el cron
 * programado a las 12:00 salió a las 12:27. Con una ventana de envío por horas, esos 27
 * minutos deciden si sale el lote o no. Trigger.dev ya corría el reloj HORARIO
 * (`recontacto-horario.ts`), así que los dos relojes quedan en el mismo sitio.
 *
 * QUÉ DISPARA. `GET /api/cron/jobs` en visagente.com, que encadena cinco cosas:
 * `mark-churned`, `sync-click-ids`, la subida de conversiones offline a Google Ads y Meta,
 * `reactivation-scheduler` (con `batch_diario: true`) y `cobro-proactivo`. La ruta se queda
 * en Vercel a propósito: la subida de conversiones necesita seis secretos que ya viven ahí.
 *
 * POR QUÉ 14:00 UTC. = 9:00 Bogotá. La ventana de envío abre a las 8:00 y el batch de Kapso
 * exige `HORA_BATCH_DIARIO`, así que la corrida tiene que caer dentro de [8:00, 20:00). Una
 * hora de margen sobre el borde: si algún día el reloj se atrasa, no se cae el lote entero.
 *
 * CÓMO FALLA. Ruidosamente, siempre. Cada `throw` de aquí es una corrida roja en Trigger.dev.
 * La regla es que **ningún camino devuelva "ok" sin haber mandado nada**, porque ese es
 * exactamente el modo en que este lote se cayó dos veces: HTTP 200 y cero mensajes.
 */

const MAX_DURATION_S = 240; // la ruta encadena 5 llamadas; la subida de conversiones es la lenta

export type ResultadoBatchDiario = {
  due: number;
  sent: number;
  templates: number;
  errors: number;
};

/**
 * El cuerpo de la corrida, separado de `schedules.task` para que los tests puedan ejecutarlo.
 * El mock del SDK en los tests convierte `schedules.task` en `{ id }`, así que la lógica que
 * viva dentro de `run` no se prueba nunca. Ese es justo el tipo de check verde que no sirve.
 */
export async function correrBatchDiario(): Promise<ResultadoBatchDiario> {
  {
    const secret = process.env.CRON_SECRET;
    const baseUrl = process.env.VISAGENTE_BASE_URL ?? 'https://visagente.com';
    if (!secret) {
      // Un reloj que no puede autenticarse no es "una corrida tranquila": es un reloj parado.
      // Se falla ruidosamente para que aparezca en Trigger.dev y no como silencio.
      throw new Error('CRON_SECRET no está definida: el batch diario no puede correr');
    }

    // `origen=trigger_diario` es lo que hace auditable esta corrida. La ruta se lo pasa al
    // scheduler de Kapso, que lo escribe en el latido `wa_batch_diario_run`. Un curl a mano
    // no lleva el parámetro y queda como "manual", así que arreglar el lote a mano NO puede
    // tapar un reloj muerto en el verificador.
    const url = `${baseUrl}/api/cron/jobs?origen=trigger_diario`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout((MAX_DURATION_S - 30) * 1000),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`batch diario falló: HTTP ${res.status} ${bodyText.slice(0, 300)}`);
    }

    let data: Record<string, any>;
    try {
      data = JSON.parse(bodyText) as Record<string, any>;
    } catch {
      // 200 con cuerpo ilegible es el disfraz clásico de una página de error de Vercel.
      throw new Error(`batch diario devolvió 200 con un cuerpo que no es JSON: ${bodyText.slice(0, 300)}`);
    }

    // El eco del origen prueba que la ruta desplegada entiende el parámetro. Si un deploy
    // viejo lo ignora, el latido saldría como "manual" y el verificador quedaría rojo sin
    // explicación. Mejor que reviente aquí, donde se ve la causa.
    if (data.origen !== 'trigger_diario') {
      throw new Error(
        `la ruta no reconoció ?origen=trigger_diario (devolvió ${JSON.stringify(data.origen)}). ` +
          'Probablemente hay un deploy viejo en producción.',
      );
    }

    const react = (data.reactivation ?? {}) as Record<string, any>;

    // Los tres modos de falla silenciosa que ya se dieron en producción. Los tres respondían
    // HTTP 200 y ninguno mandaba nada.
    if (react.skipped) {
      throw new Error(`la reactivación se saltó: ${react.skipped}. Revisa REACTIVATION_ENABLED en Vercel.`);
    }
    if (react.fuera_de_ventana === true) {
      throw new Error(
        `el batch corrió a las ${react.hora_bogota}:00 Bogotá, fuera de la ventana ` +
          `[${(react.ventana ?? [])[0]}, ${(react.ventana ?? [])[1]}). El cron está a la hora equivocada.`,
      );
    }
    if (typeof react.due !== 'number') {
      throw new Error(`la reactivación no devolvió \`due\`: ${JSON.stringify(react).slice(0, 300)}`);
    }

    // `due > 0 && sent === 0` no es necesariamente un error (todos los vencidos pueden caer en
    // un skip legítimo: respondió, lo atiende un humano, está descartado). Se registra en
    // WARN para que quede en los logs sin volver roja una corrida sana.
    if (react.due > 0 && react.sent === 0) {
      logger.warn('batch diario: había toques vencidos y no salió ninguno', {
        due: react.due,
        by_segment: react.by_segment,
      });
    }
    if (react.errors > 0) {
      logger.warn('batch diario: hubo errores de envío', { errors: react.errors });
    }

    const cobro = (data.cobro ?? {}) as Record<string, any>;
    logger.log('batch diario', {
      reactivacion: { due: react.due, sent: react.sent, templates: react.templates, errors: react.errors },
      cobro: { live: cobro.live, nota: cobro.nota },
      churn: data.churn,
      conversiones: data.conversions,
    });

    return {
      due: react.due as number,
      sent: react.sent as number,
      templates: react.templates as number,
      errors: react.errors as number,
    };
  }
}

export const recontactoDiario = schedules.task({
  id: 'recontacto-diario',
  cron: {
    // 14:00 UTC = 9:00 Bogotá. Ver "POR QUÉ 14:00 UTC" arriba.
    pattern: '0 14 * * *',
    environments: ['PRODUCTION'],
  },
  machine: { preset: 'micro' },
  maxDuration: MAX_DURATION_S,
  run: correrBatchDiario,
});

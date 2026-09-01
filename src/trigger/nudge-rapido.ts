import { schedules, logger } from '@trigger.dev/sdk/v3';

/**
 * Nudge rápido — el reloj del reenganche en minutos (Visagente / Kapso).
 *
 * QUÉ DISPARA. La función `nudge-rapido` de Kapso: leads que están en una conversación viva,
 * el bot habló de último y llevan entre 45 y 150 minutos callados. Manda texto libre (dispara
 * el turno del bot nativo), siempre dentro de la ventana de 24h, así que no cuesta plantilla.
 *
 * POR QUÉ CADA 15 MINUTOS. Las bandas de la función son de 55 y 50 minutos de ancho. Con un
 * reloj horario, un lead que entra a la banda justo después de una corrida espera hasta 60
 * minutos: se le pasaría la banda entera si el reloj se atrasa un poco. Con 15 minutos, la
 * espera máxima es 15 y la banda nunca se pierde. Más frecuencia no compra nada: la banda no
 * empieza hasta el minuto 45.
 *
 * POR QUÉ 45 MINUTOS Y NO 5. Se midió con el replay sobre 622 turnos reales: los leads que se
 * recuperan son los mismos tocando al minuto 6 o al 46 (25 rescates y 31 adelantados en los
 * dos casos), pero al minuto 6 se le escribe encima a 47 personas que estaban escribiendo, y
 * al 46 solo a 5. El toque rápido no ganaba nada. Ver la skill `replay-conversaciones`.
 *
 * NO SE PISA CON LOS OTROS DOS RELOJES:
 *  1. Por tiempo: la función se calla a los 150 minutos y `cotizado_sin_respuesta` del motor
 *     diario arranca a los 180. Lo verifica el check R15.
 *  2. Por marca: hay una tregua de 3 horas en los dos sentidos entre este carril y el motor
 *     diario, porque un lead que habló a las 8:00 cae en los dos a las 9:00. Se mira la marca
 *     y no el texto, porque un toque de texto libre del motor diario es indistinguible de
 *     cualquier otro mensaje del bot. Lo verifica el check R19.
 *
 * CÓMO FALLA. Ruidosamente. Un reloj que no puede llamar es un reloj parado, no una corrida
 * tranquila. Y una corrida que devuelve `api_fallida` no es un día sin leads: es una corrida
 * ciega, y también revienta.
 */

const NUDGE_FN = '6306721f-693a-48d4-9970-55177495c09a'; // nudge-rapido
const MAX_POR_CORRIDA = 15; // el mismo tope que trae la función; explícito para poder bajarlo
const MAX_DURATION_S = 120;

export type ResultadoNudge = {
  revisados: number;
  candidatos: number;
  actuados: number;
};

/**
 * El cuerpo de la corrida, separado de `schedules.task` para que los tests lo puedan ejecutar.
 * El mock del SDK convierte `schedules.task` en `{ id }`, así que la lógica que viva dentro de
 * `run` no se prueba nunca. Ese es justo el tipo de check verde que no sirve.
 */
export async function correrNudgeRapido(): Promise<ResultadoNudge> {
  const apiKey = process.env.KAPSO_API_KEY;
  const baseUrl = process.env.KAPSO_API_BASE_URL ?? 'https://app.kapso.ai';
  if (!apiKey) {
    throw new Error('KAPSO_API_KEY no está definida: el nudge rápido no puede correr');
  }

  const res = await fetch(`${baseUrl}/api/v1/functions/${NUDGE_FN}/invoke`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ live: true, max_por_corrida: MAX_POR_CORRIDA }),
    signal: AbortSignal.timeout((MAX_DURATION_S - 20) * 1000),
  });

  const texto = await res.text();
  if (!res.ok) {
    throw new Error(`nudge rápido falló: HTTP ${res.status} ${texto.slice(0, 300)}`);
  }

  let cuerpo: Record<string, any>;
  try {
    cuerpo = JSON.parse(texto) as Record<string, any>;
  } catch {
    // 200 con cuerpo ilegible es el disfraz clásico de una página de error.
    throw new Error(`el nudge devolvió 200 con un cuerpo que no es JSON: ${texto.slice(0, 300)}`);
  }
  // La API de Kapso envuelve la respuesta de la función en `data` cuando el modo es wrapped.
  const d = (cuerpo.data ?? cuerpo) as Record<string, any>;

  // Una corrida CIEGA no es una corrida tranquila. La función devuelve `api_fallida` cuando no
  // pudo leer la lista de conversaciones, y en ese caso `revisados` viene en null a propósito:
  // un 0 se leería como "no había nadie esperando", que es el modo de falla que dejó al bot
  // amnésico el 2026-08-07.
  if (d.api_fallida === true) {
    throw new Error(
      `el nudge no pudo leer las conversaciones (${d.detalle ?? 'sin detalle'}): esta corrida no vigiló nada.`,
    );
  }
  if (d.ok !== true) {
    throw new Error(`el nudge devolvió ok:false: ${JSON.stringify(d).slice(0, 300)}`);
  }
  if (typeof d.revisados !== 'number') {
    throw new Error(`el nudge no devolvió \`revisados\`: ${JSON.stringify(d).slice(0, 300)}`);
  }

  // Fuera de la franja de envío la función es un no-op legítimo: el cron cubre 8:00-19:45
  // Bogotá, pero si el rango de la función cambia, manda la función y no este archivo.
  const errores = (d.plan ?? []).filter((p: any) => p.accion === 'error');
  if (errores.length > 0) {
    logger.warn('nudge rápido: hubo errores de envío', { errores: errores.slice(0, 5) });
  }

  logger.log('nudge rápido', {
    revisados: d.revisados,
    candidatos: d.candidatos,
    actuados: d.actuados,
    hora_bogota: d.hora_bogota,
    acciones: contarAcciones(d.plan ?? []),
  });

  return {
    revisados: d.revisados as number,
    candidatos: (d.candidatos ?? 0) as number,
    actuados: (d.actuados ?? 0) as number,
  };
}

function contarAcciones(plan: any[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const p of plan) c[p.accion] = (c[p.accion] ?? 0) + 1;
  return c;
}

export const nudgeRapido = schedules.task({
  id: 'nudge-rapido',
  cron: {
    // Cada 15 min entre 13:00 y 00:45 UTC = 08:00-19:45 Bogotá, o sea la franja de envío.
    // No se gastan corridas de madrugada: ahí la función es un no-op de todos modos.
    pattern: '*/15 13-23,0 * * *',
    environments: ['PRODUCTION'],
  },
  machine: { preset: 'micro' },
  maxDuration: MAX_DURATION_S,
  run: correrNudgeRapido,
});

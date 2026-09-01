/**
 * Vigilante de la lectura de imagenes — corre una vez al dia y avisa por Telegram.
 *
 * ── Por que existe ──────────────────────────────────────────────────────────
 *
 * El unico proveedor de vision devolvio `402 insufficient_funds` desde el 2026-08-17
 * y nadie se entero durante trece dias. `analyze-payment-image` anotaba "no analizable"
 * y seguia. Al leer los 19 medios a mano el 2026-08-31 salieron CINCO comprobantes por
 * $589.800 que figuraban como deuda del cliente.
 *
 * ── Por que la sonda vive DENTRO de la funcion de Kapso ─────────────────────
 *
 * Cada proveedor se prueba con la clave que `analyze-payment-image` usa de verdad, que
 * es un secreto propio de esa funcion. Probar desde aqui, o desde Vercel, mediria otras
 * claves y daria un verde que no significa nada: en agosto la que fallo fue justamente
 * el secreto de la funcion.
 *
 * Este cron solo pregunta, decide con `evaluarVision` y avisa. La regla tiene tests en
 * `src/services/__tests__/salud-vision.test.ts`.
 *
 * ── Como falla ──────────────────────────────────────────────────────────────
 *
 * Ruidosamente. Un chequeo que devuelve 200 sin haber probado nada es exactamente la
 * forma del bug original, entonces cada respuesta rara lanza en vez de pasar de largo.
 * Solo se manda mensaje cuando hay alerta: un vigilante que habla todos los dias deja
 * de leerse.
 */
import { schedules, logger } from '@trigger.dev/sdk/v3';
import { evaluarVision, textoVision, type EstadoVision, type ProveedorVision } from '../services/salud-vision.js';
import { sendTelegram } from '../services/notifications.js';

/** `analyze-payment-image`. La sonda de salud vive en su rama `{"salud": true}`. */
export const FN_VISION = '96913878-737c-4ad8-b2d7-a9e99eeb0b2c';
/** `read-all`: ejecuta SQL contra la D1 de Kapso. */
export const FN_SQL = '057d5e7f-ee32-42e4-b160-dd7ffa4a6a41';

const BASE = 'https://app.kapso.ai/platform/v1/functions';

async function invocar(fnId: string, body: unknown): Promise<Record<string, any>> {
  const key = process.env.KAPSO_API_KEY;
  if (!key) throw new Error('KAPSO_API_KEY no esta definida: la sonda no puede correr');

  const res = await fetch(`${BASE}/${fnId}/invoke`, {
    method: 'POST',
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`Kapso HTTP ${res.status}: ${texto.slice(0, 300)}`);
  try {
    return JSON.parse(texto) as Record<string, any>;
  } catch {
    throw new Error(`Kapso devolvio 200 con un cuerpo que no es JSON: ${texto.slice(0, 300)}`);
  }
}

/**
 * Pregunta por los proveedores y por los pendientes.
 *
 * Cualquier respuesta que no traiga una lista de proveedores lanza. Un `proveedores`
 * ausente NO se convierte en `[]` aqui: eso mezclaria "la sonda no contesto" con "no
 * hay proveedores", y son dos problemas con dueños distintos.
 */
export async function leerEstadoVision(): Promise<EstadoVision> {
  const salud = await invocar(FN_VISION, { salud: true });
  const d = salud?.data ?? salud;
  if (!Array.isArray(d?.proveedores)) {
    throw new Error(`la sonda no devolvio la lista de proveedores: ${JSON.stringify(d).slice(0, 300)}`);
  }
  const proveedores: ProveedorVision[] = d.proveedores.map((p: any) => ({
    nombre: String(p?.nombre ?? '?'),
    ok: p?.ok === true,
    detalle: String(p?.detalle ?? ''),
  }));

  const sql = await invocar(FN_SQL, {
    sql: [
      {
        query:
          'SELECT COUNT(*) total, SUM(CASE WHEN media_url IS NOT NULL AND media_url != \'\' THEN 1 ELSE 0 END) con_url, ' +
          "MIN(created_at) mas_viejo FROM image_reads WHERE pending = 1",
        params: [],
      },
      {
        // Lecturas logradas, por cualquier camino: el gateway o el agente nativo.
        query: "SELECT COUNT(*) n FROM image_reads WHERE pending = 0 AND created_at > datetime('now','-24 hours')",
        params: [],
      },
    ],
  });
  const res = sql?.data?.sql_results ?? sql?.data?.data?.sql_results ?? [];
  const r = res[0];
  const rl = res[1];
  if (!r || (r.ok === false && r.error)) {
    throw new Error(`la consulta de pendientes fallo: ${String(r?.error ?? 'sin sql_results')}`);
  }
  if (!rl || (rl.ok === false && rl.error)) {
    throw new Error(`la consulta de lecturas fallo: ${String(rl?.error ?? 'sin sql_results')}`);
  }
  const fila = (r.results ?? r.rows ?? [])[0] ?? {};
  const lecturas24h = Number(((rl.results ?? rl.rows ?? [])[0] ?? {}).n ?? 0);
  const total = Number(fila.total ?? 0);
  const masViejo = fila.mas_viejo ? Date.parse(String(fila.mas_viejo).replace(' ', 'T') + 'Z') : NaN;

  return {
    proveedores,
    lecturas24h,
    pendientes: {
      total,
      conUrl: Number(fila.con_url ?? 0),
      masViejoHoras: total > 0 && Number.isFinite(masViejo)
        ? Math.floor((Date.now() - masViejo) / 3_600_000)
        : 0,
    },
  };
}

export async function correrAuditSaludVision(): Promise<{
  alerta: boolean; severidad: string; arriba: number; pendientes: number; telegram: boolean;
}> {
  const estado = await leerEstadoVision();
  const v = evaluarVision(estado);

  if (!v.alerta) {
    logger.info('salud-vision: en pie', { arriba: v.arriba, pendientes: estado.pendientes.total });
    return { alerta: false, severidad: v.severidad, arriba: v.arriba, pendientes: estado.pendientes.total, telegram: false };
  }

  logger.warn('salud-vision: alerta', {
    severidad: v.severidad, motivo: v.motivo,
    caidos: v.caidos.map((c) => `${c.nombre}: ${c.detalle}`),
  });
  const telegram = await sendTelegram(textoVision(v, estado));
  return { alerta: true, severidad: v.severidad, arriba: v.arriba, pendientes: estado.pendientes.total, telegram };
}

export const auditSaludVision = schedules.task({
  id: 'audit-salud-vision',
  cron: {
    // 13:10 UTC = 08:10 Bogota. Diez minutos despues de `audit-citas-vencidas`, para que
    // los avisos de la mañana no lleguen encimados.
    pattern: '10 13 * * *',
    environments: ['PRODUCTION'],
  },
  machine: { preset: 'micro' },
  maxDuration: 120,
  run: correrAuditSaludVision,
});

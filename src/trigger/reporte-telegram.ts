import { schedules, logger } from '@trigger.dev/sdk/v3';

/**
 * Reporte diario a Telegram (Visagente).
 *
 * QUÉ DISPARA. `GET /api/cron/reporte` en visagente.com, que arma el reporte leyendo Kapso D1
 * y lo manda al bot de Telegram de Juan. Orden: roto, plata, calientes sin cerrar, envíos.
 *
 * POR QUÉ EXISTE. Todo lo que corre solo (batch de reactivación, cobro proactivo, nudge
 * rápido, watchdog) reportaba su resultado a una respuesta HTTP que nadie leía. El 2026-08-31
 * el batch llevaba semanas mandando 57 de cada 65 mensajes a leads de 110 días de promedio, y
 * la única forma de enterarse fue leer el código.
 *
 * POR QUÉ 14:05 UTC. = 9:05 Bogotá, cinco minutos después de `recontacto-diario`. Así el
 * reporte habla del batch que ACABA de correr y no del de ayer. La ruta además se autolimita
 * a una vez al día (marca en `bot_config.reporte_tg_last`), así que una corrida repetida no
 * manda dos reportes.
 *
 * CÓMO FALLA. Ruidosamente: un reporte que no llega es indistinguible de un día sin noticias,
 * y ese es el problema que este mecanismo viene a resolver.
 */

const MAX_DURATION_S = 120;

export async function correrReporteTelegram(): Promise<{ enviado: boolean }> {
  const secret = process.env.CRON_SECRET;
  // Con `www`: el apex responde 307 hacia www y el header Authorization no sobrevive el salto.
  const baseUrl = process.env.VISAGENTE_BASE_URL ?? 'https://www.visagente.com';
  if (!secret) {
    throw new Error('CRON_SECRET no está definida: el reporte no puede correr');
  }

  const url = `${baseUrl}/api/cron/reporte`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${secret}` },
    redirect: 'error',
    signal: AbortSignal.timeout((MAX_DURATION_S - 20) * 1000),
  }).catch((e) => {
    throw new Error(
      `no pude llamar a ${url}: ${String(e)}. Si es un redirect, apunta VISAGENTE_BASE_URL ` +
        `al host definitivo (con www): el header Authorization no sobrevive el salto.`,
    );
  });

  const texto = await res.text();
  if (!res.ok) {
    throw new Error(`el reporte falló: HTTP ${res.status} ${texto.slice(0, 300)}`);
  }

  let d: Record<string, any>;
  try {
    d = JSON.parse(texto) as Record<string, any>;
  } catch {
    throw new Error(`el reporte devolvió 200 con un cuerpo que no es JSON: ${texto.slice(0, 300)}`);
  }

  // `ya_salio_hoy` y `todavia_no` son no-ops legítimos: la ruta se autolimita a uno al día.
  // Cualquier otro `enviado: false` es un fallo de envío disfrazado de 200.
  if (d.enviado !== true) {
    const motivo = String(d.motivo ?? '');
    if (motivo === 'ya_salio_hoy' || motivo === 'todavia_no') {
      logger.log('reporte: no tocaba', { motivo, hoy: d.hoy, hora: d.hora });
      return { enviado: false };
    }
    throw new Error(`el reporte no salió: ${d.error ?? JSON.stringify(d).slice(0, 300)}`);
  }

  logger.log('reporte enviado a Telegram', { hoy: d.hoy, hora: d.hora });
  return { enviado: true };
}

export const reporteTelegram = schedules.task({
  id: 'reporte-telegram',
  cron: {
    // 14:05 UTC = 9:05 Bogotá, justo después de recontacto-diario (14:00). Ver arriba.
    pattern: '5 14 * * *',
    environments: ['PRODUCTION'],
  },
  machine: { preset: 'micro' },
  maxDuration: MAX_DURATION_S,
  run: correrReporteTelegram,
});

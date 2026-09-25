import { task, schedules, logger, queue } from '@trigger.dev/sdk/v3';
import { Resend } from 'resend';
import { sendWhatsAppText, sendWhatsAppTemplate } from '../services/whatsapp-send.js';
import {
  modo, sincronizar, porProgramar, marcarProgramado, vencidos, enviarUno, cerrarAtascados, actualizarEntregas,
  type Envios,
} from '../services/recordatorios/core.js';

/**
 * Recordatorios de la llamada con Erika. Ver `services/recordatorios/core.ts` para el diseño.
 *
 * `barredor-recordatorios` corre cada minuto en el worker de la RPi (entorno DEV).
 * `enviar-recordatorio` es el run diferido de una sola fila: arranca 20 s antes de la hora
 * y espera en memoria hasta el segundo exacto, así el arranque no se come la precisión.
 */

/** Cola propia: los polls de la RPi no pueden quitarle cupo a un recordatorio. */
export const recordatoriosQueue = queue({ name: 'recordatorios-llamada', concurrencyLimit: 10 });

const ANTICIPO_MS = 20_000;
const FROM = 'Visagente <notificaciones@notifications.visagente.com>';

let resend: Resend | null = null;

export const enviosReales: Envios = {
  whatsappTexto: (t, texto) => sendWhatsAppText(t, texto),
  whatsappPlantilla: (t, nombre, params) => sendWhatsAppTemplate(t, nombre, params),
  email: async (to, asunto, html, texto) => {
    if (!process.env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY no está configurada' };
    resend ??= new Resend(process.env.RESEND_API_KEY);
    const r = await resend.emails.send({ from: FROM, to, subject: asunto, html, text: texto });
    return r.error ? { ok: false, error: r.error.message } : { ok: true, id: r.data?.id };
  },
};

async function consultarMensaje(wamid: string): Promise<unknown> {
  const base = process.env.KAPSO_API_BASE_URL ?? 'https://app.kapso.ai';
  const r = await fetch(`${base}/platform/v1/whatsapp/messages/${encodeURIComponent(wamid)}`, {
    headers: { 'X-API-Key': process.env.KAPSO_API_KEY || '' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Kapso ${r.status}`);
  return r.json();
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const enviarRecordatorio = task({
  id: 'enviar-recordatorio',
  queue: recordatoriosQueue,
  machine: { preset: 'micro' },
  maxDuration: 120,
  // Sin reintentos del SDK: un error devuelve la fila a pendiente y el barredor la retoma.
  retry: { maxAttempts: 1 },
  run: async (payload: { id: number; sendAt: string }) => {
    const sendAt = new Date(payload.sendAt);
    const espera = sendAt.getTime() - Date.now();
    if (espera > 0) await dormir(Math.min(espera, 60_000));
    const r = await enviarUno(payload.id, enviosReales, { sendAtEsperado: sendAt });
    logger.info('enviar-recordatorio', { id: payload.id, sendAt: payload.sendAt, resultado: r });
    return r;
  },
});

/** El cuerpo del barredor, fuera de `schedules.task` para poder probarlo. */
export async function correrBarredor(ahora = new Date()) {
  const m = modo();
  if (m === 'apagado') return { modo: m };

  const sync = await sincronizar(ahora, m);
  const atascados = await cerrarAtascados();

  let programados = 0;
  for (const f of await porProgramar()) {
    const handle = await enviarRecordatorio.trigger(
      { id: f.id, sendAt: f.send_at.toISOString() },
      {
        delay: new Date(Math.max(Date.now(), f.send_at.getTime() - ANTICIPO_MS)),
        // Misma fila y misma hora = mismo run, aunque dos barredores se crucen.
        idempotencyKey: `recordatorio-${f.id}-${f.send_at.getTime()}`,
        idempotencyKeyTTL: '1d',
      },
    );
    await marcarProgramado(f.id, handle.id);
    programados++;
  }

  // Red de seguridad: lo que su run no envió. De a 5 en paralelo.
  const atrasados = await vencidos();
  const resultados: string[] = [];
  for (let i = 0; i < atrasados.length; i += 5) {
    const lote = await Promise.all(atrasados.slice(i, i + 5).map((f) => enviarUno(f.id, enviosReales)));
    resultados.push(...lote.map((r) => r.estado));
  }

  const entregas = await actualizarEntregas(consultarMensaje);

  return { modo: m, ...sync, atascados, programados, atrasados: atrasados.length, resultados, entregas };
}

export const barredorRecordatorios = schedules.task({
  id: 'barredor-recordatorios',
  cron: '* * * * *',
  queue: recordatoriosQueue,
  maxDuration: 55,
  run: async () => {
    const r = await correrBarredor();
    logger.info('barredor-recordatorios', r);
    return r;
  },
});

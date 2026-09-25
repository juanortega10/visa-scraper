/**
 * Recordatorios de la llamada con Erika: el lado con base de datos.
 *
 * Dos capas, como los sistemas de colas diferidas grandes (Dynein de Airbnb):
 *   1. `call_reminders` en Neon es la fuente de verdad. Cada fila tiene su hora exacta.
 *   2. Un run diferido de Trigger.dev por fila, creado solo cuando faltan menos de
 *      2,5 minutos. Arranca 20 s antes y espera en memoria hasta el segundo exacto.
 *
 * El barredor (cada minuto) hace tres cosas: sincroniza las filas con calcom_bookings,
 * programa los runs de lo que está por vencer y envía directo lo que quedó atrás.
 *
 * Una cita a 5 días no tiene runs creados. Reagendar o cancelar es solo un cambio en Neon:
 * el run viejo, si existía, pierde el claim porque el `send_at` ya no coincide.
 *
 * Interruptor: RECORDATORIOS_MODO = apagado (defecto) | prueba | vivo.
 * En `prueba` solo se envía a los destinos de RECORDATORIOS_SOLO (correos y teléfonos).
 */
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { planear, vigente, type TipoRecordatorio, type TipoLead, type Canal } from './plan.js';
import { PLANTILLAS, parametros, textoLibre, correo, correoAsistencia, type DatosLlamada } from './mensajes.js';

export type Modo = 'apagado' | 'prueba' | 'vivo';

export function modo(): Modo {
  const m = (process.env.RECORDATORIOS_MODO || '').trim();
  return m === 'vivo' || m === 'prueba' ? m : 'apagado';
}

const soloDigitos = (s: string | null | undefined) => (s || '').replace(/\D/g, '');

export function listaPrueba(): { emails: Set<string>; telefonos: Set<string> } {
  const items = (process.env.RECORDATORIOS_SOLO || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    emails: new Set(items.filter((s) => s.includes('@')).map((s) => s.toLowerCase())),
    telefonos: new Set(items.filter((s) => !s.includes('@')).map(soloDigitos).filter(Boolean)),
  };
}

/** Plantillas ya aprobadas en Meta. Lo que no está aquí sale como texto libre. */
export function plantillasAprobadas(): Set<string> {
  return new Set((process.env.RECORDATORIOS_PLANTILLAS_OK || '').split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * La pregunta de asistencia necesita tres cosas: a quién (Erika), la URL de `visa_frontend`
 * donde viven los links, y el secreto compartido para firmarlos. Sin las tres no se planea.
 */
export function configAsistencia(): { email: string; base: string; secreto: string } | null {
  const email = (process.env.RECORDATORIOS_HOST_EMAIL || '').trim();
  const base = (process.env.ASISTENCIA_BASE_URL || '').trim();
  const secreto = (process.env.ASISTENCIA_SECRET || '').trim();
  return email && base && secreto ? { email, base, secreto } : null;
}

export type Fila = {
  id: number;
  booking_id: string;
  tipo: TipoRecordatorio;
  canal: Canal;
  send_at: Date;
  starts_at: Date;
  dest_email: string | null;
  dest_phone: string | null;
  dest_bsuid: string | null;
  nombre: string | null;
  meet_url: string | null;
  es_prueba: boolean;
  intentos: number;
};

// ---------------------------------------------------------------------------
// Envío de una fila ya reclamada. Sin base de datos: recibe todo lo que usa.
// ---------------------------------------------------------------------------

export type Envios = {
  whatsappTexto: (t: { waBsuid: string | null; phone: string | null }, texto: string) => Promise<{ ok: boolean; error?: string; messageId?: string }>;
  whatsappPlantilla: (t: { waBsuid: string | null; phone: string | null }, nombre: string, params: string[]) => Promise<{ ok: boolean; error?: string; messageId?: string }>;
  email: (to: string, asunto: string, html: string, texto: string) => Promise<{ ok: boolean; error?: string; id?: string }>;
};

export type Resultado =
  | { estado: 'enviado'; via: string; externalId?: string }
  | { estado: 'saltado'; motivo: string }
  | { estado: 'error'; motivo: string };

export function permitidoEnPrueba(f: Pick<Fila, 'canal' | 'dest_email' | 'dest_phone'>): boolean {
  const { emails, telefonos } = listaPrueba();
  if (f.canal === 'email') return !!f.dest_email && emails.has(f.dest_email.toLowerCase());
  return !!f.dest_phone && telefonos.has(soloDigitos(f.dest_phone));
}

export async function ejecutar(f: Fila, ahora: Date, envios: Envios, m: Modo = modo()): Promise<Resultado> {
  if (m === 'apagado') return { estado: 'saltado', motivo: 'modo_apagado' };
  if (m === 'prueba' && !permitidoEnPrueba(f)) return { estado: 'saltado', motivo: 'fuera_de_lista_prueba' };
  if (!vigente(f.tipo, f.send_at, f.starts_at, ahora)) return { estado: 'saltado', motivo: 'vencido' };

  const datos: DatosLlamada = { nombre: f.nombre, startsAt: f.starts_at, meetUrl: f.meet_url };

  if (f.tipo === 'asistencia_host') {
    const cfg = configAsistencia();
    if (!cfg || !f.dest_email) return { estado: 'saltado', motivo: 'asistencia_sin_config' };
    const c = correoAsistencia(
      { bookingId: f.booking_id, nombre: f.nombre, startsAt: f.starts_at, leadPhone: f.dest_phone },
      cfg.base, cfg.secreto,
    );
    const r = await envios.email(f.dest_email, c.asunto, c.html, c.texto);
    return r.ok ? { estado: 'enviado', via: 'resend', externalId: r.id } : { estado: 'error', motivo: r.error || 'resend_fallo' };
  }

  if (f.canal === 'email') {
    if (!f.dest_email) return { estado: 'saltado', motivo: 'sin_email' };
    const c = correo(f.tipo as TipoLead, datos, ahora);
    const r = await envios.email(f.dest_email, c.asunto, c.html, c.texto);
    return r.ok ? { estado: 'enviado', via: 'resend', externalId: r.id } : { estado: 'error', motivo: r.error || 'resend_fallo' };
  }

  if (!f.dest_bsuid && !f.dest_phone) return { estado: 'saltado', motivo: 'sin_whatsapp' };
  const target = { waBsuid: f.dest_bsuid, phone: f.dest_phone };
  const plantilla = PLANTILLAS[f.tipo as TipoLead];
  const aprobada = plantillasAprobadas().has(plantilla);
  const porPlantilla = async () => ({
    ...(await envios.whatsappPlantilla(target, plantilla, parametros(f.tipo as TipoLead, datos, ahora))),
    via: `plantilla:${plantilla}`,
  });
  const porTexto = async () => ({ ...(await envios.whatsappTexto(target, textoLibre(f.tipo as TipoLead, datos, ahora))), via: 'texto' });

  // La confirmación sale con la ventana abierta: primero el texto libre, que lleva más. Si la
  // ventana estaba cerrada (el lead agendó por la web sin escribir), cae a la plantilla.
  let r = f.tipo === 'confirmacion' || !aprobada ? await porTexto() : await porPlantilla();
  const fueraDeVentana = !r.ok && !!r.error && /24-hour window/i.test(r.error);
  if (fueraDeVentana && r.via === 'texto' && aprobada) r = await porPlantilla();

  if (r.ok) return { estado: 'enviado', via: r.via, externalId: r.messageId };
  // Fuera de la ventana de 24 h el texto libre no pasa nunca: reintentar no sirve.
  if (r.error && /24-hour window/i.test(r.error)) return { estado: 'saltado', motivo: 'fuera_de_ventana_sin_plantilla' };
  return { estado: 'error', motivo: r.error || 'kapso_fallo' };
}

// ---------------------------------------------------------------------------
// Base de datos
// ---------------------------------------------------------------------------

const MAX_INTENTOS = 3;

/**
 * Citas vivas: no canceladas, en el futuro cercano, y sin una cita posterior de la misma
 * persona. La última regla cubre el reagendamiento de Cal.com, que crea un booking nuevo y
 * puede dejar el viejo sin `cancelled_at`: sin ella se recordaría la hora vieja.
 */
const CITAS_VIVAS = sql`
  SELECT b.booking_id, b.starts_at, b.received_at, b.attendee_name,
         lower(b.attendee_email) AS email,
         coalesce(b.matched_lead_phone, b.wa_phone_meta, b.wa_phone_answered, b.attendee_phone) AS phone,
         b.matched_bsuid AS bsuid,
         b.raw_payload->'payload'->'metadata'->>'videoCallUrl' AS meet
  FROM calcom_bookings b
  WHERE b.event_type <> 'BOOKING_CANCELLED'
    AND b.cancelled_at IS NULL
    AND b.starts_at IS NOT NULL
    -- 2 h hacia atrás: la pregunta de asistencia sale 20 min después de la llamada.
    AND b.starts_at > now() - interval '2 hours'
    -- Citas de prueba e2e: alias de Juan, test@, dominio .local y nombres de prueba.
    AND NOT (lower(b.attendee_email) LIKE 'juanalbertoortega456+%'
          OR lower(b.attendee_email) LIKE 'test+%'
          OR lower(b.attendee_email) LIKE '%@visagente.local'
          OR coalesce(b.attendee_name, '') ILIKE '[test]%'
          OR coalesce(b.attendee_name, '') ILIKE 'testpr%')
    AND b.starts_at < now() + interval '45 days'
    AND NOT EXISTS (
      SELECT 1 FROM calcom_bookings n
      WHERE n.booking_id <> b.booking_id
        AND n.received_at > b.received_at
        AND ((b.attendee_email IS NOT NULL AND lower(n.attendee_email) = lower(b.attendee_email))
          OR (b.matched_lead_phone IS NOT NULL AND n.matched_lead_phone = b.matched_lead_phone))
    )
`;

type CitaViva = {
  booking_id: string; starts_at: string | Date; received_at: string | Date; attendee_name: string | null;
  email: string | null; phone: string | null; bsuid: string | null; meet: string | null;
};

/** Normaliza el teléfono al formato que acepta `pickTarget`: solo dígitos, 10 a 15. */
function telefonoEnviable(p: string | null): string | null {
  const d = soloDigitos(p);
  return d.length >= 10 && d.length <= 15 ? d : null;
}

export async function sincronizar(ahora: Date, m: Modo = modo()): Promise<{ citas: number; filas: number; saltadas: number }> {
  const res = await db.execute<CitaViva>(CITAS_VIVAS);
  let citas = res.rows;
  if (m === 'prueba') {
    const { emails, telefonos } = listaPrueba();
    citas = citas.filter((c) => (c.email && emails.has(c.email)) || telefonos.has(soloDigitos(c.phone)));
  }

  const asistencia = configAsistencia();
  let filas = 0;
  let saltadas = 0;
  for (const c of citas) {
    const startsAt = new Date(c.starts_at);
    const plan = planear({ startsAt, agendadaAt: new Date(c.received_at), ahora, conAsistencia: !!asistencia });
    const phone = telefonoEnviable(c.phone);
    for (const p of plan) {
      await db.execute(sql`
        INSERT INTO call_reminders (booking_id, tipo, canal, send_at, starts_at, dest_email, dest_phone, dest_bsuid, nombre, meet_url)
        VALUES (${c.booking_id}, ${p.tipo}, ${p.canal}, ${p.sendAt.toISOString()}, ${startsAt.toISOString()},
                ${p.tipo === 'asistencia_host' ? asistencia!.email : c.email}, ${phone}, ${c.bsuid}, ${c.attendee_name}, ${c.meet})
        ON CONFLICT (booking_id, tipo, canal) DO UPDATE SET
          send_at = EXCLUDED.send_at, starts_at = EXCLUDED.starts_at,
          dest_email = EXCLUDED.dest_email, dest_phone = EXCLUDED.dest_phone, dest_bsuid = EXCLUDED.dest_bsuid,
          nombre = EXCLUDED.nombre, meet_url = EXCLUDED.meet_url,
          -- Si la hora cambió, el run viejo ya no sirve: se programa otro.
          run_id = CASE WHEN call_reminders.send_at <> EXCLUDED.send_at THEN NULL ELSE call_reminders.run_id END,
          updated_at = now()
        WHERE call_reminders.status = 'pendiente'
          AND (call_reminders.send_at, call_reminders.starts_at, call_reminders.dest_email, call_reminders.dest_phone,
               call_reminders.dest_bsuid, call_reminders.meet_url)
              IS DISTINCT FROM
              (EXCLUDED.send_at, EXCLUDED.starts_at, EXCLUDED.dest_email, EXCLUDED.dest_phone,
               EXCLUDED.dest_bsuid, EXCLUDED.meet_url)
      `);
      filas++;
    }
    // Lo que ya no está en el plan de esta cita (cambió la hora, o venció) no sale.
    const claves = plan.map((p) => `${p.tipo}:${p.canal}`);
    const r = await db.execute(sql`
      UPDATE call_reminders SET status = 'saltado', motivo = 'fuera_del_plan', updated_at = now()
      WHERE booking_id = ${c.booking_id} AND status = 'pendiente'
        AND NOT (tipo || ':' || canal = ANY(string_to_array(${claves.join(',')}, ',')))
    `);
    saltadas += r.rowCount ?? 0;
  }

  // Citas canceladas o reemplazadas: sus pendientes no salen. Las filas de prueba no tienen cita.
  const vivas = citas.map((c) => c.booking_id);
  if (m === 'vivo') {
    const r = await db.execute(sql`
      UPDATE call_reminders SET status = 'saltado', motivo = 'cita_no_vigente', updated_at = now()
      WHERE status = 'pendiente' AND NOT es_prueba
        AND NOT (booking_id = ANY(string_to_array(${vivas.join(',')}, ',')))
    `);
    saltadas += r.rowCount ?? 0;
  }
  return { citas: citas.length, filas, saltadas };
}

/** Pendientes que vencen en los próximos 150 s y todavía no tienen run. */
export async function porProgramar(): Promise<{ id: number; send_at: Date }[]> {
  const r = await db.execute<{ id: string; send_at: string }>(sql`
    SELECT id, send_at FROM call_reminders
    WHERE status = 'pendiente' AND run_id IS NULL
      AND send_at <= now() + interval '150 seconds'
      AND send_at >= now() - interval '60 seconds'
    ORDER BY send_at LIMIT 500
  `);
  return r.rows.map((x) => ({ id: Number(x.id), send_at: new Date(x.send_at) }));
}

export async function marcarProgramado(id: number, runId: string): Promise<void> {
  await db.execute(sql`UPDATE call_reminders SET run_id = ${runId}, updated_at = now() WHERE id = ${id} AND status = 'pendiente'`);
}

/** Pendientes con más de 60 s de atraso: su run no llegó o falló. El barredor los envía. */
export async function vencidos(): Promise<{ id: number }[]> {
  const r = await db.execute<{ id: string }>(sql`
    SELECT id FROM call_reminders
    WHERE status = 'pendiente' AND send_at < now() - interval '60 seconds'
    ORDER BY send_at LIMIT 100
  `);
  return r.rows.map((x) => ({ id: Number(x.id) }));
}

/** El claim. Solo un proceso pasa de pendiente a enviando. */
async function reclamar(id: number, sendAtEsperado: Date | null): Promise<Fila | null> {
  const r = await db.execute<Record<string, unknown>>(sql`
    UPDATE call_reminders SET status = 'enviando', claimed_at = now(), updated_at = now()
    WHERE id = ${id} AND status = 'pendiente'
      ${sendAtEsperado ? sql`AND send_at = ${sendAtEsperado.toISOString()}` : sql``}
    RETURNING *
  `);
  const f = r.rows[0];
  if (!f) return null;
  return {
    ...(f as unknown as Fila),
    id: Number(f.id),
    send_at: new Date(f.send_at as string),
    starts_at: new Date(f.starts_at as string),
  };
}

async function citaSigueIgual(f: Fila): Promise<boolean> {
  const r = await db.execute<{ starts_at: string }>(sql`
    SELECT starts_at FROM (${CITAS_VIVAS}) v WHERE v.booking_id = ${f.booking_id}
  `);
  const viva = r.rows[0];
  return !!viva && new Date(viva.starts_at).getTime() === f.starts_at.getTime();
}

export async function enviarUno(
  id: number,
  envios: Envios,
  opts: { sendAtEsperado?: Date | null; ahora?: () => Date } = {},
): Promise<Resultado | { estado: 'no_reclamado' }> {
  const reloj = opts.ahora ?? (() => new Date());
  const f = await reclamar(id, opts.sendAtEsperado ?? null);
  if (!f) return { estado: 'no_reclamado' };

  let res: Resultado;
  if (!f.es_prueba && !(await citaSigueIgual(f))) {
    res = { estado: 'saltado', motivo: 'cita_cambio' };
  } else {
    try {
      res = await ejecutar(f, reloj(), envios);
    } catch (e) {
      res = { estado: 'error', motivo: e instanceof Error ? e.message : String(e) };
    }
  }

  if (res.estado === 'enviado') {
    await db.execute(sql`
      UPDATE call_reminders SET status = 'enviado', sent_at = now(),
        lag_ms = (extract(epoch FROM (now() - send_at)) * 1000)::int,
        via = ${res.via}, external_id = ${res.externalId ?? null}, updated_at = now()
      WHERE id = ${id}
    `);
  } else if (res.estado === 'saltado') {
    await db.execute(sql`UPDATE call_reminders SET status = 'saltado', motivo = ${res.motivo}, updated_at = now() WHERE id = ${id}`);
  } else {
    // Error: vuelve a pendiente y el barredor lo reintenta en el siguiente minuto.
    const final = f.intentos + 1 >= MAX_INTENTOS;
    await db.execute(sql`
      UPDATE call_reminders SET
        status = ${final ? 'fallido' : 'pendiente'}, intentos = intentos + 1, run_id = NULL,
        motivo = ${res.motivo.slice(0, 500)}, updated_at = now()
      WHERE id = ${id}
    `);
  }
  return res;
}

/**
 * Filas atascadas en 'enviando' (el proceso murió entre el claim y el resultado). No se
 * reintentan: no se sabe si el mensaje salió, y un doble recordatorio es peor que uno menos.
 */
export async function cerrarAtascados(): Promise<number> {
  const r = await db.execute(sql`
    UPDATE call_reminders SET status = 'fallido', motivo = 'atascado_en_enviando', updated_at = now()
    WHERE status = 'enviando' AND claimed_at < now() - interval '5 minutes'
  `);
  return r.rowCount ?? 0;
}

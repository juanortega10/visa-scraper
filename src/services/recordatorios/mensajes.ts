/**
 * Textos de los recordatorios. Un solo lugar para el WhatsApp (plantilla o texto libre) y el
 * correo, para que los dos canales digan lo mismo.
 *
 * Las plantillas de Meta usan parámetros posicionales. `parametros` devuelve la lista en el
 * orden exacto del cuerpo aprobado; `textoLibre` arma el mismo mensaje ya relleno para cuando
 * la ventana de 24 h está abierta o la plantilla aún no está aprobada.
 */
import { createHmac } from 'node:crypto';
import type { TipoLead } from './plan.js';

export type DatosLlamada = {
  nombre: string | null;
  startsAt: Date;
  meetUrl: string | null;
};

const TZ = 'America/Bogota';

export const PLANTILLAS: Record<TipoLead, string> = {
  confirmacion: 'recordatorio_llamada_confirmacion',
  // v2: la v1 decía "15 minutos" y la llamada dura 20. Borrada el 2026-09-25; Meta no deja reusar el nombre.
  t24h: 'recordatorio_llamada_24h_v2',
  t2h: 'recordatorio_llamada_2h',
  t10m: 'recordatorio_llamada_10m',
};

function diaBogota(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

/** "3:00 p. m." en hora Colombia. */
export function horaCorta(d: Date): string {
  return d.toLocaleTimeString('es-CO', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
}

/** "hoy a las 3:00 p. m.", "mañana jueves 2 de octubre a las 3:00 p. m." o "el jueves 2 de octubre a las ...". */
export function cuando(startsAt: Date, ahora: Date): string {
  const hora = horaCorta(startsAt);
  const fecha = startsAt.toLocaleDateString('es-CO', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  const hoy = diaBogota(ahora);
  const manana = diaBogota(new Date(ahora.getTime() + 86_400_000));
  const dia = diaBogota(startsAt);
  if (dia === hoy) return `hoy a las ${hora}`;
  if (dia === manana) return `mañana ${fecha} a las ${hora}`;
  return `el ${fecha} a las ${hora}`;
}

function primerNombre(nombre: string | null): string {
  const n = (nombre || '').trim().split(/\s+/)[0] || '';
  if (!n) return 'hola';
  return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
}

const SIN_LINK = 'te lo enviamos por aquí antes de la llamada';

/** Parámetros en el orden del cuerpo de cada plantilla. */
export function parametros(tipo: TipoLead, d: DatosLlamada, ahora: Date): string[] {
  const nombre = primerNombre(d.nombre);
  const link = d.meetUrl || SIN_LINK;
  if (tipo === 't10m') return [nombre, link];
  return [nombre, cuando(d.startsAt, ahora), link];
}

/**
 * Cuerpos de las plantillas, con {{n}}. Se usan para crearlas en Meta y para el texto libre:
 * así el mensaje por texto y el aprobado no se desalinean. Meta rechaza un cuerpo que empieza
 * o termina en una variable: por eso cada uno cierra con una frase fija.
 */
export const CUERPOS: Record<TipoLead, string> = {
  confirmacion:
    'Hola {{1}}, quedó agendada tu llamada con Erika {{2}} (hora Colombia). ' +
    'Es por Google Meet: {{3}}\n\nSi no puedes asistir, respóndenos aquí y la movemos a otro horario.',
  t24h:
    'Hola {{1}}, te recordamos tu llamada con Erika {{2}} (hora Colombia). ' +
    'Es por Google Meet: {{3}}\n\nSi ya no puedes, respóndenos aquí y buscamos otro horario.',
  t2h:
    'Hola {{1}}, tu llamada con Erika es {{2}} (hora Colombia). Link de Google Meet: {{3}}\n\nTe esperamos.',
  t10m:
    'Hola {{1}}, Erika se conecta en 10 minutos. Entra aquí: {{2}}\n\nSi no puedes entrar, respóndenos por aquí.',
};

export function rellenar(cuerpo: string, params: string[]): string {
  return cuerpo.replace(/\{\{(\d+)\}\}/g, (_, i) => params[Number(i) - 1] ?? '');
}

/**
 * La confirmación sale segundos después de agendar, con la ventana de 24 h abierta: va como
 * texto libre y puede llevar lo que una plantilla UTILITY no aguanta (Meta la reclasifica a
 * MARKETING si suena a venta). Tácticas con evidencia: qué gana, costo específico de faltar,
 * preparación y salida para reagendar.
 */
export const CONFIRMACION_LIBRE =
  'Hola {{1}}, quedó agendada tu llamada con Erika {{2}} (hora Colombia).\n\n' +
  'En la llamada Erika revisa tu caso y te dice cuál es el mejor camino para tu cita. ' +
  'Ella reserva ese espacio solo para ti.\n\n' +
  'Ten a la mano tu cita actual o tu DS-160, si ya lo tienes. Link de Google Meet: {{3}}\n\n' +
  'Si no puedes asistir, respóndeme aquí y la movemos.';

export function textoLibre(tipo: TipoLead, d: DatosLlamada, ahora: Date): string {
  const cuerpo = tipo === 'confirmacion' ? CONFIRMACION_LIBRE : CUERPOS[tipo];
  return rellenar(cuerpo, parametros(tipo, d, ahora));
}

const ASUNTOS: Record<TipoLead, (d: DatosLlamada, ahora: Date) => string> = {
  confirmacion: (d, a) => `Tu llamada con Erika quedó agendada: ${cuando(d.startsAt, a)}`,
  t24h: (d, a) => `Recordatorio: tu llamada con Erika es ${cuando(d.startsAt, a)}`,
  t2h: (d, a) => `Tu llamada con Erika es ${cuando(d.startsAt, a)}`,
  t10m: () => 'Erika se conecta en 10 minutos',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function correo(tipo: TipoLead, d: DatosLlamada, ahora: Date): { asunto: string; html: string; texto: string } {
  const texto = textoLibre(tipo, d, ahora);
  const parrafos = texto
    .split('\n\n')
    .map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#0a1628">${esc(p)}</p>`)
    .join('');
  const boton = d.meetUrl
    ? `<p style="margin:24px 0"><a href="${esc(d.meetUrl)}" style="background:#22d3a7;color:#0a1628;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Entrar a la llamada</a></p>`
    : '';
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px">${parrafos}${boton}<p style="font-size:12px;color:#64748b;margin-top:32px">Visagente</p></div>`;
  return { asunto: ASUNTOS[tipo](d, ahora), html, texto };
}

// ---------------------------------------------------------------------------
// Pregunta de asistencia a Erika
// ---------------------------------------------------------------------------

/** Firma de un link de asistencia. La verifica `visa_frontend/src/app/api/asistencia`. */
export function firmaAsistencia(bookingId: string, asistio: '1' | '0', secreto: string): string {
  return createHmac('sha256', secreto).update(`${bookingId}.${asistio}`).digest('hex');
}

export function linkAsistencia(base: string, bookingId: string, asistio: '1' | '0', secreto: string): string {
  const u = new URL('/api/asistencia', base);
  u.searchParams.set('b', bookingId);
  u.searchParams.set('v', asistio);
  u.searchParams.set('s', firmaAsistencia(bookingId, asistio, secreto));
  return u.toString();
}

export function correoAsistencia(
  d: { bookingId: string; nombre: string | null; startsAt: Date; leadPhone: string | null },
  base: string,
  secreto: string,
): { asunto: string; html: string; texto: string } {
  const nombre = (d.nombre || '').trim() || 'el lead';
  const hora = horaCorta(d.startsAt);
  const si = linkAsistencia(base, d.bookingId, '1', secreto);
  const no = linkAsistencia(base, d.bookingId, '0', secreto);
  const boton = (href: string, txt: string, fondo: string) =>
    `<a href="${esc(href)}" style="background:${fondo};color:#0a1628;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-right:12px">${txt}</a>`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0a1628">
<p style="font-size:16px">¿Se conectó <b>${esc(nombre)}</b> a la llamada de las ${esc(hora)}?</p>
${d.leadPhone ? `<p style="font-size:14px;color:#64748b">WhatsApp: ${esc(d.leadPhone)}</p>` : ''}
<p style="margin:24px 0">${boton(si, 'Sí, se conectó', '#22d3a7')}${boton(no, 'No se conectó', '#fca5a5')}</p>
<p style="font-size:12px;color:#64748b">Con esta respuesta medimos si los recordatorios suben la asistencia.</p></div>`;
  const texto = `¿Se conectó ${nombre} a la llamada de las ${hora}?\nSí: ${si}\nNo: ${no}`;
  return { asunto: `¿Se conectó ${nombre}? Llamada de las ${hora}`, html, texto };
}

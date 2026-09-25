/**
 * Planificador de recordatorios de la llamada con Erika.
 *
 * Función pura: recibe la cita y devuelve qué recordatorio sale, por qué canal y a qué hora.
 * La hora se calcula UNA vez a partir de `startsAt`. El volumen de envíos no la mueve: el
 * barredor y el run diferido solo ejecutan lo que este módulo decidió.
 *
 * La secuencia depende de cuánto falta para la llamada al agendar:
 *
 *   | tipo         | cita a >=24h | cita a <24h                       | canal      |
 *   |--------------|--------------|-----------------------------------|------------|
 *   | confirmacion | sí           | sí                                | wa + email |
 *   | t24h         | sí           | no                                | wa + email |
 *   | t2h          | sí           | solo si faltan más de 3 h         | wa         |
 *   | t10m         | sí           | solo si faltan más de 20 min      | wa + email |
 *
 * Además, `asistencia_host` sale 20 min después de la hora de la llamada, por correo a Erika,
 * solo si se pide (`conAsistencia`). Es el registro de asistencia: sin él no se mide nada.
 *
 * Horario de silencio 21:00 a 07:00 Bogotá: t24h y t2h se adelantan a las 20:30 del día
 * anterior. La confirmación y el t10m nunca se mueven (la persona acaba de agendar, o la
 * llamada es inminente).
 */

/** Tipos que recibe el lead. */
export type TipoLead = 'confirmacion' | 't24h' | 't2h' | 't10m';
/** `asistencia_host`: 20 min después de la llamada, pregunta a Erika si el lead se conectó. */
export type TipoRecordatorio = TipoLead | 'asistencia_host';
export type Canal = 'whatsapp' | 'email';

export type RecordatorioPlaneado = {
  tipo: TipoRecordatorio;
  canal: Canal;
  sendAt: Date;
};

const MIN = 60_000;
const HORA = 60 * MIN;

/** Bogotá es UTC-5 todo el año (sin horario de verano). */
const OFFSET_BOGOTA_MS = -5 * HORA;
const SILENCIO_DESDE_H = 21;
const SILENCIO_HASTA_H = 7;
/** A dónde se adelanta un recordatorio que cae en silencio: 20:30 del día anterior. */
const REFUGIO_H = 20;
const REFUGIO_MIN = 30;

/**
 * Cuánto tarde puede salir cada tipo antes de dejar de tener sentido. Un t10m que sale
 * después de empezar la llamada estorba; una confirmación de hace una hora sigue sirviendo.
 */
export const TOLERANCIA_MS: Record<TipoRecordatorio, number> = {
  confirmacion: 30 * MIN,
  t24h: 3 * HORA,
  t2h: 45 * MIN,
  t10m: 8 * MIN,
  // Erika puede leer el correo horas después: la pregunta sigue sirviendo el mismo día.
  asistencia_host: 12 * HORA,
};

const CANALES: Record<TipoRecordatorio, Canal[]> = {
  confirmacion: ['whatsapp', 'email'],
  t24h: ['whatsapp', 'email'],
  t2h: ['whatsapp'],
  t10m: ['whatsapp', 'email'],
  asistencia_host: ['email'],
};

function horaBogota(d: Date): number {
  return new Date(d.getTime() + OFFSET_BOGOTA_MS).getUTCHours();
}

export function enSilencio(d: Date): boolean {
  const h = horaBogota(d);
  return h >= SILENCIO_DESDE_H || h < SILENCIO_HASTA_H;
}

/** Mueve una hora en silencio a las 20:30 Bogotá anteriores. Fuera de silencio no la toca. */
export function salirDelSilencio(d: Date): Date {
  if (!enSilencio(d)) return d;
  const local = new Date(d.getTime() + OFFSET_BOGOTA_MS);
  // Antes de las 07:00 el refugio es la noche anterior; desde las 21:00 es la misma noche.
  if (local.getUTCHours() < SILENCIO_HASTA_H) local.setUTCDate(local.getUTCDate() - 1);
  local.setUTCHours(REFUGIO_H, REFUGIO_MIN, 0, 0);
  return new Date(local.getTime() - OFFSET_BOGOTA_MS);
}

/**
 * @param startsAt   inicio de la llamada
 * @param agendadaAt cuándo entró la cita (received_at del webhook)
 * @param ahora      reloj; los recordatorios ya vencidos más allá de su tolerancia se descartan
 */
export function planear(input: { startsAt: Date; agendadaAt: Date; ahora: Date; conAsistencia?: boolean }): RecordatorioPlaneado[] {
  const { startsAt, agendadaAt, ahora } = input;
  const anticipacion = startsAt.getTime() - agendadaAt.getTime();
  if (anticipacion <= 0) return [];

  const horas: Partial<Record<TipoRecordatorio, Date>> = { confirmacion: agendadaAt };
  if (anticipacion >= 24 * HORA) horas.t24h = salirDelSilencio(new Date(startsAt.getTime() - 24 * HORA));
  if (anticipacion > 3 * HORA) horas.t2h = salirDelSilencio(new Date(startsAt.getTime() - 2 * HORA));
  if (anticipacion > 20 * MIN) horas.t10m = new Date(startsAt.getTime() - 10 * MIN);
  if (input.conAsistencia) horas.asistencia_host = new Date(startsAt.getTime() + 20 * MIN);

  const plan: RecordatorioPlaneado[] = [];
  for (const [tipo, sendAt] of Object.entries(horas) as [TipoRecordatorio, Date][]) {
    // Un adelanto por silencio nunca puede quedar antes de que existiera la cita.
    if (sendAt.getTime() < agendadaAt.getTime()) continue;
    if (ahora.getTime() - sendAt.getTime() > TOLERANCIA_MS[tipo]) continue;
    for (const canal of CANALES[tipo]) plan.push({ tipo, canal, sendAt });
  }
  return plan;
}

/** ¿Sigue teniendo sentido enviar ahora? Se revisa otra vez en el momento del envío. */
export function vigente(tipo: TipoRecordatorio, sendAt: Date, startsAt: Date | null, ahora: Date): boolean {
  if (ahora.getTime() - sendAt.getTime() > TOLERANCIA_MS[tipo]) return false;
  const antesDeLaLlamada = tipo === 't24h' || tipo === 't2h' || tipo === 't10m';
  if (startsAt && antesDeLaLlamada && ahora.getTime() > startsAt.getTime()) return false;
  return true;
}

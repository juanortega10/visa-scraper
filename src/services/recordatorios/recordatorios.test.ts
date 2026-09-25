import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// La RPi puede correr en UTC y el Mac en hora de Bogotá. Con UTC aquí, un formato que olvide
// `timeZone` se pone rojo en cualquier máquina.
process.env.TZ = 'UTC';

vi.mock('../../db/client.js', () => ({ db: {} }));

const { planear, salirDelSilencio, enSilencio, vigente } = await import('./plan.js');
const { cuando, parametros, textoLibre, CUERPOS, correo, CONFIRMACION_LIBRE, firmaAsistencia, correoAsistencia } = await import('./mensajes.js');
const { ejecutar, leerEntrega, EVENT_TYPE_ID } = await import('./core.js');
type Fila = import('./core.js').Fila;

/** Hora de Bogotá (UTC-5) a Date. */
const bog = (iso: string) => new Date(`${iso}-05:00`);
const claves = (p: { tipo: string; canal: string; sendAt: Date }[]) =>
  p.map((x) => `${x.tipo}:${x.canal}@${x.sendAt.toISOString()}`).sort();

describe('planear: cita a 24 h o más', () => {
  it('lunes 10:00 para miércoles 15:00: confirmación, 24h, 2h y 10m, con sus canales', () => {
    const agendadaAt = bog('2026-09-28T10:00:00');
    const startsAt = bog('2026-09-30T15:00:00');
    const plan = planear({ startsAt, agendadaAt, ahora: agendadaAt });
    expect(claves(plan)).toEqual(claves([
      { tipo: 'confirmacion', canal: 'whatsapp', sendAt: agendadaAt },
      { tipo: 'confirmacion', canal: 'email', sendAt: agendadaAt },
      { tipo: 't24h', canal: 'whatsapp', sendAt: bog('2026-09-29T15:00:00') },
      { tipo: 't24h', canal: 'email', sendAt: bog('2026-09-29T15:00:00') },
      { tipo: 't2h', canal: 'whatsapp', sendAt: bog('2026-09-30T13:00:00') },
      { tipo: 't10m', canal: 'whatsapp', sendAt: bog('2026-09-30T14:50:00') },
      { tipo: 't10m', canal: 'email', sendAt: bog('2026-09-30T14:50:00') },
    ]));
  });

  it('exactamente 24 h de anticipación sí lleva t24h (el borde es >=)', () => {
    const agendadaAt = bog('2026-09-28T10:00:00');
    const plan = planear({ startsAt: bog('2026-09-29T10:00:00'), agendadaAt, ahora: agendadaAt });
    expect(plan.some((p) => p.tipo === 't24h')).toBe(true);
  });
});

describe('planear: cita a menos de 24 h', () => {
  it('10:00 para las 18:00: sin t24h, con t2h y t10m', () => {
    const agendadaAt = bog('2026-09-28T10:00:00');
    const tipos = planear({ startsAt: bog('2026-09-28T18:00:00'), agendadaAt, ahora: agendadaAt }).map((p) => p.tipo);
    expect(new Set(tipos)).toEqual(new Set(['confirmacion', 't2h', 't10m']));
  });

  it('a 23 h 59 min no lleva t24h', () => {
    const agendadaAt = bog('2026-09-28T10:01:00');
    const tipos = planear({ startsAt: bog('2026-09-29T10:00:00'), agendadaAt, ahora: agendadaAt }).map((p) => p.tipo);
    expect(tipos).not.toContain('t24h');
  });

  it('a 2 h: solo confirmación y t10m (t2h exige más de 3 h)', () => {
    const agendadaAt = bog('2026-09-28T10:00:00');
    const tipos = planear({ startsAt: bog('2026-09-28T12:00:00'), agendadaAt, ahora: agendadaAt }).map((p) => p.tipo);
    expect(new Set(tipos)).toEqual(new Set(['confirmacion', 't10m']));
  });

  it('a 2 h 30 min: todavía sin t2h', () => {
    const agendadaAt = bog('2026-09-28T10:00:00');
    const tipos = planear({ startsAt: bog('2026-09-28T12:30:00'), agendadaAt, ahora: agendadaAt }).map((p) => p.tipo);
    expect(tipos).not.toContain('t2h');
  });

  it('a 15 min: solo confirmación (t10m exige más de 20 min)', () => {
    const agendadaAt = bog('2026-09-28T10:00:00');
    const tipos = planear({ startsAt: bog('2026-09-28T10:15:00'), agendadaAt, ahora: agendadaAt }).map((p) => p.tipo);
    expect(new Set(tipos)).toEqual(new Set(['confirmacion']));
  });

  it('una cita en el pasado no genera nada', () => {
    const agendadaAt = bog('2026-09-28T10:00:00');
    expect(planear({ startsAt: bog('2026-09-28T09:00:00'), agendadaAt, ahora: agendadaAt })).toEqual([]);
  });
});

describe('horario de silencio 21:00 a 07:00 Bogotá', () => {
  it('reconoce los bordes', () => {
    expect(enSilencio(bog('2026-09-28T20:59:00'))).toBe(false);
    expect(enSilencio(bog('2026-09-28T21:00:00'))).toBe(true);
    expect(enSilencio(bog('2026-09-29T06:59:00'))).toBe(true);
    expect(enSilencio(bog('2026-09-29T07:00:00'))).toBe(false);
  });

  it('las 06:00 se mueven a las 20:30 de la noche anterior; las 22:00, a las 20:30 de esa noche', () => {
    expect(salirDelSilencio(bog('2026-09-29T06:00:00'))).toEqual(bog('2026-09-28T20:30:00'));
    expect(salirDelSilencio(bog('2026-09-28T22:00:00'))).toEqual(bog('2026-09-28T20:30:00'));
    expect(salirDelSilencio(bog('2026-09-28T12:00:00'))).toEqual(bog('2026-09-28T12:00:00'));
  });

  it('llamada a las 08:00: el t2h sale 20:30 de la noche anterior y el t10m no se mueve', () => {
    const agendadaAt = bog('2026-09-25T10:00:00');
    const plan = planear({ startsAt: bog('2026-09-29T08:00:00'), agendadaAt, ahora: agendadaAt });
    expect(plan.find((p) => p.tipo === 't2h')?.sendAt).toEqual(bog('2026-09-28T20:30:00'));
    expect(plan.find((p) => p.tipo === 't10m')?.sendAt).toEqual(bog('2026-09-29T07:50:00'));
  });

  it('si el adelanto cae antes de agendar, el recordatorio se descarta', () => {
    const agendadaAt = bog('2026-09-28T21:00:00');
    const tipos = planear({ startsAt: bog('2026-09-29T08:00:00'), agendadaAt, ahora: agendadaAt }).map((p) => p.tipo);
    expect(tipos).not.toContain('t2h');
    expect(tipos).toContain('t10m');
  });
});

describe('tolerancia: lo vencido no se planea ni se envía', () => {
  it('cita vieja sincronizada 5 min antes de empezar: solo queda el t10m', () => {
    const startsAt = bog('2026-09-30T15:00:00');
    const tipos = planear({ startsAt, agendadaAt: bog('2026-09-27T10:00:00'), ahora: bog('2026-09-30T14:55:00') })
      .map((p) => p.tipo);
    expect(new Set(tipos)).toEqual(new Set(['t10m']));
  });

  it('un t10m después de empezar la llamada ya no sale', () => {
    const startsAt = bog('2026-09-30T15:00:00');
    expect(vigente('t10m', bog('2026-09-30T14:50:00'), startsAt, bog('2026-09-30T14:57:00'))).toBe(true);
    expect(vigente('t10m', bog('2026-09-30T14:50:00'), startsAt, bog('2026-09-30T15:00:30'))).toBe(false);
    // Dentro de la tolerancia pero con la llamada ya empezada: tampoco.
    expect(vigente('t10m', bog('2026-09-30T14:58:00'), startsAt, bog('2026-09-30T15:01:00'))).toBe(false);
  });
});

describe('mensajes', () => {
  const ahora = bog('2026-09-29T15:00:00');

  it('dice hoy, mañana o la fecha según el día en Bogotá', () => {
    expect(cuando(bog('2026-09-29T17:00:00'), ahora)).toMatch(/^hoy a las 5:00/);
    expect(cuando(bog('2026-09-30T15:00:00'), ahora)).toMatch(/^mañana miércoles, 30 de septiembre a las 3:00|^mañana miércoles 30 de septiembre a las 3:00/);
    expect(cuando(bog('2026-10-02T09:30:00'), ahora)).toMatch(/^el viernes,? 2 de octubre a las 9:30/);
  });

  it('las 23:30 Bogotá son "hoy" aunque en UTC ya sea mañana', () => {
    expect(cuando(bog('2026-09-29T23:30:00'), ahora)).toMatch(/^hoy/);
  });

  it('el texto libre no deja marcadores sin rellenar, ni rayas largas', () => {
    const d = { nombre: 'JUAN alberto', startsAt: bog('2026-09-30T15:00:00'), meetUrl: 'https://meet.google.com/abc' };
    for (const tipo of ['confirmacion', 't24h', 't2h', 't10m'] as const) {
      const t = textoLibre(tipo, d, ahora);
      expect(t).not.toMatch(/\{\{/);
      expect(t).toContain('Hola Juan,');
      expect(t).toContain('https://meet.google.com/abc');
      expect(CUERPOS[tipo]).not.toContain('—');
      expect(CUERPOS[tipo].trim()).not.toMatch(/\}\}$/);
    }
  });

  it('cada plantilla recibe tantos parámetros como marcadores tiene su cuerpo', () => {
    const d = { nombre: 'Ana', startsAt: bog('2026-09-30T15:00:00'), meetUrl: null };
    for (const tipo of ['confirmacion', 't24h', 't2h', 't10m'] as const) {
      const marcadores = new Set(CUERPOS[tipo].match(/\{\{\d+\}\}/g)).size;
      expect(parametros(tipo, d, ahora)).toHaveLength(marcadores);
    }
  });

  it('el correo escapa el nombre', () => {
    const c = correo('t24h', { nombre: '<b>x', startsAt: bog('2026-09-30T15:00:00'), meetUrl: null }, ahora);
    expect(c.html).not.toContain('<b>x');
  });
});

describe('ejecutar: la decisión de envío de una fila', () => {
  const base: Fila = {
    id: 1, booking_id: 'b1', tipo: 't24h', canal: 'whatsapp',
    send_at: bog('2026-09-29T15:00:00'), starts_at: bog('2026-09-30T15:00:00'),
    dest_email: 'juanalbertoortega456@gmail.com', dest_phone: '573216119791', dest_bsuid: null,
    nombre: 'Juan', meet_url: 'https://meet.google.com/abc', es_prueba: false, intentos: 0,
  };
  const ahora = bog('2026-09-29T15:00:01');
  let envios: { whatsappTexto: any; whatsappPlantilla: any; email: any };

  beforeEach(() => {
    envios = {
      whatsappTexto: vi.fn(async () => ({ ok: true, messageId: 'wamid.t' })),
      whatsappPlantilla: vi.fn(async () => ({ ok: true, messageId: 'wamid.p' })),
      email: vi.fn(async () => ({ ok: true, id: 're_1' })),
    };
    process.env.RECORDATORIOS_SOLO = 'juanalbertoortega456@gmail.com,+57 321 6119791';
    delete process.env.RECORDATORIOS_PLANTILLAS_OK;
  });
  afterEach(() => {
    delete process.env.RECORDATORIOS_SOLO;
    delete process.env.RECORDATORIOS_PLANTILLAS_OK;
  });

  const nadaEnviado = () => {
    expect(envios.whatsappTexto).not.toHaveBeenCalled();
    expect(envios.whatsappPlantilla).not.toHaveBeenCalled();
    expect(envios.email).not.toHaveBeenCalled();
  };

  it('modo apagado no envía nada', async () => {
    expect(await ejecutar(base, ahora, envios, 'apagado')).toEqual({ estado: 'saltado', motivo: 'modo_apagado' });
    nadaEnviado();
  });

  it('modo prueba bloquea un destino fuera de la lista', async () => {
    const r = await ejecutar({ ...base, dest_phone: '573001112233' }, ahora, envios, 'prueba');
    expect(r).toEqual({ estado: 'saltado', motivo: 'fuera_de_lista_prueba' });
    nadaEnviado();
  });

  it('modo prueba deja pasar el teléfono de la lista aunque venga con otro formato', async () => {
    const r = await ejecutar(base, ahora, envios, 'prueba');
    expect(r.estado).toBe('enviado');
    expect(envios.whatsappTexto).toHaveBeenCalledOnce();
  });

  it('sin plantilla aprobada sale por texto libre', async () => {
    const r = await ejecutar(base, ahora, envios, 'vivo');
    expect(r).toMatchObject({ estado: 'enviado', via: 'texto' });
    expect(envios.whatsappPlantilla).not.toHaveBeenCalled();
    expect(envios.whatsappTexto.mock.calls[0][0]).toEqual({ waBsuid: null, phone: '573216119791' });
  });

  it('con plantilla aprobada sale por plantilla, con los parámetros en orden', async () => {
    process.env.RECORDATORIOS_PLANTILLAS_OK = 'recordatorio_llamada_24h_v2';
    const r = await ejecutar(base, ahora, envios, 'vivo');
    expect(r).toMatchObject({ estado: 'enviado', via: 'plantilla:recordatorio_llamada_24h_v2' });
    const [, nombre, params] = envios.whatsappPlantilla.mock.calls[0];
    expect(nombre).toBe('recordatorio_llamada_24h_v2');
    expect(params[0]).toBe('Juan');
    expect(params[1]).toMatch(/^mañana/);
    expect(params[2]).toBe('https://meet.google.com/abc');
  });

  it('el canal email usa el correo, no WhatsApp', async () => {
    const r = await ejecutar({ ...base, canal: 'email' }, ahora, envios, 'vivo');
    expect(r).toMatchObject({ estado: 'enviado', via: 'resend', externalId: 're_1' });
    expect(envios.email.mock.calls[0][0]).toBe('juanalbertoortega456@gmail.com');
    expect(envios.whatsappTexto).not.toHaveBeenCalled();
  });

  it('una fila vencida no sale', async () => {
    const r = await ejecutar(base, bog('2026-09-29T18:30:00'), envios, 'vivo');
    expect(r).toEqual({ estado: 'saltado', motivo: 'vencido' });
    nadaEnviado();
  });

  it('sin destino de WhatsApp se salta, sin llamar a Kapso', async () => {
    const r = await ejecutar({ ...base, dest_phone: null }, ahora, envios, 'vivo');
    expect(r).toEqual({ estado: 'saltado', motivo: 'sin_whatsapp' });
    nadaEnviado();
  });

  it('fuera de la ventana de 24 h el texto libre se salta sin reintento', async () => {
    envios.whatsappTexto = vi.fn(async () => ({ ok: false, error: '422: Cannot send non-template messages outside the 24-hour window.' }));
    expect(await ejecutar(base, ahora, envios, 'vivo')).toEqual({ estado: 'saltado', motivo: 'fuera_de_ventana_sin_plantilla' });
  });

  it('un fallo del proveedor se reporta como error (para reintentar), no como enviado', async () => {
    envios.whatsappTexto = vi.fn(async () => ({ ok: false, error: 'Kapso respondió 500' }));
    expect(await ejecutar(base, ahora, envios, 'vivo')).toEqual({ estado: 'error', motivo: 'Kapso respondió 500' });
  });
});

describe('asistencia_host: la pregunta a Erika', () => {
  const agendadaAt = bog('2026-09-28T10:00:00');
  const startsAt = bog('2026-09-28T18:00:00');

  it('sale 20 min después de la llamada, por correo, solo si se pide', () => {
    const con = planear({ startsAt, agendadaAt, ahora: agendadaAt, conAsistencia: true });
    expect(con.filter((p) => p.tipo === 'asistencia_host')).toEqual([
      { tipo: 'asistencia_host', canal: 'email', sendAt: bog('2026-09-28T18:20:00') },
    ]);
    const sin = planear({ startsAt, agendadaAt, ahora: agendadaAt });
    expect(sin.some((p) => p.tipo === 'asistencia_host')).toBe(false);
  });

  it('sigue vigente horas después de la llamada; un t2h no', () => {
    expect(vigente('asistencia_host', bog('2026-09-28T18:20:00'), startsAt, bog('2026-09-28T23:00:00'))).toBe(true);
    expect(vigente('asistencia_host', bog('2026-09-28T18:20:00'), startsAt, bog('2026-09-29T07:00:00'))).toBe(false);
  });

  it('la firma cambia con la respuesta y con la cita', () => {
    const a = firmaAsistencia('123', '1', 'k');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(firmaAsistencia('123', '0', 'k')).not.toBe(a);
    expect(firmaAsistencia('124', '1', 'k')).not.toBe(a);
    expect(firmaAsistencia('123', '1', 'otra')).not.toBe(a);
  });

  it('el correo trae un link Sí y un link No, cada uno con su firma', () => {
    const c = correoAsistencia({ bookingId: '123', nombre: 'Laura', startsAt, leadPhone: '573001112233' }, 'https://visagente.com', 'k');
    expect(c.texto).toContain(`b=123&v=1&s=${firmaAsistencia('123', '1', 'k')}`);
    expect(c.texto).toContain(`b=123&v=0&s=${firmaAsistencia('123', '0', 'k')}`);
    expect(c.asunto).toContain('Laura');
  });
});

describe('confirmación por texto libre', () => {
  it('lleva qué gana, preparación y salida, sin rayas largas ni variable al final', () => {
    expect(CONFIRMACION_LIBRE).toContain('Erika revisa tu caso');
    expect(CONFIRMACION_LIBRE).toContain('DS-160');
    expect(CONFIRMACION_LIBRE).toContain('respóndeme aquí');
    expect(CONFIRMACION_LIBRE).not.toContain('—');
    // La duración vive en Cal.com (hoy 20 min). Un número aquí se desactualiza en silencio.
    for (const t of [CONFIRMACION_LIBRE, ...Object.values(CUERPOS)]) expect(t).not.toMatch(/\d+ minutos por|En \d+ minutos/);
    const d = { nombre: 'Ana', startsAt: bog('2026-09-30T15:00:00'), meetUrl: 'https://meet.google.com/x' };
    expect(textoLibre('confirmacion', d, bog('2026-09-29T15:00:00'))).toContain('Erika revisa tu caso');
    expect(textoLibre('t24h', d, bog('2026-09-29T15:00:00'))).not.toContain('Erika revisa tu caso');
  });
});

describe('ejecutar: asistencia y orden texto/plantilla', () => {
  const base: Fila = {
    id: 2, booking_id: 'b2', tipo: 'confirmacion', canal: 'whatsapp',
    send_at: bog('2026-09-29T15:00:00'), starts_at: bog('2026-09-30T15:00:00'),
    dest_email: 'erika@visagente.com', dest_phone: '573216119791', dest_bsuid: null,
    nombre: 'Juan', meet_url: 'https://meet.google.com/abc', es_prueba: false, intentos: 0,
  };
  const ahora = bog('2026-09-29T15:00:01');
  const VENTANA = '422: Cannot send non-template messages outside the 24-hour window.';
  let envios: { whatsappTexto: any; whatsappPlantilla: any; email: any };

  beforeEach(() => {
    envios = {
      whatsappTexto: vi.fn(async () => ({ ok: true, messageId: 'wamid.t' })),
      whatsappPlantilla: vi.fn(async () => ({ ok: true, messageId: 'wamid.p' })),
      email: vi.fn(async () => ({ ok: true, id: 're_2' })),
    };
    process.env.RECORDATORIOS_PLANTILLAS_OK = 'recordatorio_llamada_confirmacion,recordatorio_llamada_24h_v2';
  });
  afterEach(() => {
    for (const k of ['RECORDATORIOS_PLANTILLAS_OK', 'RECORDATORIOS_HOST_EMAIL', 'ASISTENCIA_BASE_URL', 'ASISTENCIA_SECRET']) delete process.env[k];
  });

  it('la confirmación va primero por texto libre aunque haya plantilla aprobada', async () => {
    const r = await ejecutar(base, ahora, envios, 'vivo');
    expect(r).toMatchObject({ estado: 'enviado', via: 'texto' });
    expect(envios.whatsappPlantilla).not.toHaveBeenCalled();
  });

  it('si la ventana está cerrada, la confirmación cae a la plantilla', async () => {
    envios.whatsappTexto = vi.fn(async () => ({ ok: false, error: VENTANA }));
    const r = await ejecutar(base, ahora, envios, 'vivo');
    expect(r).toMatchObject({ estado: 'enviado', via: 'plantilla:recordatorio_llamada_confirmacion' });
  });

  it('el t24h con plantilla aprobada va directo por plantilla', async () => {
    const r = await ejecutar({ ...base, tipo: 't24h' }, ahora, envios, 'vivo');
    expect(r).toMatchObject({ via: 'plantilla:recordatorio_llamada_24h_v2' });
    expect(envios.whatsappTexto).not.toHaveBeenCalled();
  });

  it('asistencia_host sin configuración no envía', async () => {
    const r = await ejecutar({ ...base, tipo: 'asistencia_host', canal: 'email', send_at: bog('2026-09-30T15:20:00') },
      bog('2026-09-30T15:20:01'), envios, 'vivo');
    expect(r).toEqual({ estado: 'saltado', motivo: 'asistencia_sin_config' });
    expect(envios.email).not.toHaveBeenCalled();
  });

  it('asistencia_host con configuración manda a Erika el correo con los links firmados', async () => {
    process.env.RECORDATORIOS_HOST_EMAIL = 'erika@visagente.com';
    process.env.ASISTENCIA_BASE_URL = 'https://visagente.com';
    process.env.ASISTENCIA_SECRET = 'k';
    const r = await ejecutar({ ...base, tipo: 'asistencia_host', canal: 'email', send_at: bog('2026-09-30T15:20:00') },
      bog('2026-09-30T15:20:01'), envios, 'vivo');
    expect(r).toMatchObject({ estado: 'enviado', via: 'resend' });
    const [to, asunto, , texto] = envios.email.mock.calls[0];
    expect(to).toBe('erika@visagente.com');
    expect(asunto).toContain('¿Se conectó Juan?');
    expect(texto).toContain(`s=${firmaAsistencia('b2', '1', 'k')}`);
  });
});

describe('leerEntrega: el estado real del WhatsApp', () => {
  it('lee el último estado de kapso.status, con o sin envoltura data', () => {
    expect(leerEntrega({ data: { kapso: { status: 'delivered', statuses: [] } } })).toEqual({ estado: 'delivered', error: null });
    expect(leerEntrega({ kapso: { status: 'read' } })).toEqual({ estado: 'read', error: null });
  });

  it('un rebote de Meta trae el código y el motivo', () => {
    const j = { data: { kapso: { status: 'failed', statuses: [
      { status: 'sent' },
      { status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'no WA' } }] },
    ] } } };
    expect(leerEntrega(j)).toEqual({ estado: 'failed', error: '131026: Message undeliverable: no WA' });
  });

  it('una respuesta sin estado no se lee como entregado', () => {
    expect(leerEntrega({ data: {} })).toBeNull();
    expect(leerEntrega(null)).toBeNull();
  });
});

describe('event type', () => {
  it('por defecto solo la llamada con Erika (7009432)', () => {
    expect(EVENT_TYPE_ID).toBe('7009432');
  });
});

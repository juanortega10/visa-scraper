/**
 * ¿Puede el sistema leer una imagen ahora mismo?
 *
 * ── Por que existe ──────────────────────────────────────────────────────────
 *
 * El Vercel AI Gateway se quedo sin saldo el 2026-08-17 y devolvio
 * `402 insufficient_funds` durante trece dias. `analyze-payment-image` escribia
 * "no analizable" y seguia. Doce clientes mandaron 19 medios que nadie miro.
 *
 * Al leerlos a mano el 2026-08-31 salieron CINCO comprobantes por $589.800 que
 * figuraban como deuda. Trece dias de plata invisible por una falla que ningun
 * tablero mostraba.
 *
 * Lo que hacia falta era una pregunta que nadie hacia: ¿responde el proveedor?
 * Desde afuera un 402 se ve igual que "la imagen no era un comprobante".
 *
 * ── La regla y su trampa ────────────────────────────────────────────────────
 *
 * La trampa esta en `proveedores: []`. Una lista vacia significa que la ruta no
 * pudo probar NADA, y leerla como "ninguno fallo" reproduce el bug de agosto: el
 * silencio se confunde con la salud. Aqui una lista vacia es CRITICA, igual que
 * una lista donde todos estan caidos.
 *
 * Cero proveedores arriba = toda imagen que llegue en este momento se pierde.
 * Un proveedor arriba alcanza para leer, entonces la cadena aguanta con uno.
 */

export interface ProveedorVision {
  nombre: string;
  ok: boolean;
  /** `responde`, `HTTP 402 insufficient_funds`, `sin AI_GATEWAY_API_KEY`, ... */
  detalle: string;
}

export interface PendientesVision {
  /** Filas `image_reads` con `pending = 1`. */
  total: number;
  /** Las que guardaron `media_url` y por lo tanto se pueden reintentar. */
  conUrl: number;
  /** Antiguedad del pendiente mas viejo, en horas. 0 cuando no hay ninguno. */
  masViejoHoras: number;
}

export interface EstadoVision {
  proveedores: ProveedorVision[];
  pendientes: PendientesVision;
  /**
   * Lecturas de imagen logradas en las ultimas 24 h, por CUALQUIER camino.
   *
   * Desde el 2026-09-01 hay dos: `analyze-payment-image` con el Vercel AI Gateway, y el
   * agente nativo de Kapso con `ask_about_file`, que corre con creditos de Kapso y llama
   * a `registrar-lectura-imagen`. El gateway paso a ser redundante, entonces que este
   * caido ya NO es un incidente por si solo. Lo que importa es si algo se leyo.
   */
  lecturas24h: number;
}

export type SeveridadVision = 'critico' | 'alto' | 'ninguna';

export interface VeredictoVision {
  alerta: boolean;
  severidad: SeveridadVision;
  motivo: string;
  arriba: number;
  caidos: ProveedorVision[];
}

/**
 * Horas que puede esperar un pendiente antes de alertar.
 *
 * El reintento (`recuperar-medios-perdidos.mjs --reintentar`) es manual. Un pendiente
 * de dos horas puede ser una imagen que acaba de llegar mientras el proveedor
 * parpadeaba. Uno de mas de 24 h es plata quieta que nadie fue a buscar.
 */
export const HORAS_PENDIENTE_VIEJO = 24;

export function evaluarVision(e: EstadoVision): VeredictoVision {
  const caidos = e.proveedores.filter((p) => !p.ok);
  const arriba = e.proveedores.length - caidos.length;

  // Un medio viejo sin leer es plata quieta, y no depende de que camino fallo. Es la
  // señal mas fuerte y va primero.
  if (e.pendientes.total > 0 && e.pendientes.masViejoHoras >= HORAS_PENDIENTE_VIEJO) {
    return {
      alerta: true,
      severidad: 'critico',
      motivo: `${e.pendientes.total} medios sin leer, el mas viejo de ${e.pendientes.masViejoHoras} h`,
      arriba,
      caidos,
    };
  }

  // Los proveedores caidos solo son incidente cuando el OTRO camino tampoco leyo nada.
  // El gateway lleva caido desde el 2026-08-17 y el agente nativo cubre la lectura: si
  // esto alertara solo por el gateway, sonaria todos los dias y se dejaria de leer.
  //
  // Lista vacia y lista con todos caidos son el MISMO caso. Separarlos seria dejar pasar
  // el silencio, que es justo la falla de agosto.
  if (arriba === 0 && e.lecturas24h === 0) {
    return {
      alerta: true,
      severidad: 'critico',
      motivo: e.proveedores.length === 0
        ? 'la sonda no pudo probar ningun proveedor y no hubo ninguna lectura en 24 h'
        : `sin proveedores y sin ninguna lectura en 24 h`,
      arriba,
      caidos,
    };
  }

  return { alerta: false, severidad: 'ninguna', motivo: 'lectura de imagenes en pie', arriba, caidos };
}

/**
 * Mensaje para Telegram. Solo se manda cuando `alerta` es true: un vigilante que
 * habla todos los dias deja de leerse.
 */
export function textoVision(v: VeredictoVision, e: EstadoVision): string {
  const arriba = e.proveedores.filter((p) => p.ok).length;
  const titulo = v.severidad === 'critico'
    ? '🔴 *Vision caida: ninguna imagen se puede leer*'
    : '🟠 *Medios sin leer esperando*';

  const lineas = [titulo, v.motivo, ''];
  for (const p of e.proveedores) {
    lineas.push(`${p.ok ? '🟢' : '🔴'} ${p.nombre}  ${p.detalle}`);
  }
  if (e.proveedores.length === 0) lineas.push('(la ruta no devolvio ningun proveedor)');

  lineas.push('');
  lineas.push(
    e.pendientes.total === 0
      ? 'pendientes: ninguno'
      : `pendientes: ${e.pendientes.total} · ${e.pendientes.conUrl} reintentables · el mas viejo ${e.pendientes.masViejoHoras} h`,
  );
  if (e.pendientes.total > e.pendientes.conUrl) {
    lineas.push(`${e.pendientes.total - e.pendientes.conUrl} sin URL: hay que bajarlos a mano de Kapso.`);
  }
  lineas.push(`lecturas en 24 h: ${e.lecturas24h}`);
  if (arriba === 0 && e.lecturas24h > 0) {
    lineas.push('El gateway esta caido y el agente nativo de Kapso si lee (`ask_about_file`).');
  }
  lineas.push('');
  lineas.push('`node scripts/recuperar-medios-perdidos.mjs --reintentar`');
  return lineas.join('\n');
}

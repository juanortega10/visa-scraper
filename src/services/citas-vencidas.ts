/**
 * Detector de bots con la cita en el PASADO.
 *
 * ── Por que existe ──────────────────────────────────────────────────────────
 *
 * Un bot solo puede reagendar a una fecha estrictamente ANTERIOR a la que tiene.
 * Con la cita ya vencida no existe ninguna fecha valida, entonces el bot pollea
 * para siempre sin poder ganar nunca. No falla, no alerta, no aparece en ningun
 * tablero: `bots.status` sigue `active` y `updated_at` sigue fresco.
 *
 * `audit-blind-bots.ts` NO los ve. Ese busca bots que pollean sin VER fechas, y
 * estos si ven fechas, solo que ninguna les sirve. Se corrio el 2026-08-31 con
 * 16 bots vencidos en la flota y devolvio `ninguno`.
 *
 * Esto ya paso: la memoria registra 14 bots asi el 2026-07-06. Se arreglo a mano,
 * nadie puso detector, y el 2026-08-31 eran 16 gastando 23.580 polls reales cada
 * 24 h, el 45,8% de la carga de toda la flota, contra un portal que ese mes cerro
 * la ruta del schedule 75610929 dos veces.
 *
 * ── Que decide ──────────────────────────────────────────────────────────────
 *
 * `evaluarCitaVencida` es pura y recibe `hoy`, para que los tests fijen el reloj.
 * La severidad sale de DOS cosas, no de una: cuantos dias lleva vencida y cuanto
 * esta gastando. Un bot vencido hace 90 dias que pollea 20 veces al dia molesta
 * menos que uno vencido hace 3 dias que pollea 1.400.
 */

/** Umbral de polls en 24 h a partir del cual el desperdicio pesa mas que la antiguedad. */
export const POLLS_RUIDOSO = 300;
/** Dias vencida a partir de los cuales el caso deja de ser reciente. */
export const DIAS_VIEJA = 30;

export type Severidad = 'critico' | 'alto' | 'medio';

export interface EntradaCitaVencida {
  botId: number;
  locale: string;
  status: string;
  /** `current_consular_date` del bot. `null` = sin cita, no aplica. */
  cita: string | null;
  /** Polls REALES en 24 h (`SUM(polls_since_prev)`, no `count(*)`). */
  polls24h: number;
  /** Dueno, para saber a quien avisarle. `null` = cliente directo. */
  agencia: string | null;
}

export interface ResultadoCitaVencida extends EntradaCitaVencida {
  diasVencida: number;
  severidad: Severidad;
  /** Frase corta que explica por que salio, para el correo y para Telegram. */
  motivo: string;
}

/** Dias enteros entre dos fechas `YYYY-MM-DD`, en UTC para no depender del reloj local. */
export function diasEntre(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Evalua un bot. Devuelve `null` cuando NO hay nada que reportar.
 *
 * Solo cuentan los bots que de verdad estan corriendo. Un bot `paused` con la cita
 * vencida es el estado correcto despues de atenderlo, y reportarlo otra vez haria
 * que el correo llegue lleno de ruido y nadie lo lea.
 */
export function evaluarCitaVencida(
  e: EntradaCitaVencida,
  hoy: string,
): ResultadoCitaVencida | null {
  if (e.status !== 'active' && e.status !== 'error') return null;
  if (!e.cita) return null;
  const diasVencida = diasEntre(e.cita, hoy);
  if (diasVencida <= 0) return null;

  // El gasto manda sobre la antiguedad. Un bot que pollea mucho hace dano AHORA:
  // cada peticion inutil acerca al portal a cerrar la ruta de toda la cuenta.
  const severidad: Severidad = e.polls24h >= POLLS_RUIDOSO
    ? 'critico'
    : diasVencida >= DIAS_VIEJA ? 'alto' : 'medio';

  const motivo = e.polls24h >= POLLS_RUIDOSO
    ? `${e.polls24h.toLocaleString('es-CO')} polls en 24 h sin poder ganar`
    : `vencida hace ${diasVencida} d`;

  return { ...e, diasVencida, severidad, motivo };
}

/** Ordena lo que hay que atender primero: primero el gasto, despues la antiguedad. */
export function ordenarHallazgos(filas: ResultadoCitaVencida[]): ResultadoCitaVencida[] {
  const peso: Record<Severidad, number> = { critico: 0, alto: 1, medio: 2 };
  return [...filas].sort((a, b) =>
    peso[a.severidad] - peso[b.severidad] ||
    b.polls24h - a.polls24h ||
    b.diasVencida - a.diasVencida);
}

export interface ResumenCitasVencidas {
  total: number;
  criticos: number;
  pollsDesperdiciados: number;
  /** Porcentaje de la carga de la flota que se va en bots que no pueden ganar. */
  porcentajeDeFlota: number;
}

export function resumir(filas: ResultadoCitaVencida[], pollsFlota24h: number): ResumenCitasVencidas {
  const pollsDesperdiciados = filas.reduce((a, f) => a + f.polls24h, 0);
  return {
    total: filas.length,
    criticos: filas.filter((f) => f.severidad === 'critico').length,
    pollsDesperdiciados,
    porcentajeDeFlota: pollsFlota24h > 0
      ? Math.round((1000 * pollsDesperdiciados) / pollsFlota24h) / 10
      : 0,
  };
}

/**
 * Texto para Telegram. Va aparte del HTML del correo a proposito: Telegram se lee en
 * el telefono y tiene que caber en una notificacion, entonces solo lleva los criticos
 * y el total. El detalle completo queda en el correo.
 */
export function textoTelegram(
  filas: ResultadoCitaVencida[],
  resumen: ResumenCitasVencidas,
): string {
  if (filas.length === 0) return '';
  const orden = ordenarHallazgos(filas);
  const lineas = orden.slice(0, 8).map((f) => {
    const marca = f.severidad === 'critico' ? '🔴' : f.severidad === 'alto' ? '🟠' : '🟡';
    const dueno = f.agencia ? ` · ${f.agencia}` : '';
    return `${marca} bot ${f.botId} · ${f.cita} · ${f.motivo}${dueno}`;
  });
  const cola = orden.length > 8 ? `\n... y ${orden.length - 8} mas` : '';
  return [
    `*${resumen.total} bots con la cita vencida*`,
    `${resumen.criticos} criticos · ${resumen.pollsDesperdiciados.toLocaleString('es-CO')} polls en 24 h (${resumen.porcentajeDeFlota}% de la flota)`,
    '',
    ...lineas,
  ].join('\n') + cola + '\n\nUn bot con la cita en el pasado no puede reagendar: solo gasta peticiones.';
}

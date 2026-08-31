/**
 * Nucleo puro del sniper de Peru (bot 299 de Luiggi).
 *
 * Sin red, sin base de datos, sin reloj propio. Todo lo que decide si un disparo
 * es seguro vive aqui, entonces se puede probar con vitest. El script
 * `scripts/peru-sniper-299.ts` hace la red, la base de datos y los logs.
 *
 * Diferencias contra `dual-sniper-core.ts`:
 *  - un solo grupo, no dos, entonces no hay emparejamiento de horas ni gap.
 *  - Peru no usa CAS. `asc_facility_id` del bot 299 esta vacio.
 *  - el cupo tiene DOS topes: el nuestro (`max_reschedules`) y el del portal
 *    (`portal_remaining_reschedules`). Manda el mas estricto.
 *
 * Regla critica que este modulo protege (CLAUDE.md): nunca mover una cita a una
 * fecha igual o posterior a la actual. En Peru el bloqueo es irreversible, entonces
 * aqui NO hay excepciones de tipo sniper.
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^\d{2}:\d{2}$/;

export interface SniperPeruConfig {
  /** Cita consular de hoy, leida del portal. Nunca de la base de datos sola. */
  citaActual: string | null;
  /** `target_date_before`. La fecha nueva debe ser ESTRICTAMENTE anterior. */
  metaAntesDe: string | null;
  /** Dias minimos entre hoy y la cita nueva. 1 = manana en adelante. */
  minDiasDesdeHoy: number;
  /** Nuestro presupuesto. null = sin tope nuestro. */
  nuestroMax: number | null;
  nuestroCount: number;
  /** Saldo que reporta el portal. null = desconocido. */
  portalRestante: number | null;
  /** true si la cuenta pide CAS. Este sniper NO maneja CAS y aborta si es true. */
  usaCas: boolean;
}

export interface Cupo {
  /** Disparos que quedan. 0 = no se puede postear. */
  quedan: number;
  /** Quien pone el techo. */
  topeDe: 'nuestro' | 'portal' | 'sin_tope';
}

/**
 * Cupo efectivo. Manda el numero mas estricto entre el nuestro y el del portal.
 *
 * Ejemplo del bot 299 al 2026-08-28: nuestro 1-0 = 1, portal 2. Quedan 1, tope
 * nuestro. Juan dejo 1 a proposito, aunque el portal permita 2.
 */
export function cupoEfectivo(cfg: SniperPeruConfig): Cupo {
  const nuestro = cfg.nuestroMax == null ? null : Math.max(0, cfg.nuestroMax - cfg.nuestroCount);
  const portal = cfg.portalRestante == null ? null : Math.max(0, cfg.portalRestante);
  if (nuestro == null && portal == null) return { quedan: Number.POSITIVE_INFINITY, topeDe: 'sin_tope' };
  if (nuestro == null) return { quedan: portal!, topeDe: 'portal' };
  if (portal == null) return { quedan: nuestro, topeDe: 'nuestro' };
  return nuestro <= portal
    ? { quedan: nuestro, topeDe: 'nuestro' }
    : { quedan: portal, topeDe: 'portal' };
}

/** Suma dias a una fecha YYYY-MM-DD en UTC. */
export function sumarDias(ymd: string, dias: number): string {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  return new Date(t + dias * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Elige la fecha util mas temprana de `days.json`.
 *
 * Solo mira lo que hace util a una fecha: anterior a la cita actual, anterior a la
 * meta, y suficientemente lejos de hoy. La verificacion dura vuelve a correr en
 * `verificarDisparo`, a proposito: esta funcion ordena, la otra autoriza.
 */
export function elegirFecha(
  dias: Array<{ date: string }>,
  cfg: SniperPeruConfig,
  hoy: string,
): string | null {
  const piso = sumarDias(hoy, Math.max(0, cfg.minDiasDesdeHoy));
  const utiles = dias
    .map((d) => d.date)
    .filter((d) => YMD.test(d))
    .filter((d) => d >= piso)
    .filter((d) => (cfg.citaActual ? d < cfg.citaActual : true))
    .filter((d) => (cfg.metaAntesDe ? d < cfg.metaAntesDe : true))
    .sort();
  return utiles[0] ?? null;
}

/**
 * Verificadores V1 a V7. Devuelve la lista de fallos. Vacia = seguro para postear.
 * Cualquier fallo cancela el disparo. No hay modo de fuerza.
 */
export function verificarDisparo(
  fecha: string,
  hora: string,
  cfg: SniperPeruConfig,
  hoy: string,
): string[] {
  const fallos: string[] = [];

  // V1 · formato
  if (!YMD.test(fecha)) fallos.push(`V1 fecha con formato invalido: ${fecha}`);
  if (!HHMM.test(hora)) fallos.push(`V1 hora con formato invalido: ${hora}`);

  // V2 · REGLA CRITICA: estrictamente anterior a la cita actual.
  if (!cfg.citaActual) {
    fallos.push('V2 sin cita actual leida del portal');
  } else if (!(fecha < cfg.citaActual)) {
    fallos.push(`V2 ${fecha} no es anterior a la cita actual ${cfg.citaActual}`);
  }

  // V3 · dentro de la meta del dueno
  if (cfg.metaAntesDe && !(fecha < cfg.metaAntesDe)) {
    fallos.push(`V3 ${fecha} no es anterior a la meta ${cfg.metaAntesDe}`);
  }

  // V4 · futura, con el piso de dias
  const piso = sumarDias(hoy, Math.max(0, cfg.minDiasDesdeHoy));
  if (YMD.test(fecha) && fecha < piso) {
    fallos.push(`V4 ${fecha} es anterior al piso ${piso} (hoy ${hoy}, min ${cfg.minDiasDesdeHoy} dias)`);
  }

  // V5 · cupo
  const cupo = cupoEfectivo(cfg);
  if (cupo.quedan <= 0) {
    fallos.push(`V5 sin cupo: nuestro ${cfg.nuestroCount}/${cfg.nuestroMax}, portal ${cfg.portalRestante}`);
  }

  // V6 · este sniper no maneja CAS
  if (cfg.usaCas) fallos.push('V6 la cuenta pide CAS y este sniper no la maneja');

  // V7 · coherencia de los contadores
  if (cfg.nuestroMax != null && cfg.nuestroCount > cfg.nuestroMax) {
    fallos.push(`V7 contador incoherente: ${cfg.nuestroCount} > ${cfg.nuestroMax}`);
  }
  if (cfg.portalRestante != null && cfg.portalRestante < 0) {
    fallos.push(`V7 saldo del portal negativo: ${cfg.portalRestante}`);
  }

  return fallos;
}

// ── Token precalentado ───────────────────────────────────────────────────────

export interface EstadoToken {
  /** Momento en que el portal emitio el `authenticity_token`. */
  emitidoMs: number;
  /**
   * Identidad de la SESION que lo emitio, no la cookie.
   *
   * El `authenticity_token` esta atado a la sesion de Rails. Un login nuevo la
   * cambia y mata el token viejo. La cookie `_yatri_session` NO sirve como clave:
   * el portal la rota en cada respuesta y la original sigue valida (CLAUDE.md).
   * Medido el 2026-08-28: atarlo a la cookie daba el token por vencido cada 45 s
   * y forzaba un refresco por vuelta, justo lo que el precalentamiento evita.
   */
  sesionId: string;
  token: string;
}

export interface PoliticaToken {
  /** Cada cuanto se refresca por rutina. */
  cadenciaMs: number;
  /** Edad maxima aceptada en el momento del disparo. Techo duro. */
  techoMs: number;
}

/**
 * Cadencia 30 min, techo 45 min. Subida de 10 a 30 el 2026-08-31.
 *
 * Por que. `refreshTokens()` es el UNICO consumidor de rutina de
 * `/schedule/{id}/appointment`, y esa ruta es exactamente la que el portal cerro
 * primero en el bot 299: el 2026-08-27 cayo solo el HTML, `days.json` seguia vivo.
 * El bot 7 pollea al mismo ritmo que el 299 (unos 4.000 al dia) y nunca se bloqueo;
 * la diferencia es que el bot 7 casi no lee esa pagina.
 *
 * A 10 min eran 144 lecturas al dia. A 30 min son 48, o sea 67% menos.
 *
 * El techo de 45 min no se toca: manda sobre la cadencia y protege el disparo. Entre
 * 30 y 45 quedan 15 min de margen para que un refresco fallido se reintente antes de
 * que el token deje de servir.
 */
export const POLITICA_TOKEN: PoliticaToken = {
  cadenciaMs: 30 * 60_000,
  techoMs: 45 * 60_000,
};

export type VeredictoToken = 'ok' | 'refrescar' | 'vencido';

/**
 * Estado del token guardado.
 *
 *   `vencido`   paso el techo, o la cookie cambio. NO se puede postear con el.
 *   `refrescar` paso la cadencia. Sirve todavia, y conviene renovarlo ya.
 *   `ok`        nuevo.
 *
 * La sesion entra en la cuenta porque el token esta atado a ella: un re-login
 * emite una sesion nueva, y ahi el token viejo deja de valer aunque sea reciente.
 */
export function veredictoToken(
  estado: EstadoToken | null,
  sesionActual: string,
  ahoraMs: number,
  pol: PoliticaToken = POLITICA_TOKEN,
): VeredictoToken {
  if (!estado || !estado.token) return 'vencido';
  if (estado.sesionId !== sesionActual) return 'vencido';
  const edad = ahoraMs - estado.emitidoMs;
  if (edad < 0) return 'vencido';
  if (edad >= pol.techoMs) return 'vencido';
  if (edad >= pol.cadenciaMs) return 'refrescar';
  return 'ok';
}

// ── Cadencia degradada ───────────────────────────────────────────────────────

/**
 * Minutos minimos entre disparos segun la racha de errores seguidos.
 *
 * NUNCA pausa. Devuelve un espaciado, no un sueno: el proceso sigue despertando en los
 * segundos 14 y 18 de cada minuto, y solo se saltea disparos. La fase contra la ventana
 * de liberacion se conserva intacta, que es lo que no se puede perder.
 *
 * Por que existe. El 2026-08-31 el sniper acumulo 41 errores seguidos con TODAS las IPs
 * de webshare rebotando `embassy_block` en la ruta del schedule 75610929. Sin pausa
 * reintentaba 4 IPs por vuelta contra una ruta cerrada, y cada fallo penaliza esa IP en
 * el circuit breaker. Esa presion alarga el bloqueo en vez de dejarlo expirar.
 *
 * La curva sube despacio y tiene techo: con 30 errores o mas queda 1 disparo cada 10
 * minutos, que sigue siendo 6 por hora dentro de la ventana. Al primer poll sano vuelve
 * a 0 y recupera los 2 disparos por minuto en el acto.
 */
export function minutosEntreDisparos(erroresSeguidos: number): number {
  if (erroresSeguidos <= 0) return 0;
  if (erroresSeguidos < 5) return 1;
  if (erroresSeguidos < 15) return 2;
  if (erroresSeguidos < 30) return 5;
  return 10;
}

/**
 * True si toca disparar en este tick.
 *
 * `ultimoDisparoMs` es cuando salio el ultimo intento real. Con la racha en cero
 * siempre devuelve true, entonces la cadencia normal no cambia en nada.
 */
export function tocaDisparar(erroresSeguidos: number, ultimoDisparoMs: number, ahoraMs: number): boolean {
  const min = minutosEntreDisparos(erroresSeguidos);
  if (min === 0) return true;
  return ahoraMs - ultimoDisparoMs >= min * 60_000;
}

// ── Fase del minuto ──────────────────────────────────────────────────────────

/** Ventana medida para es-pe con `scripts/analyze-release-clock.ts` el 2026-08-27. */
export const VENTANA_PE = { inicioSeg: 15, finSeg: 25 } as const;

/**
 * Milisegundos hasta el proximo segundo `objetivo` del minuto UTC.
 * Nunca devuelve 0: si ya estamos en ese segundo exacto, espera al minuto siguiente.
 */
export function msHastaSegundo(ahoraMs: number, objetivoSeg: number): number {
  const dentroDelMinuto = ahoraMs % 60_000;
  const objetivoMs = objetivoSeg * 1000;
  const falta = objetivoMs - dentroDelMinuto;
  return falta > 0 ? falta : falta + 60_000;
}

/**
 * Milisegundos hasta el proximo disparo, con varios segundos objetivo por minuto.
 * Dos disparos por minuto abrazan el borde de liberacion: uno cae justo antes y
 * otro justo despues, entonces un cupo liberado en el borde no espera un minuto
 * entero. Devuelve siempre un valor mayor que 0.
 */
export function msHastaProximoTick(ahoraMs: number, segundos: readonly number[]): number {
  if (segundos.length === 0) return 60_000;
  return Math.min(...segundos.map((s) => msHastaSegundo(ahoraMs, s)));
}

/** True si ese instante cae dentro de la ventana de liberacion de es-pe. */
export function enVentana(ahoraMs: number, v = VENTANA_PE): boolean {
  const seg = Math.floor((ahoraMs % 60_000) / 1000);
  return seg >= v.inicioSeg && seg < v.finSeg;
}

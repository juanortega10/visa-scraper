/**
 * Nucleo puro del dual sniper: emparejar horas de 2 grupos y verificar el candidato.
 *
 * Sin I/O. Todo lo que decide si un movimiento es seguro vive aqui, para poder
 * probarlo con vitest. El script `scripts/dual-sniper-victoria.ts` solo hace red,
 * base de datos y logs.
 *
 * Regla que este modulo protege (CLAUDE.md): nunca mover una cita a una fecha
 * igual o posterior a la actual. La unica excepcion es un grupo que YA esta dentro
 * de la ventana, donde el movimiento sirve para alinear la hora con el otro grupo.
 */

export type Phase = 'PAIR' | 'PARENT_ONLY' | 'CHILD_ONLY' | 'DONE';

export interface SniperConfig {
  /** Ventana de ACEPTACION. Fuera de ella no se agenda nada. */
  windowStart: string;      // YYYY-MM-DD inclusive
  windowEnd: string;        // YYYY-MM-DD inclusive
  /**
   * Sub-rango PREFERIDO dentro de la ventana. Un par aqui gana sobre cualquier otro,
   * aunque el otro tenga mejor gap. Dejar en null para tratar toda la ventana igual.
   */
  preferStart?: string | null;
  preferEnd?: string | null;
  gapMaxMin: number;        // techo entre las 2 consulares cuando se mueven LOS DOS grupos
  /**
   * Techo del gap en modo RESCATE, cuando un grupo YA quedo movido y el otro no.
   * Ahi lo que importa es que la familia quede el MISMO dia. Un gap de 3 horas es
   * peor que 15 minutos, y es mucho mejor que quedar en dias distintos.
   */
  rescueGapMaxMin: number;
  gapIdealMin: number;      // meta blanda
  casInWindowRequired: boolean;
}

export interface GroupState {
  role: 'PARENTS' | 'CHILDREN';
  consularDate: string | null;
  consularTime: string | null;
  maxReschedules: number | null;
  rescheduleCount: number;
}

export interface CasPick {
  date: string;
  time: string;
  inWindow: boolean;
}

export interface Candidate {
  date: string;
  parentsTime: string;
  childrenTime: string;
  gapMin: number;
  parentsCas: CasPick | null;
  childrenCas: CasPick | null;
}

const HHMM = /^(\d{2}):(\d{2})$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** "09:45" → 585. Lanza si el formato no es HH:MM. */
export function toMin(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error(`hora invalida: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`hora fuera de rango: ${hhmm}`);
  return h * 60 + min;
}

export function inWindow(date: string | null | undefined, cfg: SniperConfig): boolean {
  return !!date && YMD.test(date) && date >= cfg.windowStart && date <= cfg.windowEnd;
}

/**
 * Todos los pares (hora padres, hora ninos) validos de un mismo dia.
 * La cita de los PADRES debe ocurrir ANTES o AL MISMO TIEMPO que la de los ninos.
 * Gap dentro de [0, gapMaxMin]. Gap 0 = la misma hora exacta, el caso ideal.
 */
export function buildPairs(
  date: string,
  parentTimes: string[],
  childTimes: string[],
  cfg: SniperConfig,
): Array<{ p: string; c: string; gapMin: number }> {
  const out: Array<{ p: string; c: string; gapMin: number }> = [];
  for (const p of parentTimes) {
    for (const c of childTimes) {
      const gapMin = toMin(c) - toMin(p);
      if (gapMin < 0 || gapMin > cfg.gapMaxMin) continue;
      out.push({ p, c, gapMin });
    }
  }
  return out;
}

/** True si la fecha cae en el sub-rango preferido. Sin sub-rango configurado, siempre false. */
export function inPreferred(date: string | null | undefined, cfg: SniperConfig): boolean {
  if (!cfg.preferStart || !cfg.preferEnd) return false;
  return !!date && YMD.test(date) && date >= cfg.preferStart && date <= cfg.preferEnd;
}

/**
 * Orden de los candidatos.
 * 1) el sub-rango preferido gana sobre el resto de la ventana,
 * 2) menor gap, 3) fecha mas temprana, 4) hora mas temprana.
 *
 * La prioridad del sub-rango va PRIMERO a proposito: el dueno pidio ese tramo, entonces
 * un par ahi con gap de 45 min vale mas que uno fuera con gap 0.
 */
export function rankCandidates(list: Candidate[], cfg?: SniperConfig): Candidate[] {
  return [...list].sort((a, b) => {
    if (cfg) {
      const pa = inPreferred(a.date, cfg) ? 0 : 1;
      const pb = inPreferred(b.date, cfg) ? 0 : 1;
      if (pa !== pb) return pa - pb;
    }
    return a.gapMin - b.gapMin
      || a.date.localeCompare(b.date)
      || toMin(a.parentsTime) - toMin(b.parentsTime);
  });
}

/** Estado del objetivo, leido de las citas REALES del portal. */
export function computePhase(parents: GroupState, children: GroupState, cfg: SniperConfig): Phase {
  const pIn = inWindow(parents.consularDate, cfg);
  const cIn = inWindow(children.consularDate, cfg);

  // DONE = mismo dia, padres antes, y gap dentro del techo de rescate. El objetivo
  // primario es que la familia quede junta el mismo dia. Afinar el gap es secundario
  // y solo pasa con --refine, porque re-mover una cita buena arriesga perderla.
  if (pIn && cIn && parents.consularTime && children.consularTime
      && parents.consularDate === children.consularDate) {
    const gap = toMin(children.consularTime) - toMin(parents.consularTime);
    if (gap >= 0 && gap <= cfg.rescueGapMaxMin) return 'DONE';
  }
  if (pIn && !cIn) return 'CHILD_ONLY';
  if (!pIn && cIn) return 'PARENT_ONLY';
  return 'PAIR';
}

/**
 * Config efectiva de la fase. En PAIR se mueven los dos grupos y manda `gapMaxMin`.
 * En CHILD_ONLY / PARENT_ONLY uno ya esta anclado: manda `rescueGapMaxMin`, para no
 * dejar a la familia partida en 2 dias por unos minutos de diferencia.
 */
export function effectiveConfig(cfg: SniperConfig, phase: Phase): SniperConfig {
  if (phase === 'CHILD_ONLY' || phase === 'PARENT_ONLY') {
    return { ...cfg, gapMaxMin: cfg.rescueGapMaxMin };
  }
  return cfg;
}

/** Grupos que se mueven en esta fase. */
export function movingRoles(phase: Phase): Array<'PARENTS' | 'CHILDREN'> {
  if (phase === 'CHILD_ONLY') return ['CHILDREN'];
  if (phase === 'PARENT_ONLY') return ['PARENTS'];
  return ['PARENTS', 'CHILDREN'];
}

/**
 * Gap logrado hoy entre las 2 citas, si estan el mismo dia. null si no aplica.
 * Sirve para saber si vale la pena afinar con --refine.
 */
export function currentGapMin(parents: GroupState, children: GroupState): number | null {
  if (!parents.consularDate || !children.consularDate) return null;
  if (parents.consularDate !== children.consularDate) return null;
  if (!parents.consularTime || !children.consularTime) return null;
  return toMin(children.consularTime) - toMin(parents.consularTime);
}

/**
 * Verificadores V1 a V9. Devuelve la lista de fallos. Vacia = seguro.
 * Cualquier fallo cancela el candidato: no se hace ningun POST.
 * `cfg` debe venir de `effectiveConfig(cfg, phase)`.
 */
export function verifyCandidate(
  c: Candidate,
  parents: GroupState,
  children: GroupState,
  phase: Phase,
  cfg: SniperConfig,
  today: string,
): string[] {
  const fails: string[] = [];
  const moving = movingRoles(phase);
  const byRole: Record<'PARENTS' | 'CHILDREN', GroupState> = { PARENTS: parents, CHILDREN: children };

  // V1 · las 2 consulares dentro de la ventana estricta
  if (!inWindow(c.date, cfg)) fails.push(`V1 fecha ${c.date} fuera de [${cfg.windowStart}, ${cfg.windowEnd}]`);

  // V2 · formato y mismo dia (el modelo tiene una sola fecha, se afirma igual)
  if (!YMD.test(c.date)) fails.push(`V2 fecha con formato invalido: ${c.date}`);
  if (!HHMM.test(c.parentsTime) || !HHMM.test(c.childrenTime))
    fails.push(`V2 horas con formato invalido: ${c.parentsTime} / ${c.childrenTime}`);

  if (HHMM.test(c.parentsTime) && HHMM.test(c.childrenTime)) {
    // V3 · los padres NUNCA despues que los ninos. La misma hora exacta si vale.
    if (toMin(c.parentsTime) > toMin(c.childrenTime))
      fails.push(`V3 padres ${c.parentsTime} es posterior a ninos ${c.childrenTime}`);

    // V4 · gap coherente y dentro del techo
    const realGap = toMin(c.childrenTime) - toMin(c.parentsTime);
    if (realGap !== c.gapMin) fails.push(`V4 gap declarado ${c.gapMin} no coincide con el real ${realGap}`);
    if (realGap < 0 || realGap > cfg.gapMaxMin)
      fails.push(`V4 gap ${realGap}min fuera de [0, ${cfg.gapMaxMin}]`);
  }

  // V5 · REGLA CRITICA: nunca a una fecha igual o posterior a la actual.
  //      Excepcion: el grupo que YA esta dentro de la ventana, donde el movimiento alinea la hora.
  for (const role of moving) {
    const g = byRole[role];
    if (!g.consularDate) { fails.push(`V5 [${role}] sin cita actual leida del portal`); continue; }
    if (inWindow(g.consularDate, cfg)) continue;
    if (c.date >= g.consularDate)
      fails.push(`V5 [${role}] ${c.date} no es anterior a la cita actual ${g.consularDate}`);
  }

  // V6 · la fecha tiene que ser futura
  if (c.date <= today) fails.push(`V6 ${c.date} no es futura (hoy ${today})`);

  // V7 · cupo de reagendamientos del portal
  for (const role of moving) {
    const g = byRole[role];
    if (g.maxReschedules != null && g.rescheduleCount >= g.maxReschedules)
      fails.push(`V7 [${role}] sin cupo: ${g.rescheduleCount}/${g.maxReschedules}`);
  }

  // V8 · la CAS debe existir para cada grupo que se mueve (muro CAS)
  for (const role of moving) {
    const cas = role === 'PARENTS' ? c.parentsCas : c.childrenCas;
    if (!cas) { fails.push(`V8 [${role}] sin CAS disponible (muro CAS)`); continue; }
    if (cfg.casInWindowRequired && !cas.inWindow)
      fails.push(`V8 [${role}] CAS ${cas.date} fuera de la ventana y la ventana de CAS es obligatoria`);
  }

  // V9 · la CAS nunca despues del consular, y nunca en el pasado
  for (const role of moving) {
    const cas = role === 'PARENTS' ? c.parentsCas : c.childrenCas;
    if (!cas) continue;
    if (cas.date > c.date) fails.push(`V9 [${role}] CAS ${cas.date} despues del consular ${c.date}`);
    if (cas.date <= today) fails.push(`V9 [${role}] CAS ${cas.date} no es futura (hoy ${today})`);
  }

  return fails;
}

/**
 * Orden de preferencia de fechas CAS.
 * 1) dentro de la ventana, 2) el mismo dia que la CAS del otro grupo, 3) la mas tardia.
 */
export function rankCasDates(
  dates: string[],
  cfg: SniperConfig,
  preferDate: string | null,
): string[] {
  const unique = [...new Set(dates)].filter((d) => YMD.test(d));
  const inWin = unique.filter((d) => inWindow(d, cfg)).sort();
  const outWin = unique.filter((d) => !inWindow(d, cfg)).sort();
  const order = cfg.casInWindowRequired ? inWin : [...inWin, ...outWin];
  // Dentro de cada bloque, la mas tardia primero (queda mas cerca del consular).
  const ranked = [...inWin].reverse().concat(cfg.casInWindowRequired ? [] : [...outWin].reverse());
  const base = order.length === 0 ? [] : ranked;
  if (preferDate && base.includes(preferDate)) {
    return [preferDate, ...base.filter((d) => d !== preferDate)];
  }
  return base;
}

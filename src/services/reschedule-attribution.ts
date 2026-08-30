/**
 * Reschedule attribution — who actually moved the appointment?
 *
 * Single source of truth for "days advanced" billing. Used by the cobros tab
 * (src/api/logs.ts → /bots/:id/billing), by scripts/audit-reschedule-attribution.ts,
 * and by the tests. Do not re-derive this anywhere else.
 *
 * `reschedule_logs.success = true` does NOT prove the bot moved the appointment.
 * Two ways an owner's manual move ends up flagged as a bot success:
 *
 *   1. [post_error_recovered] mis-attribution. The POST threw a network error, the
 *      safety net re-read /groups, saw a different date and logged success=true —
 *      without checking that the date was the one the bot POSTed. Fixed in
 *      reschedule-logic.ts (attribution guard); historical rows still carry it.
 *      Reported here as `suspect`.
 *
 *   2. Chain breaks. Successful reschedules form a chain: row N's newConsularDate
 *      must equal row N+1's oldConsularDate. A break means the appointment moved
 *      with no bot log at all. Reported here as an `external` move.
 *
 *   3. La cadena no CIERRA contra la realidad. El ultimo `newConsularDate` de la
 *      cadena tiene que ser la cita que el bot tiene hoy. Cuando no lo es, o el
 *      ultimo exito nunca ocurrio, o la cita se movio despues por fuera. Las dos se
 *      ven igual desde los logs, y las dos significan que esos dias NO se ganaron.
 *      Se cierra con un movimiento `external` de tipo `chain_open`, y el techo que ya
 *      existe se encarga del cobro.
 *
 *      Caso real, bot 7 el 2026-04-17: una fila `success=true` decia 2027-07-30 →
 *      2026-04-22 y cobraba 464 dias. La cita nunca se movio de 2027-07-30, en 277
 *      intentos entre 2026-02-24 y 2026-08-25. Sin `citaActual` el auditor no lo veia,
 *      porque con una sola fila de exito no hay cadena que se rompa.
 *
 * Method: replay the rows in time order and account for every day between the first
 * and last known date. Nothing is trusted from the success flag alone.
 */

export type MoveActor = 'bot' | 'external';
export type MoveKind = 'clean' | 'post_error_recovered' | 'chain_break' | 'chain_open';

/** Row shape needed from reschedule_logs. Pass ALL rows for the bot, not just successes —
 *  portal_reversion rows (success=false) are needed to cancel out reverted moves. */
export interface AttributionRow {
  id?: number | null;
  createdAt?: Date | string | null;
  oldConsularDate: string | null;
  newConsularDate: string | null;
  success: boolean | null;
  error?: string | null;
}

export interface AttributedMove {
  /** ISO timestamp of the log row. null for an inferred chain break. */
  at: string | null;
  from: string;
  to: string;
  /** Days advanced. Positive = earlier. Negative = the appointment moved later. */
  days: number;
  actor: MoveActor;
  kind: MoveKind;
  /** Safe to charge: produced by the bot, not suspect, and a real advance. */
  billable: boolean;
  /** Credited to the bot by a path that could not prove authorship. Needs a human. */
  suspect: boolean;
  note: string;
  logId: number | null;
}

export interface AttributionSummary {
  moves: AttributedMove[];
  firstDate: string | null;
  lastDate: string | null;
  /** Sum of days over bot moves. */
  botDays: number;
  /** Sum of days over external moves. Negative when the portal pushed the date later. */
  externalDays: number;
  /** Days credited to the bot that cannot be proven. Subtracted from billableDays. */
  suspectDays: number;
  /** First known date → last known date. Always equals botDays + externalDays. */
  netDays: number;
  /** What can be charged. Never exceeds the net advance minus external gains. */
  billableDays: number;
}

const DAY_MS = 86400000;

/** Whole days between two YYYY-MM-DD dates. Positive when `to` is earlier than `from`. */
export function daysEarlier(from: string, to: string): number {
  return Math.round(
    (new Date(`${from}T00:00:00Z`).getTime() - new Date(`${to}T00:00:00Z`).getTime()) / DAY_MS,
  );
}

function toIso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function errText(r: AttributionRow): string {
  return typeof r.error === 'string' ? r.error : '';
}

export interface AttributionOptions {
  /**
   * Cita consular que el bot tiene HOY, de `bots.current_consular_date`.
   *
   * Cierra la cadena contra la realidad. Sin esto, una fila de exito que nunca
   * ocurrio se cobra completa. Omitir el dato conserva el comportamiento anterior.
   */
  citaActual?: string | null;
}

export function auditReschedules(
  rows: AttributionRow[],
  opts: AttributionOptions = {},
): AttributionSummary {
  const empty: AttributionSummary = {
    moves: [], firstDate: null, lastDate: null,
    botDays: 0, externalDays: 0, suspectDays: 0, netDays: 0, billableDays: 0,
  };

  // Time order. Fall back to id when timestamps tie.
  const sorted = [...rows].sort((a, b) => {
    const ta = new Date(toIso(a.createdAt) ?? 0).getTime();
    const tb = new Date(toIso(b.createdAt) ?? 0).getTime();
    return ta !== tb ? ta - tb : (a.id ?? 0) - (b.id ?? 0);
  });

  // Rows asserting the appointment actually moved.
  const moved = sorted.filter(
    (r) => r.success === true && r.oldConsularDate && r.newConsularDate &&
      r.oldConsularDate !== r.newConsularDate,
  );
  if (moved.length === 0) return empty;

  // A later portal_reversion cancels the success it names.
  const reverted = new Set(
    sorted
      .filter((r) => r.success === false && errText(r).startsWith('portal_reversion'))
      .map((r) => `${r.oldConsularDate}->${r.newConsularDate}`),
  );

  const moves: AttributedMove[] = [];
  let chainDate: string | null = null;

  for (const r of moved) {
    const from = r.oldConsularDate!;
    const to = r.newConsularDate!;
    const err = errText(r);

    // The appointment was somewhere else before this row's `old` → nothing in the
    // bot's logs covers that move.
    if (chainDate && chainDate !== from) {
      moves.push({
        at: toIso(r.createdAt),
        from: chainDate,
        to: from,
        days: daysEarlier(chainDate, from),
        actor: 'external',
        kind: 'chain_break',
        billable: false,
        suspect: false,
        note: 'sin log del bot — la cita cambió por fuera',
        logId: null,
      });
    }

    if (reverted.has(`${to}->${from}`)) {
      chainDate = from; // the portal took it back; not a real move
      continue;
    }

    const recovered = err.startsWith('[post_error_recovered]');
    const days = daysEarlier(from, to);
    moves.push({
      at: toIso(r.createdAt),
      from,
      to,
      days,
      actor: 'bot',
      kind: recovered ? 'post_error_recovered' : 'clean',
      billable: !recovered && days > 0,
      suspect: recovered,
      note: recovered
        ? 'el POST falló y se acreditó al releer — puede ser un movimiento manual del dueño'
        : err,
      logId: r.id ?? null,
    });
    chainDate = to;
  }

  // La cadena tiene que terminar donde el bot esta hoy. Si no, se agrega el tramo que
  // falta como movimiento externo: el techo de mas abajo lo descuenta solo.
  const citaActual = opts.citaActual ?? null;
  if (citaActual && chainDate && chainDate !== citaActual) {
    moves.push({
      at: null,
      from: chainDate,
      to: citaActual,
      days: daysEarlier(chainDate, citaActual),
      actor: 'external',
      kind: 'chain_open',
      billable: false,
      suspect: false,
      note: 'la cadena no cierra contra la cita real del bot — el ultimo exito puede no haber ocurrido, o la cita se movio por fuera despues',
      logId: null,
    });
    chainDate = citaActual;
  }

  const botDays = moves.filter((m) => m.actor === 'bot').reduce((s, m) => s + m.days, 0);
  const externalDays = moves.filter((m) => m.actor === 'external').reduce((s, m) => s + m.days, 0);
  const suspectDays = moves.filter((m) => m.suspect).reduce((s, m) => s + m.days, 0);
  const firstDate = moves[0]?.from ?? null;
  const lastDate = chainDate;
  const netDays = firstDate && lastDate ? daysEarlier(firstDate, lastDate) : 0;

  // Ceiling: the net advance, minus whatever an external move contributed. Without it,
  // revert-and-redo churn double-counts the same days (bot 177: botDays 526, net 181).
  const ceiling = netDays - Math.max(externalDays, 0);
  const billableDays = Math.max(0, Math.min(botDays - suspectDays, ceiling));

  return { moves, firstDate, lastDate, botDays, externalDays, suspectDays, netDays, billableDays };
}

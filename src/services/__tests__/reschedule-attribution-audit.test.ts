import { describe, it, expect } from 'vitest';
import { auditReschedules, daysEarlier, type AttributionRow } from '../reschedule-attribution.js';

let seq = 0;
function row(p: Partial<AttributionRow> & { old: string | null; neu: string | null }): AttributionRow {
  seq += 1;
  return {
    id: seq,
    createdAt: new Date(Date.UTC(2026, 7, 1, 0, seq)), // 1 minute apart, in call order
    oldConsularDate: p.old,
    newConsularDate: p.neu,
    success: p.success ?? true,
    error: p.error ?? '',
  };
}

describe('daysEarlier', () => {
  it('counts whole days, positive when the target is earlier', () => {
    expect(daysEarlier('2027-04-20', '2026-11-24')).toBe(147);
    expect(daysEarlier('2026-10-14', '2026-09-03')).toBe(41);
    expect(daysEarlier('2026-08-21', '2026-08-17')).toBe(4);
  });

  it('is negative when the appointment moved later', () => {
    expect(daysEarlier('2026-06-15', '2026-07-10')).toBe(-25);
  });

  it('is immune to the local timezone (Bogota is UTC-5)', () => {
    // A naive new Date('2026-03-01') - new Date('2026-02-28') in a -05:00 shell
    // still lands on whole days only if both sides are parsed as UTC.
    expect(daysEarlier('2026-03-01', '2026-02-28')).toBe(1);
    expect(daysEarlier('2027-01-01', '2026-12-31')).toBe(1);
  });
});

describe('auditReschedules — invariants', () => {
  it('returns zeros when there are no moves', () => {
    const s = auditReschedules([]);
    expect(s.moves).toHaveLength(0);
    expect(s.billableDays).toBe(0);
    expect(s.netDays).toBe(0);
  });

  it('ignores rows that did not change the date', () => {
    const s = auditReschedules([row({ old: '2026-09-01', neu: '2026-09-01' })]);
    expect(s.moves).toHaveLength(0);
  });

  it('ignores failed rows', () => {
    const s = auditReschedules([
      row({ old: '2026-09-01', neu: '2026-08-01', success: false, error: 'post_returned_false' }),
    ]);
    expect(s.moves).toHaveLength(0);
  });

  // The load-bearing identity: every day between the first and last date is
  // accounted for as either the bot's or someone else's. If this ever breaks,
  // the replay has lost a move.
  it('always satisfies botDays + externalDays === netDays', () => {
    const cases: AttributionRow[][] = [
      [row({ old: '2026-12-01', neu: '2026-10-01' })],
      [row({ old: '2026-12-01', neu: '2026-10-01' }), row({ old: '2026-09-01', neu: '2026-08-01' })],
      [row({ old: '2026-12-01', neu: '2026-10-01' }), row({ old: '2026-11-01', neu: '2026-12-20' })],
      [
        row({ old: '2027-04-20', neu: '2026-11-24', error: '[post_error_recovered] fetch failed' }),
        row({ old: '2026-10-14', neu: '2026-09-03' }),
        row({ old: '2026-09-03', neu: '2026-08-17' }),
      ],
    ];
    for (const rows of cases) {
      const s = auditReschedules(rows);
      expect(s.botDays + s.externalDays).toBe(s.netDays);
    }
  });

  it('never bills more than the net advance minus external gains', () => {
    const s = auditReschedules([
      row({ old: '2026-12-01', neu: '2026-11-01' }), // bot 30d
      row({ old: '2026-09-01', neu: '2026-08-01' }), // external gap of 61d, then bot 31d
    ]);
    expect(s.billableDays).toBeLessThanOrEqual(s.netDays - Math.max(s.externalDays, 0));
  });

  it('never returns a negative billable total', () => {
    const s = auditReschedules([
      row({ old: '2026-08-01', neu: '2026-09-01' }), // moved LATER
    ]);
    expect(s.billableDays).toBe(0);
  });
});

describe('auditReschedules — chain breaks (manual owner moves)', () => {
  it('inserts an external move when the chain does not connect', () => {
    const s = auditReschedules([
      row({ old: '2026-12-10', neu: '2026-11-24' }), // bot 16d
      row({ old: '2026-10-14', neu: '2026-09-03' }), // chain break: 11-24 → 10-14 done by someone else
    ]);
    const ext = s.moves.filter((m) => m.actor === 'external');
    expect(ext).toHaveLength(1);
    expect(ext[0]!.from).toBe('2026-11-24');
    expect(ext[0]!.to).toBe('2026-10-14');
    expect(ext[0]!.days).toBe(41);
    expect(ext[0]!.billable).toBe(false);
    expect(ext[0]!.logId).toBeNull();
  });

  it('does not charge for external moves', () => {
    const s = auditReschedules([
      row({ old: '2026-12-10', neu: '2026-11-24' }),
      row({ old: '2026-10-14', neu: '2026-09-03' }),
    ]);
    expect(s.billableDays).toBe(16 + 41); // only the two bot moves
    expect(s.externalDays).toBe(41);
  });
});

describe('auditReschedules — post_error_recovered is suspect', () => {
  it('marks a recovered row suspect and keeps it out of the billable total', () => {
    const s = auditReschedules([
      row({ old: '2027-04-20', neu: '2026-11-24', error: '[post_error_recovered] fetch failed' }),
      row({ old: '2026-11-24', neu: '2026-09-03' }),
    ]);
    const sus = s.moves.filter((m) => m.suspect);
    expect(sus).toHaveLength(1);
    expect(sus[0]!.days).toBe(147);
    expect(sus[0]!.billable).toBe(false);
    expect(s.suspectDays).toBe(147);
    expect(s.billableDays).toBe(82); // only the clean 2026-11-24 → 2026-09-03
  });

  it('treats a clean success as billable', () => {
    const s = auditReschedules([row({ old: '2026-10-14', neu: '2026-09-03', error: '[best_available] attempt 1, #1/1' })]);
    expect(s.moves[0]!.billable).toBe(true);
    expect(s.moves[0]!.suspect).toBe(false);
    expect(s.billableDays).toBe(41);
  });
});

describe('auditReschedules — portal reversions cancel out', () => {
  it('drops a move the portal took back', () => {
    const s = auditReschedules([
      row({ old: '2026-12-01', neu: '2026-10-01' }),
      row({ old: '2026-10-01', neu: '2026-12-01', success: false, error: 'portal_reversion' }),
    ]);
    expect(s.moves).toHaveLength(0);
    expect(s.billableDays).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Production fixtures. These are the real chains from the fleet audit; they are
// what the billing numbers must reproduce.
// ─────────────────────────────────────────────────────────────────────────────
describe('auditReschedules — production chains', () => {
  it('bot 266: 58 billable, 147 suspect, 188 done by the owner', () => {
    const s = auditReschedules([
      row({ old: '2027-04-20', neu: '2026-11-24', error: '[post_error_recovered] fetch failed' }),
      row({ old: '2026-10-14', neu: '2026-09-03', error: '[best_available] attempt 1, #1/1' }),
      row({ old: '2026-09-03', neu: '2026-08-21', error: '[best_available] attempt 1, #1/1' }),
      row({ old: '2026-08-21', neu: '2026-08-17', error: '[best_available] attempt 1, #1/1' }),
    ]);
    expect(s.netDays).toBe(246);
    expect(s.botDays).toBe(205);
    expect(s.externalDays).toBe(41);
    expect(s.suspectDays).toBe(147);
    expect(s.billableDays).toBe(58);
    // 147 credited in error + 41 with no log at all = 188 done outside the bot
    expect(s.netDays - s.billableDays).toBe(188);
  });

  it('bot 177: revert-and-redo churn is capped by the net advance', () => {
    const s = auditReschedules([
      row({ old: '2026-12-16', neu: '2026-12-15' }),
      row({ old: '2026-12-15', neu: '2026-12-14' }),
      row({ old: '2026-12-14', neu: '2026-12-09' }),
      row({ old: '2026-12-09', neu: '2026-10-15' }),
      row({ old: '2026-10-15', neu: '2026-05-29' }),
      row({ old: '2026-10-15', neu: '2026-05-29', error: '[post_error_recovered] fetch failed' }),
      row({ old: '2026-12-21', neu: '2026-10-01' }),
      row({ old: '2026-10-01', neu: '2026-07-14' }),
      row({ old: '2026-07-14', neu: '2026-06-18' }),
    ]);
    expect(s.netDays).toBe(181);
    expect(s.botDays + s.externalDays).toBe(s.netDays);
    // botDays alone (526) would be a 3x overcharge; the ceiling holds it to the real advance.
    expect(s.billableDays).toBe(181);
    expect(s.billableDays).toBeLessThan(s.botDays);
  });

  it('bot 224: an external 107d jump is excluded, bot keeps its 77d', () => {
    const s = auditReschedules([
      row({ old: '2027-02-04', neu: '2026-12-10', error: '[best_available] attempt 1, #1/1' }),
      row({ old: '2026-08-25', neu: '2026-08-04', error: '[best_available] attempt 1, #1/1' }),
    ]);
    expect(s.externalDays).toBe(107);
    expect(s.billableDays).toBe(77);
    expect(s.netDays).toBe(184);
  });

  it('bot 212: moves that go later reduce the bot total', () => {
    const s = auditReschedules([
      row({ old: '2027-02-26', neu: '2027-02-24' }),
      row({ old: '2027-02-24', neu: '2027-02-23' }),
      row({ old: '2027-02-23', neu: '2026-12-18' }),
      row({ old: '2026-12-18', neu: '2026-12-07' }),
      row({ old: '2026-12-07', neu: '2026-06-23' }),
      row({ old: '2026-06-23', neu: '2026-06-15' }),
      row({ old: '2026-06-15', neu: '2026-07-10' }), // later
      row({ old: '2026-06-23', neu: '2026-06-26' }), // later, after an external move
    ]);
    expect(s.botDays).toBe(228);
    expect(s.externalDays).toBe(17);
    expect(s.netDays).toBe(245);
    expect(s.billableDays).toBe(228);
  });
});

/**
 * La cadena tiene que CERRAR contra la cita real del bot.
 *
 * Sin este cierre, una fila `success=true` que nunca ocurrio se cobra completa,
 * porque con una sola fila no hay cadena que se rompa. Caso real: bot 7 el
 * 2026-04-17, 464 dias cobrables con la cita quieta en 2027-07-30 durante 277
 * intentos entre 2026-02-24 y 2026-08-25.
 */
describe('auditReschedules — la cadena cierra contra la cita real', () => {
  it('ADVERSARIAL: el caso del bot 7 no cobra nada', () => {
    const s = auditReschedules(
      [row({ old: '2027-07-30', neu: '2026-04-22', error: '[best_available] attempt 1, #1/1 (speculative)' })],
      { citaActual: '2027-07-30' },   // la cita NUNCA se movio
    );
    expect(s.botDays).toBe(464);          // el log sigue diciendo lo que dice
    expect(s.billableDays).toBe(0);       // y no se cobra nada
    expect(s.netDays).toBe(0);            // el avance real es cero
    expect(s.moves.some((m) => m.kind === 'chain_open')).toBe(true);
  });

  it('sin citaActual conserva el comportamiento anterior', () => {
    const s = auditReschedules(
      [row({ old: '2027-07-30', neu: '2026-04-22' })],
    );
    expect(s.billableDays).toBe(464);
    expect(s.moves.some((m) => m.kind === 'chain_open')).toBe(false);
  });

  it('una cadena que SI cierra cobra normal', () => {
    const s = auditReschedules(
      [row({ old: '2027-04-20', neu: '2026-11-24' })],
      { citaActual: '2026-11-24' },
    );
    expect(s.billableDays).toBe(147);
    expect(s.moves.some((m) => m.kind === 'chain_open')).toBe(false);
  });

  it('el dueno mueve la cita al futuro DESPUES: no se cobra el ida y vuelta', () => {
    const s = auditReschedules(
      [row({ old: '2027-03-15', neu: '2026-09-08' })],
      { citaActual: '2027-03-15' },
    );
    expect(s.botDays).toBe(188);
    expect(s.billableDays).toBe(0);
    expect(s.netDays).toBe(0);
  });

  it('el dueno mueve la cita PARCIALMENTE hacia atras: se cobra lo que quedo', () => {
    // bot: 2027-01-01 -> 2026-06-01 (214d). Despues alguien la deja en 2026-08-01.
    const s = auditReschedules(
      [row({ old: '2027-01-01', neu: '2026-06-01' })],
      { citaActual: '2026-08-01' },
    );
    expect(s.botDays).toBe(214);
    expect(s.netDays).toBe(153);          // avance real que le queda al cliente
    expect(s.billableDays).toBe(153);     // el techo lo recorta
  });

  it('mantiene la invariante botDays + externalDays === netDays', () => {
    for (const cita of ['2027-07-30', '2026-04-22', '2026-08-01', '2028-01-01']) {
      const s = auditReschedules(
        [row({ old: '2027-07-30', neu: '2026-04-22' })],
        { citaActual: cita },
      );
      expect(s.botDays + s.externalDays).toBe(s.netDays);
    }
  });

  it('el tramo de cierre nunca sale como cobrable', () => {
    const s = auditReschedules(
      [row({ old: '2027-07-30', neu: '2026-04-22' })],
      { citaActual: '2025-01-01' },   // cita mucho mas temprana, sin log que la explique
    );
    const cierre = s.moves.find((m) => m.kind === 'chain_open');
    expect(cierre).toBeDefined();
    expect(cierre!.billable).toBe(false);
    expect(cierre!.actor).toBe('external');
  });
});

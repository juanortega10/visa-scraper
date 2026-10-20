import { describe, it, expect } from 'vitest';
import { diasConsularHistoricos, type HistorialBot } from '../reschedule-attribution.js';

const ok = (createdAt: string, oldConsularDate: string, newConsularDate: string) =>
  ({ createdAt, oldConsularDate, newConsularDate, success: true });

// Cliente 573142626556 (cuenta gatico_29), filas reales de reschedule_logs al 2026-10-20.
const bot188: HistorialBot = {
  botId: 188, citaActual: '2027-02-17',
  filas: [
    ok('2026-05-30T20:25:00Z', '2027-02-22', '2027-02-19'),
    ok('2026-05-30T20:31:00Z', '2027-02-19', '2027-02-17'),
  ],
};
const bot190: HistorialBot = {
  botId: 190, citaActual: '2026-06-15',
  filas: [
    ok('2026-06-01T18:55:00Z', '2027-02-18', '2026-11-12'),
    ok('2026-06-01T19:10:00Z', '2026-11-12', '2026-06-24'),
    ok('2026-06-01T19:40:00Z', '2026-06-24', '2026-06-16'),
    ok('2026-06-01T19:50:00Z', '2026-06-16', '2026-06-09'),
    // El dueño movió la cita por fuera a 2027-02-23 (-259 días) antes de esta fila.
    ok('2026-06-02T14:20:00Z', '2027-02-23', '2026-07-13'),
    ok('2026-06-02T14:46:00Z', '2026-07-13', '2026-06-15'),
  ],
};
const bot325: HistorialBot = {
  botId: 325, citaActual: '2027-03-01',
  filas: [ok('2026-10-20T17:25:00Z', '2027-05-04', '2027-03-01')],
};
const mov325 = { botId: 325, oldConsularDate: '2027-05-04', newConsularDate: '2027-03-01' };

describe('diasConsularHistoricos', () => {
  it('suma lo cobrable de todos los bots del cliente: 5 + 248 + 64 = 317', () => {
    expect(diasConsularHistoricos([bot188, bot190, bot325], mov325)).toBe(317);
  });

  it('no cobra el movimiento externo del bot 190 (507 del bot, 248 cobrables)', () => {
    expect(diasConsularHistoricos([bot190])).toBe(248);
  });

  it('incluye el movimiento avisado aunque su fila aún no esté en reschedule_logs', () => {
    const sinFila = { ...bot325, filas: [] };
    expect(diasConsularHistoricos([bot188, bot190, sinFila], mov325)).toBe(317);
  });

  it('no cuenta dos veces el movimiento cuando la fila ya está', () => {
    expect(diasConsularHistoricos([bot325], mov325)).toBe(64);
  });

  it('cliente sin bots da 0', () => {
    expect(diasConsularHistoricos([])).toBe(0);
  });
});

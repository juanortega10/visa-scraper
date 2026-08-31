/**
 * `countSustainedAccountBans` decide el nivel del backoff. Contar de mas manda al bot
 * al tope de la curva: 480 min con `account_ban`, 720 con `schedule_blocked`.
 *
 * Con el ahorro de escrituras de `poll-logging.ts`, un bot bloqueado deja UNA fila por
 * sondeo, y los sondeos van separados por el backoff, o sea horas. Sin corte por tiempo,
 * las 5 filas de la ventana parecian seguidas aunque abarcaran medio dia.
 *
 * Caso real del 2026-08-31: los bots 302, 303, 269 y 299 contaban 4 y cargaban 6 h de
 * silencio. Sus filas estaban separadas por 2 h y por 5 h, y el nivel real era 1.
 */
import { describe, it, expect } from 'vitest';
import { countSustainedAccountBans, VENTANA_RACHA, accountBanBackoffMs } from '../scheduling.js';

const d = (iso: string) => new Date(`${iso}Z`);
const bloqueo = (iso: string, cls = 'account_ban') => ({ status: 'tcp_blocked', blockCls: cls, createdAt: d(iso) });
const sano = (iso: string) => ({ status: 'ok', blockCls: null, createdAt: d(iso) });

describe('corte por tiempo en la racha', () => {
  it('el caso real del bot 303 cuenta 1, no 4', () => {
    const filas = [
      bloqueo('2026-08-31T06:23:39'),
      bloqueo('2026-08-31T04:23:29'),                        // 2 h antes
      bloqueo('2026-08-30T23:01:23', 'schedule_blocked'),    // 5 h antes
      bloqueo('2026-08-30T23:01:13'),
      sano('2026-08-30T23:00:27'),
    ];
    expect(countSustainedAccountBans(filas)).toBe(1);
  });

  it('una racha real seguida se sigue contando entera', () => {
    // Cada bloqueo llega apenas vence el backoff del anterior.
    const filas = [
      bloqueo('2026-08-31T02:00:00'),
      bloqueo('2026-08-31T01:20:00'),
      bloqueo('2026-08-31T01:00:00'),
    ];
    expect(countSustainedAccountBans(filas)).toBe(3);
  });

  it('el corte cae justo donde el hueco pasa el backoff por el margen', () => {
    const backoff1 = accountBanBackoffMs(1);
    const base = new Date('2026-08-31T12:00:00Z').getTime();
    const dentro = [
      { status: 'tcp_blocked', blockCls: 'account_ban', createdAt: new Date(base) },
      { status: 'tcp_blocked', blockCls: 'account_ban', createdAt: new Date(base - backoff1 * VENTANA_RACHA + 60_000) },
    ];
    const fuera = [
      { status: 'tcp_blocked', blockCls: 'account_ban', createdAt: new Date(base) },
      { status: 'tcp_blocked', blockCls: 'account_ban', createdAt: new Date(base - backoff1 * VENTANA_RACHA - 60_000) },
    ];
    expect(countSustainedAccountBans(dentro)).toBe(2);
    expect(countSustainedAccountBans(fuera)).toBe(1);
  });

  it('una fila sana corta la racha, como antes', () => {
    const filas = [
      bloqueo('2026-08-31T02:00:00'),
      sano('2026-08-31T01:55:00'),
      bloqueo('2026-08-31T01:50:00'),
    ];
    expect(countSustainedAccountBans(filas)).toBe(1);
  });

  it('sin bloqueos al frente cuenta cero', () => {
    expect(countSustainedAccountBans([sano('2026-08-31T02:00:00')])).toBe(0);
    expect(countSustainedAccountBans([])).toBe(0);
  });
});

describe('createdAt puede llegar como texto', () => {
  // `jsonb_agg` y `db.execute` devuelven el timestamp como string donde Drizzle devuelve
  // Date. Sin normalizar, reventaba con "getTime is not a function" y tumbaba al detector
  // entero (paso el 2026-08-31 al conectar la ventana a `audit-cadenas-dormidas.ts`).
  it('acepta strings igual que Dates', () => {
    const comoTexto = [
      { status: 'tcp_blocked', blockCls: 'account_ban', createdAt: '2026-08-31T06:23:39.000Z' },
      { status: 'tcp_blocked', blockCls: 'account_ban', createdAt: '2026-08-31T04:23:29.000Z' },
    ];
    expect(countSustainedAccountBans(comoTexto)).toBe(1);
  });

  it('un valor invalido no rompe, cae al conteo por posicion', () => {
    const basura = [
      { status: 'tcp_blocked', blockCls: 'account_ban', createdAt: 'no-es-fecha' },
      { status: 'tcp_blocked', blockCls: 'account_ban', createdAt: 'tampoco' },
    ];
    expect(() => countSustainedAccountBans(basura)).not.toThrow();
    expect(countSustainedAccountBans(basura)).toBe(2);
  });
});

describe('compatibilidad sin fechas', () => {
  it('sin createdAt se mantiene el conteo por posicion', () => {
    const sinFechas = [
      { status: 'tcp_blocked', blockCls: 'account_ban' },
      { status: 'tcp_blocked', blockCls: 'account_ban' },
      { status: 'tcp_blocked', blockCls: 'schedule_blocked' },
      { status: 'tcp_blocked', blockCls: 'account_ban' },
    ];
    expect(countSustainedAccountBans(sinFechas)).toBe(4);
  });

  it('una fecha faltante en el medio no rompe el conteo', () => {
    const mixto = [
      bloqueo('2026-08-31T02:00:00'),
      { status: 'tcp_blocked', blockCls: 'account_ban' },
      bloqueo('2026-08-31T01:00:00'),
    ];
    expect(countSustainedAccountBans(mixto)).toBeGreaterThanOrEqual(1);
  });
});

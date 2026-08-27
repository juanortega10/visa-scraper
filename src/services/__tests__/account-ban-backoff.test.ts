import { describe, it, expect } from 'vitest';
import { accountBanBackoffMs, accountBanBackoffDelay, countSustainedAccountBans } from '../scheduling.js';

const MIN = 60_000;

describe('accountBanBackoffMs — aggressive 2x-doubling account-ban curve', () => {
  it('doubles 30m → 60m → 120m → 240m → 480m as the ban is confirmed sustained', () => {
    expect(accountBanBackoffMs(0)).toBe(30 * MIN);
    expect(accountBanBackoffMs(1)).toBe(30 * MIN);
    expect(accountBanBackoffMs(2)).toBe(60 * MIN);
    expect(accountBanBackoffMs(3)).toBe(120 * MIN);
    expect(accountBanBackoffMs(4)).toBe(240 * MIN);
    expect(accountBanBackoffMs(5)).toBe(480 * MIN);
  });

  it('each step is exactly 2x the previous (pure doubling)', () => {
    for (let c = 2; c <= 5; c++) {
      expect(accountBanBackoffMs(c)).toBe(accountBanBackoffMs(c - 1) * 2);
    }
  });

  it('saturates at the 480m (8h) cap — count is bounded by the last-5 poll_logs window', () => {
    expect(accountBanBackoffMs(5)).toBe(480 * MIN);
    expect(accountBanBackoffMs(50)).toBe(480 * MIN);
  });

  it('never returns the old 10m first-probe (that just kept the ban warm)', () => {
    for (let c = 0; c <= 6; c++) expect(accountBanBackoffMs(c)).toBeGreaterThanOrEqual(30 * MIN);
  });

  it('accountBanBackoffDelay renders the Trigger.dev minute string', () => {
    expect(accountBanBackoffDelay(0)).toBe('30m');
    expect(accountBanBackoffDelay(2)).toBe('60m');
    expect(accountBanBackoffDelay(3)).toBe('120m');
    expect(accountBanBackoffDelay(4)).toBe('240m');
    expect(accountBanBackoffDelay(5)).toBe('480m');
  });

  it('caps at 480m and never escalates to a pause — the bot self-heals with no manual step', () => {
    // A sustained ban holds here forever (8h probes); recovery is automatic on the next ok poll.
    expect(accountBanBackoffMs(5)).toBe(480 * MIN);
    expect(accountBanBackoffMs(999)).toBe(480 * MIN);
  });
});

describe('countSustainedAccountBans — una fila sana corta la racha', () => {
  const ban = { status: 'tcp_blocked', blockCls: 'account_ban' };
  const ipBan = { status: 'tcp_blocked', blockCls: 'ip_ban' };
  const sano = { status: 'filtered_out', blockCls: null };
  const ok = { status: 'ok', blockCls: null };

  it('cuenta solo los bloqueos seguidos al frente', () => {
    expect(countSustainedAccountBans([ban, ban, sano, sano, sano])).toBe(2);
    expect(countSustainedAccountBans([ban, sano, ban, ban, ban])).toBe(1);
    expect(countSustainedAccountBans([sano, ban, ban, ban, ban])).toBe(0);
  });

  it('el caso real del bot 299: 2 bloqueos + 3 polls sanos daba 480m en vez de 60m', () => {
    const ventana = [ban, ban, sano, sano, sano];
    expect(countSustainedAccountBans(ventana)).toBe(2);
    expect(accountBanBackoffDelay(countSustainedAccountBans(ventana))).toBe('60m');
    // La version vieja devolvia 5 porque las filas sanas traen blockCls null.
    const viejo = ventana.findIndex((r) => r.blockCls !== null && r.blockCls !== 'account_ban');
    expect(viejo === -1 ? ventana.length : viejo).toBe(5);
    expect(accountBanBackoffDelay(5)).toBe('480m');
  });

  it('un ban sostenido de verdad si llega al tope', () => {
    expect(countSustainedAccountBans([ban, ban, ban, ban, ban])).toBe(5);
    expect(accountBanBackoffDelay(countSustainedAccountBans([ban, ban, ban, ban, ban]))).toBe('480m');
  });

  it('un bloqueo de IP no cuenta como bloqueo de cuenta', () => {
    expect(countSustainedAccountBans([ipBan, ban, ban, ban, ban])).toBe(0);
    expect(countSustainedAccountBans([ban, ipBan, ban, ban, ban])).toBe(1);
  });

  it('ventana vacia da 0', () => {
    expect(countSustainedAccountBans([])).toBe(0);
    expect(countSustainedAccountBans([ok])).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { accountBanBackoffMs, accountBanBackoffDelay, countSustainedAccountBans, scheduleBlockedBackoffMs, scheduleBlockedBackoffDelay, blockBackoffMs } from '../scheduling.js';

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

describe('scheduleBlockedBackoffMs — curva del bloqueo de la ruta del schedule', () => {
  it('escala 240m → 480m → 720m', () => {
    expect(scheduleBlockedBackoffMs(0)).toBe(240 * MIN);
    expect(scheduleBlockedBackoffMs(1)).toBe(240 * MIN);
    expect(scheduleBlockedBackoffMs(2)).toBe(480 * MIN);
    expect(scheduleBlockedBackoffMs(3)).toBe(720 * MIN);
  });

  it('topa en 720m (12h) y nunca pausa el bot', () => {
    expect(scheduleBlockedBackoffMs(5)).toBe(720 * MIN);
    expect(scheduleBlockedBackoffMs(999)).toBe(720 * MIN);
  });

  it('siempre espera mas que la curva de bloqueo de cuenta', () => {
    for (let c = 0; c <= 6; c++) {
      expect(scheduleBlockedBackoffMs(c)).toBeGreaterThan(accountBanBackoffMs(c));
    }
  });

  it('scheduleBlockedBackoffDelay arma el string de Trigger.dev', () => {
    expect(scheduleBlockedBackoffDelay(1)).toBe('240m');
    expect(scheduleBlockedBackoffDelay(2)).toBe('480m');
    expect(scheduleBlockedBackoffDelay(3)).toBe('720m');
  });
});

describe('blockBackoffMs — un solo lector para poll-visa y ensure-chain', () => {
  it('elige la curva por clasificacion', () => {
    expect(blockBackoffMs('account_ban', 3)).toBe(accountBanBackoffMs(3));
    expect(blockBackoffMs('schedule_blocked', 3)).toBe(scheduleBlockedBackoffMs(3));
  });

  it('sin clasificacion cae en la curva de cuenta', () => {
    expect(blockBackoffMs(null, 2)).toBe(accountBanBackoffMs(2));
  });
});

describe('countSustainedAccountBans — schedule_blocked mantiene la racha', () => {
  const ban = { status: 'tcp_blocked', blockCls: 'account_ban' };
  const sched = { status: 'tcp_blocked', blockCls: 'schedule_blocked' };
  const sano = { status: 'filtered_out', blockCls: null };

  it('cuenta las filas schedule_blocked igual que las de cuenta', () => {
    expect(countSustainedAccountBans([sched, sched, sano, sano, sano])).toBe(2);
    expect(countSustainedAccountBans([sched, ban, sched, sano, sano])).toBe(3);
  });

  it('sin esto la sonda cortaba la racha y el backoff nunca escalaba', () => {
    // La sonda reescribe la fila mas nueva a schedule_blocked. Con la regla vieja
    // (solo account_ban) el contador volvia a 0 y el bot reintentaba a los 240m para siempre.
    expect(countSustainedAccountBans([sched, ban, ban, ban, ban])).toBe(5);
    expect(scheduleBlockedBackoffDelay(5)).toBe('720m');
  });

  it('una fila sana sigue cortando la racha', () => {
    expect(countSustainedAccountBans([sano, sched, sched, sched, sched])).toBe(0);
  });
});

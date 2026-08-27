import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { probeScheduleBlock, deriveBlockClassification } from '../proxy-fetch.js';

/**
 * Contexto real: bot 299 (schedule 75610929, es-pe) quedo marcado `account_ban` y
 * cargo el backoff de 8h. La sonda en vivo del 2026-08-27 mostro que el dominio SI
 * responde (302 en /niv) y que solo las rutas /schedule/75610929/* estan cerradas.
 * El veredicto correcto es `schedule_blocked`.
 */
describe('probeScheduleBlock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('el dominio responde → schedule_blocked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 302, body: null }));
    expect(await probeScheduleBlock('es-pe')).toBe('schedule_blocked');
  });

  it('el dominio no responde → account_ban', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('other side closed')));
    expect(await probeScheduleBlock('es-mx')).toBe('account_ban');
  });

  it('cachea el veredicto por locale durante 5 min', async () => {
    const f = vi.fn().mockResolvedValue({ status: 200, body: null });
    vi.stubGlobal('fetch', f);
    await probeScheduleBlock('fr-ca');
    await probeScheduleBlock('fr-ca');
    await probeScheduleBlock('fr-ca');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('vuelve a sondear pasados los 5 min', async () => {
    const f = vi.fn().mockResolvedValue({ status: 200, body: null });
    vi.stubGlobal('fetch', f);
    await probeScheduleBlock('es-cl');
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await probeScheduleBlock('es-cl');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('el cache no mezcla locales', async () => {
    const f = vi.fn().mockResolvedValue({ status: 200, body: null });
    vi.stubGlobal('fetch', f);
    await probeScheduleBlock('es-ec');
    await probeScheduleBlock('es-py');
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('deriveBlockClassification', () => {
  it('socket cerrado sin bytes → account_ban, que luego se refina', () => {
    expect(deriveBlockClassification({ socketBytesRead: 0, poolExhausted: false })).toBe('account_ban');
  });
  it('pool agotado con bytes leidos → ip_ban', () => {
    expect(deriveBlockClassification({ socketBytesRead: 12, poolExhausted: true })).toBe('ip_ban');
  });
  it('lo demas es transitorio', () => {
    expect(deriveBlockClassification({ socketBytesRead: 12, poolExhausted: false })).toBe('transient');
  });
});

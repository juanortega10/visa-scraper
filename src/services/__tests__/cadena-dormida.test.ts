/**
 * Cadena dormida: cuando un run DELAYED viejo deja al bot sin pollear.
 *
 * La regla tiene que cumplir dos cosas a la vez:
 *   1. despertar un bot que lleva horas mudo por un run DELAYED huerfano,
 *   2. NUNCA acortar un backoff de bloqueo de cuenta, que llega a 480 min.
 */
import { describe, it, expect } from 'vitest';
import { debeDespertar, TOPE_SIN_BAN_MS, accountBanBackoffMs } from '../scheduling.js';

const MIN = 60_000;

describe('debeDespertar sin bloqueo de cuenta', () => {
  it('no despierta durante un backoff TCP normal', () => {
    expect(debeDespertar({ msSinPoll: 2 * MIN, bansSeguidos: 0 })).toBe(false);
    expect(debeDespertar({ msSinPoll: 10 * MIN, bansSeguidos: 0 })).toBe(false);
    expect(debeDespertar({ msSinPoll: 30 * MIN, bansSeguidos: 0 })).toBe(false);
  });

  it('el limite son 35 min, no antes', () => {
    expect(debeDespertar({ msSinPoll: TOPE_SIN_BAN_MS, bansSeguidos: 0 })).toBe(false);
    expect(debeDespertar({ msSinPoll: TOPE_SIN_BAN_MS + 1, bansSeguidos: 0 })).toBe(true);
  });

  it('despierta los casos reales de la noche del 2026-08-27', () => {
    // bots 285, 269, 223 y 299: entre 30 min y 2 h de silencio, sin ban.
    expect(debeDespertar({ msSinPoll: 45 * MIN, bansSeguidos: 0 })).toBe(true);
    expect(debeDespertar({ msSinPoll: 120 * MIN, bansSeguidos: 0 })).toBe(true);
  });

  it('un bot sin ninguna fila de poll_logs se despierta', () => {
    expect(debeDespertar({ msSinPoll: Number.MAX_SAFE_INTEGER, bansSeguidos: 0 })).toBe(true);
  });
});

describe('debeDespertar con bloqueo de cuenta', () => {
  it('respeta cada escalon de la curva 30-60-120-240-480 min', () => {
    for (let n = 1; n <= 5; n++) {
      const backoff = accountBanBackoffMs(n);
      expect(debeDespertar({ msSinPoll: backoff, bansSeguidos: n })).toBe(false);
      expect(debeDespertar({ msSinPoll: backoff * 1.4, bansSeguidos: n })).toBe(false);
      expect(debeDespertar({ msSinPoll: backoff * 1.5 + 1, bansSeguidos: n })).toBe(true);
    }
  });

  it('con ban sostenido no despierta a los 35 min, aunque sin ban si lo haria', () => {
    expect(debeDespertar({ msSinPoll: 40 * MIN, bansSeguidos: 0 })).toBe(true);
    expect(debeDespertar({ msSinPoll: 40 * MIN, bansSeguidos: 5 })).toBe(false);
  });

  it('un ban de 480 min se aguanta 12 h antes de tocarlo', () => {
    expect(debeDespertar({ msSinPoll: 11 * 60 * MIN, bansSeguidos: 5 })).toBe(false);
    expect(debeDespertar({ msSinPoll: 13 * 60 * MIN, bansSeguidos: 5 })).toBe(true);
  });
});

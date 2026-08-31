/**
 * El verificador de cadenas dormidas tiene una sola invariante que importa:
 *
 *   si el despertador de `poll-visa.ts` hace su trabajo, este verificador calla.
 *
 * Los tests la fijan de las dos puntas: nunca reporta antes de que el despertador
 * deba actuar, y siempre reporta cuando el silencio pasa de largo ese punto.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluarCadena, cadenasConProblema, cadenasEnBackoffLargo, umbralDespertadorMs,
  MARGEN_VERIFICADOR_MS, GRACIA_ARRANQUE_MS, BACKOFF_LARGO_MS, type EntradaCadena,
} from '../chain-health.js';
import { debeDespertar, TOPE_SIN_BAN_MS, accountBanBackoffMs, scheduleBlockedBackoffMs } from '../scheduling.js';

const MIN = 60_000;
const AHORA = new Date('2026-08-30T12:00:00Z').getTime();

const base = (over: Partial<EntradaCadena> = {}): EntradaCadena => ({
  botId: 281,
  locale: 'es-mx',
  status: 'active',
  entornos: ['dev'],
  ultimoPoll: new Date(AHORA - 5 * MIN),
  ultimas: [{ status: 'filtered_out', blockCls: null }],
  activatedAt: new Date(AHORA - 30 * 24 * 60 * MIN),
  ...over,
});

describe('umbralDespertadorMs sigue a debeDespertar', () => {
  it('sin bloqueo devuelve el tope de 35 min, redondeado al minuto de arriba', () => {
    const u = umbralDespertadorMs({ bansSeguidos: 0, blockCls: null });
    expect(u).toBeGreaterThanOrEqual(TOPE_SIN_BAN_MS);
    expect(u - TOPE_SIN_BAN_MS).toBeLessThanOrEqual(MIN);
  });

  it('con account_ban sigue la curva de la cuenta por 1,5', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const esperado = accountBanBackoffMs(n) * 1.5;
      const got = umbralDespertadorMs({ bansSeguidos: n, blockCls: 'account_ban' });
      expect(Math.abs(got - esperado)).toBeLessThanOrEqual(MIN);
    }
  });

  it('con schedule_blocked sigue la curva larga', () => {
    for (const n of [1, 2, 3, 4]) {
      const esperado = scheduleBlockedBackoffMs(n) * 1.5;
      const got = umbralDespertadorMs({ bansSeguidos: n, blockCls: 'schedule_blocked' });
      expect(Math.abs(got - esperado)).toBeLessThanOrEqual(MIN);
    }
  });

  it('el umbral es el punto exacto donde debeDespertar cambia de opinion', () => {
    for (const caso of [
      { bansSeguidos: 0, blockCls: null },
      { bansSeguidos: 2, blockCls: 'account_ban' },
      { bansSeguidos: 3, blockCls: 'schedule_blocked' },
    ]) {
      const u = umbralDespertadorMs(caso);
      expect(debeDespertar({ msSinPoll: u - 2 * MIN, ...caso })).toBe(false);
      expect(debeDespertar({ msSinPoll: u + 2 * MIN, ...caso })).toBe(true);
    }
  });
});

describe('el verificador nunca se adelanta al despertador', () => {
  it('calla mientras el despertador todavia no debe actuar', () => {
    for (const min of [1, 5, 15, 30, 34]) {
      const r = evaluarCadena(base({ ultimoPoll: new Date(AHORA - min * MIN) }), AHORA);
      expect(r.veredicto).toBe('ok');
    }
  });

  it('calla dentro del margen, justo despues del umbral del despertador', () => {
    const u = umbralDespertadorMs({ bansSeguidos: 0, blockCls: null });
    const dentro = u + MARGEN_VERIFICADOR_MS - 2 * MIN;
    const r = evaluarCadena(base({ ultimoPoll: new Date(AHORA - dentro) }), AHORA);
    expect(r.veredicto).toBe('ok');
  });

  it('reporta cuando el silencio pasa el umbral mas el margen', () => {
    const u = umbralDespertadorMs({ bansSeguidos: 0, blockCls: null });
    const fuera = u + MARGEN_VERIFICADOR_MS + 2 * MIN;
    const r = evaluarCadena(base({ ultimoPoll: new Date(AHORA - fuera) }), AHORA);
    expect(r.veredicto).toBe('dormida');
    expect(r.minSinPoll).toBe(Math.round(fuera / MIN));
  });
});

describe('respeta los backoff legitimos', () => {
  it('un bloqueo de cuenta sostenido nunca se marca dormida durante su backoff', () => {
    const ultimas = Array(3).fill({ status: 'tcp_blocked', blockCls: 'account_ban' });
    const dentro = accountBanBackoffMs(3) * 1.5;
    const r = evaluarCadena(base({ ultimoPoll: new Date(AHORA - dentro), ultimas }), AHORA);
    expect(r.bansSeguidos).toBe(3);
    expect(r.veredicto).not.toBe('dormida');
    expect(cadenasConProblema([r])).toEqual([]);
  });

  it('un schedule_blocked de 12 h tampoco pide despertar nada', () => {
    const ultimas = Array(4).fill({ status: 'tcp_blocked', blockCls: 'schedule_blocked' });
    const dentro = scheduleBlockedBackoffMs(4) * 1.5;
    const r = evaluarCadena(base({ ultimoPoll: new Date(AHORA - dentro), ultimas }), AHORA);
    expect(r.veredicto).not.toBe('dormida');
    expect(cadenasConProblema([r])).toEqual([]);
  });

  it('pero un schedule_blocked que pasa su propio techo si se reporta', () => {
    const ultimas = Array(4).fill({ status: 'tcp_blocked', blockCls: 'schedule_blocked' });
    const fuera = scheduleBlockedBackoffMs(4) * 1.5 + MARGEN_VERIFICADOR_MS + 5 * MIN;
    const r = evaluarCadena(base({ ultimoPoll: new Date(AHORA - fuera), ultimas }), AHORA);
    expect(r.veredicto).toBe('dormida');
  });
});

describe('el caso real del bot 281', () => {
  it('63 h de silencio tras un tcp_blocked se reportan como dormida', () => {
    // 2026-08-27 22:51 UTC al 2026-08-30 14:06 UTC. Ninguna capa lo vio.
    const ultimas = [
      { status: 'tcp_blocked', blockCls: 'account_ban' },
      { status: 'tcp_blocked', blockCls: 'account_ban' },
      { status: 'filtered_out', blockCls: null },
    ];
    const r = evaluarCadena(base({ ultimoPoll: new Date(AHORA - 63 * 60 * MIN), ultimas }), AHORA);
    expect(r.veredicto).toBe('dormida');
    expect(r.minSinPoll).toBe(63 * 60);
  });

  it('el peor backoff legitimo queda muy por debajo de 63 h', () => {
    // Ni la curva mas larga justifica ese silencio. Sin esto, el detector podria
    // volverse tan tolerante que el incidente original pase de nuevo sin alarma.
    const peor = umbralDespertadorMs({ bansSeguidos: 10, blockCls: 'schedule_blocked' });
    expect(peor).toBeLessThan(63 * 60 * MIN);
  });
});

describe('bots que nunca pollearon', () => {
  it('un bot recien activado tiene gracia', () => {
    const r = evaluarCadena(base({
      ultimoPoll: null, ultimas: [], activatedAt: new Date(AHORA - 10 * MIN),
    }), AHORA);
    expect(r.veredicto).toBe('ok');
  });

  it('pasada la gracia sin un solo poll se reporta', () => {
    const r = evaluarCadena(base({
      ultimoPoll: null, ultimas: [],
      activatedAt: new Date(AHORA - GRACIA_ARRANQUE_MS - MIN),
    }), AHORA);
    expect(r.veredicto).toBe('nunca_polleo');
    expect(r.minSinPoll).toBeNull();
  });
});

describe('cadenasConProblema', () => {
  it('deja fuera las sanas y ordena de mas dormida a menos', () => {
    const rs = [
      evaluarCadena(base({ botId: 1, ultimoPoll: new Date(AHORA - 2 * MIN) }), AHORA),
      evaluarCadena(base({ botId: 2, ultimoPoll: new Date(AHORA - 120 * MIN) }), AHORA),
      evaluarCadena(base({ botId: 3, ultimoPoll: new Date(AHORA - 600 * MIN) }), AHORA),
    ];
    const malas = cadenasConProblema(rs);
    expect(malas.map((r) => r.botId)).toEqual([3, 2]);
  });

  it('un bot que nunca polleo va primero', () => {
    const rs = [
      evaluarCadena(base({ botId: 2, ultimoPoll: new Date(AHORA - 120 * MIN) }), AHORA),
      evaluarCadena(base({ botId: 9, ultimoPoll: null, ultimas: [] }), AHORA),
    ];
    expect(cadenasConProblema(rs).map((r) => r.botId)).toEqual([9, 2]);
  });
});

describe('backoff largo pero legitimo', () => {
  // El 2026-08-30 la curva de `schedule_blocked` apago 9 de 14 bots `dev` en 13 h,
  // de a uno por hora. El veredicto `ok` los tapaba porque el backoff los justifica.
  const bloqueado = (min: number, bans: number) => evaluarCadena(base({
    ultimoPoll: new Date(AHORA - min * MIN),
    ultimas: Array(bans).fill({ status: 'tcp_blocked', blockCls: 'schedule_blocked' }),
  }), AHORA);

  it('un silencio corto dentro del backoff sigue siendo ok', () => {
    expect(bloqueado(60, 2).veredicto).toBe('ok');
  });

  it('pasadas las 2 h se reporta como backoff_largo', () => {
    const r = bloqueado(Math.round(BACKOFF_LARGO_MS / MIN) + 10, 2);
    expect(r.veredicto).toBe('backoff_largo');
  });

  it('el caso real del bot 303: 262 min callado con 2 bloqueos', () => {
    const r = bloqueado(262, 2);
    expect(r.veredicto).toBe('backoff_largo');
    expect(r.toleranciaMin).toBeGreaterThan(262);
  });

  it('si el silencio pasa la tolerancia, gana dormida', () => {
    expect(bloqueado(2000, 2).veredicto).toBe('dormida');
  });

  it('backoff_largo queda fuera de cadenasConProblema', () => {
    const rs = [bloqueado(262, 2), bloqueado(2000, 2)];
    expect(cadenasConProblema(rs).map((r) => r.veredicto)).toEqual(['dormida']);
    expect(cadenasEnBackoffLargo(rs).map((r) => r.veredicto)).toEqual(['backoff_largo']);
  });

  it('cadenasEnBackoffLargo ordena de mas callada a menos', () => {
    const rs = [bloqueado(150, 2), bloqueado(262, 2), bloqueado(200, 2)];
    expect(cadenasEnBackoffLargo(rs).map((r) => r.minSinPoll)).toEqual([262, 200, 150]);
  });
});

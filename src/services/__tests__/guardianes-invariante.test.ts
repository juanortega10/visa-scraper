/**
 * Verificador exhaustivo de la invariante que sostiene toda la flota:
 *
 *   NINGUN bot activo puede quedar dormido para siempre.
 *
 * Los tres guardianes deciden por separado (`poll-cron`, el DEDUP de `poll-visa`,
 * `ensure-chain`), y entre sus reglas se puede abrir un hueco donde ninguno actua.
 * Paso el 2026-08-31 con los bots 240 y 223: 69 y 64 min dormidos con `account_ban x1`,
 * que son 30 min de backoff. `poll-cron` veia el run DELAYED y hacia `continue`, el
 * despertador de `poll-visa` vive dentro de un run que por eso nunca existia, y
 * `ensure-chain` devolvia `cron_ok` sin mirar el reloj.
 *
 * Estos tests barren el espacio de estados completo en vez de probar casos sueltos:
 * 7 estados de run x 96 valores de silencio x 6 rachas x 3 clasificaciones = 12.096
 * combinaciones. Si alguna deja al bot huerfano pasado el techo, falla y nombra el caso.
 */
import { describe, it, expect } from 'vitest';
import {
  cronDispara, ensureChainActua, quedaHuerfano,
  TECHO_SILENCIO_MIN, TECHO_EXECUTING_MIN, ESTADOS_VIVOS, type EstadoCadena,
} from '../guardianes.js';
import { SILENCIO_CRON_MIN } from '../../trigger/ensure-chain.js';
import { blockBackoffMs } from '../scheduling.js';

const ESTADOS = [null, 'EXECUTING', 'DELAYED', 'QUEUED', 'CANCELED', 'COMPLETED', 'FAILED'];
const CLASES = [null, 'account_ban', 'schedule_blocked'];
const RACHAS = [0, 1, 2, 3, 4, 5];
// 0 a 24 h en pasos de 15 min.
const SILENCIOS = Array.from({ length: 96 }, (_, i) => i * 15);

function* universo(): Generator<EstadoCadena> {
  for (const status of ESTADOS)
    for (const minSinPoll of SILENCIOS)
      for (const bansSeguidos of RACHAS)
        for (const blockCls of CLASES)
          yield { status, minSinPoll, bansSeguidos, blockCls };
}

describe('invariante: nadie queda dormido para siempre', () => {
  it('ningun estado pasado el techo queda huerfano', () => {
    const huerfanos: EstadoCadena[] = [];
    for (const e of universo()) {
      if (e.minSinPoll <= TECHO_SILENCIO_MIN) continue;
      if (quedaHuerfano(e, SILENCIO_CRON_MIN)) huerfanos.push(e);
    }
    expect(huerfanos, `estados sin guardian: ${JSON.stringify(huerfanos.slice(0, 5))}`).toEqual([]);
  });

  it('el caso real de los bots 240 y 223 ya no queda huerfano', () => {
    // account_ban x1 = 30 min de backoff; 69 y 64 min de silencio con un run DELAYED.
    for (const min of [64, 69]) {
      const e: EstadoCadena = { status: 'DELAYED', minSinPoll: min, bansSeguidos: 1, blockCls: 'account_ban' };
      expect(quedaHuerfano(e, SILENCIO_CRON_MIN)).toBe(false);
      expect(ensureChainActua(e, SILENCIO_CRON_MIN)).toBe(true);
    }
  });

  it('con la regla vieja esos casos SI quedaban huerfanos', () => {
    // La regla vieja: con un run DELAYED, ensure-chain devolvia cron_ok sin mirar el reloj.
    const ensureChainViejo = (e: EstadoCadena) =>
      e.status === 'DELAYED' || e.status === 'QUEUED' ? false : e.minSinPoll >= 15;
    const e: EstadoCadena = { status: 'DELAYED', minSinPoll: 69, bansSeguidos: 1, blockCls: 'account_ban' };
    expect(cronDispara(e.status)).toBe(false);
    expect(ensureChainViejo(e)).toBe(false);   // nadie actuaba
    expect(ensureChainActua(e, SILENCIO_CRON_MIN)).toBe(true);  // ahora si
  });
});

describe('los guardianes respetan los backoff legitimos', () => {
  it('nadie interrumpe un backoff que todavia corre', () => {
    for (const cls of ['account_ban', 'schedule_blocked']) {
      for (const bans of [1, 2, 3, 4]) {
        const backoffMin = blockBackoffMs(cls, bans) / 60_000;
        const dentro = Math.floor(backoffMin * 0.9);
        const e: EstadoCadena = { status: 'DELAYED', minSinPoll: dentro, bansSeguidos: bans, blockCls: cls };
        expect(ensureChainActua(e, SILENCIO_CRON_MIN),
          `cls=${cls} bans=${bans} min=${dentro}`).toBe(false);
      }
    }
  });

  it('pasado el backoff con el margen, el guardian actua', () => {
    for (const cls of ['account_ban', 'schedule_blocked']) {
      for (const bans of [1, 2, 3, 4]) {
        const backoffMin = blockBackoffMs(cls, bans) / 60_000;
        const fuera = Math.ceil(backoffMin * 1.5) + 5;
        const e: EstadoCadena = { status: 'DELAYED', minSinPoll: fuera, bansSeguidos: bans, blockCls: cls };
        expect(ensureChainActua(e, SILENCIO_CRON_MIN),
          `cls=${cls} bans=${bans} min=${fuera}`).toBe(true);
      }
    }
  });

  it('un EXECUTING que escribe se respeta', () => {
    for (const min of SILENCIOS.filter((m) => m < TECHO_EXECUTING_MIN)) {
      const e: EstadoCadena = { status: 'EXECUTING', minSinPoll: min, bansSeguidos: 0, blockCls: null };
      expect(ensureChainActua(e, SILENCIO_CRON_MIN), `min=${min}`).toBe(false);
    }
  });

  it('un EXECUTING colgado se cancela, por mas bloqueado que figure el bot', () => {
    // Un run de poll-visa vive segundos o pocos minutos y escribe mientras trabaja.
    // Media hora sin una sola fila significa trabado. Este hueco lo encontro el barrido.
    for (const min of SILENCIOS.filter((m) => m >= TECHO_EXECUTING_MIN)) {
      for (const cls of CLASES) {
        const e: EstadoCadena = { status: 'EXECUTING', minSinPoll: min, bansSeguidos: 4, blockCls: cls };
        expect(ensureChainActua(e, SILENCIO_CRON_MIN), `min=${min} cls=${cls}`).toBe(true);
      }
    }
  });
});

describe('poll-cron', () => {
  it('dispara siempre que no haya un run vivo', () => {
    for (const st of ESTADOS) {
      const vivo = st !== null && ESTADOS_VIVOS.includes(st);
      expect(cronDispara(st), `status=${st}`).toBe(!vivo);
    }
  });

  it('un EXECUTING viejo se toma por huerfano', () => {
    expect(cronDispara('EXECUTING', 60_000)).toBe(false);
    expect(cronDispara('EXECUTING', 200_000)).toBe(true);
  });
});

describe('cobertura del barrido', () => {
  it('el universo cubre el espacio completo', () => {
    const n = [...universo()].length;
    expect(n).toBe(ESTADOS.length * SILENCIOS.length * RACHAS.length * CLASES.length);
    expect(n).toBeGreaterThan(12_000);
  });

  it('el techo cubre la curva de backoff mas larga', () => {
    const peor = blockBackoffMs('schedule_blocked', 10) / 60_000 * 1.5;
    expect(TECHO_SILENCIO_MIN).toBeGreaterThanOrEqual(peor);
  });
});

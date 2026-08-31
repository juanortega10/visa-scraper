/**
 * `ensure-chain` resucita una cadena cuando la ve muerta. Para un bot cron, `activeRunId`
 * en null es normal, entonces la unica señal es la antiguedad de la fila mas nueva de
 * `poll_logs`.
 *
 * El umbral era 5 min, exactamente igual a `HEARTBEAT_MS`. Y el ahorro de escrituras de
 * `poll-logging.ts` garantiza una fila cada 5 min COMO MINIMO, con huecos observados de
 * hasta 9 min en un bot sano. Las dos condiciones casi nunca coincidian.
 *
 * Efecto medido el 2026-08-31 en prod: 80 de los ultimos 100 runs de `notify-user` eran
 * `chain_resurrected`, repartidos en 11 de los 12 bots. Toda la flota resucitada en cada
 * corrida de 10 min, y cada resurreccion disparaba un `poll-visa` que chocaba con el del
 * cron: el dedup mataba a uno y el bot perdia el turno.
 */
import { describe, it, expect } from 'vitest';
import { SILENCIO_CRON_MIN } from '../ensure-chain.js';
import { HEARTBEAT_MS } from '../../services/poll-logging.js';

const heartbeatMin = HEARTBEAT_MS / 60_000;

describe('SILENCIO_CRON_MIN contra el ahorro de escrituras', () => {
  it('queda por encima del heartbeat, que es el piso entre filas', () => {
    expect(SILENCIO_CRON_MIN).toBeGreaterThan(heartbeatMin);
  });

  it('tolera los huecos reales de un bot sano, medidos hasta 9 min', () => {
    // Bot 242 el 2026-08-31: filas cada 5 a 9 min con polls_since_prev = 6.
    expect(SILENCIO_CRON_MIN).toBeGreaterThan(9);
  });

  it('sigue detectando un bot muerto sin tardar demasiado', () => {
    // Un silencio de 30 min ya es anomalo con el cron cada 2 min.
    expect(SILENCIO_CRON_MIN).toBeLessThanOrEqual(30);
  });

  it('se deriva del heartbeat, para que no se desincronicen', () => {
    // Si alguien sube HEARTBEAT_MS, el umbral lo sigue solo. Ese acoplamiento es el
    // punto: el bug nacio de tener el 5 escrito a mano en los dos lados.
    expect(SILENCIO_CRON_MIN).toBe(heartbeatMin * 3);
  });
});

describe('a quien alcanza la comprobacion de vida', () => {
  // Antes estaba detras de `usesCron = envs.length > 1`, o sea "corre en dev Y en prod".
  // Un bot de prod tiene `["prod"]`, largo 1, entonces nunca entraba y se resucitaba
  // siempre. Ahora alcanza a cualquier bot sin run vivo.
  const alcanzaConReglaVieja = (envs: string[]) => envs.length > 1;

  it('la regla vieja dejaba fuera a los bots de un solo entorno', () => {
    expect(alcanzaConReglaVieja(['prod'])).toBe(false);
    expect(alcanzaConReglaVieja(['dev'])).toBe(false);
    expect(alcanzaConReglaVieja(['dev', 'prod'])).toBe(true);
  });
});

describe('cuando corre la comprobacion de vida', () => {
  // La condicion mira el ESTADO del run, no si el id existe. `activeCloudRunId` casi
  // siempre apunta a un run CANCELED: el dedup de `poll-visa` cancela el anterior en
  // cuanto llega el del cron siguiente, y pasa hasta en bots sanos (bots 242 y 185 el
  // 2026-08-31, con 11 de 11 runs CANCELED). Con `if (!runId)` el flujo la saltaba.
  const corre = (runId: string | null, status: string | null) =>
    !runId || (status !== 'DELAYED' && status !== 'QUEUED');

  it('corre cuando no hay run', () => {
    expect(corre(null, null)).toBe(true);
  });

  it('corre cuando el run existe pero esta terminal', () => {
    for (const st of ['CANCELED', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'EXPIRED']) {
      expect(corre('run_abc', st)).toBe(true);
    }
  });

  it('NO corre con un run pendiente, que se maneja aparte', () => {
    expect(corre('run_abc', 'DELAYED')).toBe(false);
    expect(corre('run_abc', 'QUEUED')).toBe(false);
  });

  it('el caso real: run CANCELED con id presente', () => {
    // Bot 246, run_06g5bh2s7v2ofrq2l9qp953401, CANCELED.
    const id: string | null = 'run_06g5bh2s7v2ofrq2l9qp953401';
    const corriaAntes = (r: string | null) => !r;
    expect(corriaAntes(id)).toBe(false);        // la regla vieja saltaba la comprobacion
    expect(corre(id, 'CANCELED')).toBe(true);   // la nueva si la corre
  });
});

describe('la decision de resucitar', () => {
  const resucita = (minSinFila: number) => minSinFila >= SILENCIO_CRON_MIN;

  it('un bot sano recien logueado no se resucita', () => {
    for (const min of [0, 1, 3, 5, 7, 9, 12]) {
      expect(resucita(min)).toBe(false);
    }
  });

  it('un bot realmente callado si se resucita', () => {
    for (const min of [20, 45, 90, 300]) {
      expect(resucita(min)).toBe(true);
    }
  });

  it('el umbral viejo de 5 min resucitaba a un bot sano de 6 min', () => {
    // Este es el caso exacto que rompia la flota de prod.
    expect(6 >= 5).toBe(true);          // regla vieja: resucita
    expect(resucita(6)).toBe(false);    // regla nueva: lo deja en paz
  });
});

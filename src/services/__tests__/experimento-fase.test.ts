import { describe, it, expect } from 'vitest';
import {
  asignadoAlineado, horaEpoca, resumirExperimento, textoTelegramExperimento,
  VENTANA_EXPERIMENTO, MIN_POLLS_POR_BRAZO, type FilaPoll,
} from '../experimento-fase.js';

const H = (n: number) => n * 3_600_000;
const BOTS_ESCO = [246, 298, 300, 301, 303];

describe('asignadoAlineado', () => {
  it('el MISMO bot alterna hora a hora: es su propio control', () => {
    const b = 298;
    const serie = [0, 1, 2, 3, 4, 5].map((h) => asignadoAlineado(b, H(h)));
    expect(serie).toEqual([true, false, true, false, true, false]);
  });

  it('en la misma hora conviven los DOS brazos', () => {
    // Con `hora % 2` toda la flota cambiaria a la vez, y un incidente del portal en
    // una hora caeria entero sobre un brazo. Sumar el botId lo reparte.
    for (const h of [0, 1, 2, 7, 100]) {
      const brazos = BOTS_ESCO.map((b) => asignadoAlineado(b, H(h)));
      expect(new Set(brazos).size, `hora ${h} dejo un solo brazo`).toBe(2);
    }
  });

  it('cada bot pasa la mitad de las horas en cada brazo', () => {
    for (const b of BOTS_ESCO) {
      const n = Array.from({ length: 240 }, (_, h) => asignadoAlineado(b, H(h))).filter(Boolean).length;
      expect(n).toBe(120);
    }
  });

  it('es determinista: la misma hora da el mismo brazo', () => {
    expect(asignadoAlineado(298, H(50) + 1)).toBe(asignadoAlineado(298, H(50) + 3_599_999));
    expect(asignadoAlineado(298, H(50))).not.toBe(asignadoAlineado(298, H(51)));
  });

  it('horaEpoca no se parte dentro de la hora', () => {
    expect(horaEpoca(H(9))).toBe(9);
    expect(horaEpoca(H(9) + 3_599_999)).toBe(9);
    expect(horaEpoca(H(10))).toBe(10);
  });
});

describe('la ventana del experimento sale de la medicion', () => {
  it('es-co usa s22-32, la de 3,0x, no la global de 18 s', () => {
    // s18-35 da 2,42x porque incluye s18-19 (1,72x) y s32-35 (1,92x y 1,21x).
    expect(VENTANA_EXPERIMENTO['es-co']).toEqual({ startSec: 22, endSec: 32 });
  });

  it('deja al menos 10 s, para que quepan 2 o 3 polls con jitter', () => {
    const w = VENTANA_EXPERIMENTO['es-co']!;
    expect(w.endSec - w.startSec).toBeGreaterThanOrEqual(10);
  });
});

describe('resumirExperimento', () => {
  const filas = (n: number, botId: number, hora: number, polls: number, cercanos: number): FilaPoll[] =>
    Array.from({ length: n }, () => ({ botId, enMs: H(hora), polls, cercanos }));

  it('reparte cada fila al brazo que le tocaba en SU hora', () => {
    // bot 298, hora 0 -> alineado. hora 1 -> control.
    const r = resumirExperimento([
      ...filas(1, 298, 0, 100, 10),
      ...filas(1, 298, 1, 100, 5),
    ]);
    expect(r.alineado.polls).toBe(100);
    expect(r.alineado.cercanos).toBe(10);
    expect(r.control.polls).toBe(100);
    expect(r.control.cercanos).toBe(5);
    expect(r.alineado.porMil).toBe(100);
    expect(r.control.porMil).toBe(50);
    expect(r.mejora).toBe(2);
  });

  it('sin muestra suficiente NO declara ganador', () => {
    const r = resumirExperimento([...filas(1, 298, 0, 100, 90), ...filas(1, 298, 1, 100, 1)]);
    expect(r.hayMuestra).toBe(false);
    expect(textoTelegramExperimento(r, 1)).toContain('sin veredicto');
    expect(textoTelegramExperimento(r, 1)).not.toContain('GANA');
  });

  it('con los dos brazos por encima del minimo si hay veredicto', () => {
    const n = MIN_POLLS_POR_BRAZO;
    const r = resumirExperimento([
      { botId: 298, enMs: H(0), polls: n, cercanos: 2000 },
      { botId: 298, enMs: H(1), polls: n, cercanos: 1000 },
    ]);
    expect(r.hayMuestra).toBe(true);
    expect(r.mejora).toBe(2);
    expect(textoTelegramExperimento(r, 7)).toContain('GANA');
  });

  it('un solo brazo con muestra NO alcanza', () => {
    const r = resumirExperimento([
      { botId: 298, enMs: H(0), polls: MIN_POLLS_POR_BRAZO, cercanos: 500 },
      { botId: 298, enMs: H(1), polls: 10, cercanos: 1 },
    ]);
    expect(r.hayMuestra).toBe(false);
  });

  it('sin filas no divide por cero', () => {
    const r = resumirExperimento([]);
    expect(r.mejora).toBe(0);
    expect(r.alineado.porMil).toBe(0);
    expect(textoTelegramExperimento(r, 1)).toContain('sin veredicto');
  });

  it('usa polls REALES, no cantidad de filas', () => {
    // `polls_since_prev`: la escritura reducida guarda ~6% de las filas. Contar filas
    // subestima el denominador y dispara la tasa de los dos brazos por igual, pero
    // rompe la comparacion si los brazos tienen distinta densidad de escritura.
    const r = resumirExperimento([{ botId: 298, enMs: H(0), polls: 1000, cercanos: 10 }]);
    expect(r.alineado.polls).toBe(1000);
    expect(r.alineado.porMil).toBe(10);
  });
});

describe('textoTelegramExperimento', () => {
  const conMuestra = (a: number, c: number) => resumirExperimento([
    { botId: 298, enMs: H(0), polls: MIN_POLLS_POR_BRAZO, cercanos: a },
    { botId: 298, enMs: H(1), polls: MIN_POLLS_POR_BRAZO, cercanos: c },
  ]);

  it('el veredicto va en la PRIMERA linea', () => {
    const t = textoTelegramExperimento(conMuestra(2000, 1000), 7);
    expect(t.split('\n')[0]).toContain('GANA');
  });

  it('distingue ganar, empatar y perder', () => {
    expect(textoTelegramExperimento(conMuestra(2000, 1000), 7)).toContain('GANA');
    expect(textoTelegramExperimento(conMuestra(1000, 1000), 7)).toContain('empata');
    expect(textoTelegramExperimento(conMuestra(500, 1000), 7)).toContain('PIERDE');
  });

  it('cuando falta muestra dice CUANTO falta', () => {
    const r = resumirExperimento([{ botId: 298, enMs: H(0), polls: 5000, cercanos: 50 }]);
    const t = textoTelegramExperimento(r, 1);
    expect(t).toContain('Falta muestra');
    expect(t).toContain('15.000');
  });

  it('lleva la ventana que se esta probando', () => {
    expect(textoTelegramExperimento(conMuestra(2000, 1000), 7)).toContain('s22-31');
  });
});

import { describe, it, expect } from 'vitest';
import {
  RAFAGA_LIBERACION, pollsPorMinuto, planRafaga, siguienteEnRafaga, peorLatenciaSec,
  bordeDeSubida, bordeSeMovio,
} from '../mejores-practicas.js';

/**
 * La regla de este archivo: cada caso tiene que poder ponerse rojo. Lo que se prueba es
 * que la rafaga BAJA LA LATENCIA sin subir la carga. Un test que solo comprobara "devolvio
 * segundos" dejaria pasar las dos formas de romperlo: mas peticiones, o peor latencia.
 */

const T = (s: string) => Date.parse(`2026-09-03T13:00:${s}Z`);
const segundoDe = (nowMs: number, delaySec: number) => Math.floor(nowMs / 1000 + delaySec) % 60;

describe('carga: el numero de peticiones NO cambia', () => {
  it('el intervalo de siempre da 3 por minuto', () => {
    expect(pollsPorMinuto(20)).toBe(3);
  });

  it('el plan tiene exactamente un disparo por poll', () => {
    for (const n of [1, 2, 3, 4, 6]) {
      expect(planRafaga({ inicioSec: 11, anchoSec: 10, n })).toHaveLength(n);
    }
  });

  it('dos disparos NUNCA caen en el mismo segundo', () => {
    // Serian una sola oportunidad y el doble de carga en el peor instante.
    for (const n of [3, 8, 12, 20]) {
      const p = planRafaga({ inicioSec: 11, anchoSec: 10, n });
      expect(new Set(p).size).toBe(n);
    }
  });

  it('con mas polls que ancho, las colisiones se resuelven HACIA ATRAS', () => {
    // Correrlas hacia adelante empujaria disparos mas alla del borde, a la meseta, que es
    // justo donde no sirven. Hacia atras se quedan dentro del tramo util.
    // Hacen falta MAS disparos que segundos para que haya colision de verdad: con n=5 en
    // un ancho de 5 el paso es 1 y no choca nada, y el test no distinguiria nada.
    const p = planRafaga({ inicioSec: 11, anchoSec: 5, n: 8 });
    expect(new Set(p).size).toBe(8);
    expect(Math.max(...p)).toBe(16);   // hacia adelante llegaria a s19, ya en la meseta
  });

  it('un intervalo mas largo da menos disparos, nunca mas', () => {
    expect(pollsPorMinuto(60)).toBe(1);
    expect(pollsPorMinuto(30)).toBe(2);
    expect(pollsPorMinuto(120)).toBe(1);
  });
});

describe('latencia: la rafaga le gana a la rejilla', () => {
  const { inicioSec, anchoSec } = RAFAGA_LIBERACION['es-co']!;

  it('la rafaga baja la peor latencia de 19 s a 5 s o menos', () => {
    // Es la razon de ser del cambio. Con la rejilla, una liberacion en s16 espera al
    // disparo de s34.
    const rejilla = [14, 34, 54];
    const rafaga = planRafaga({ inicioSec, anchoSec, n: 3 });
    expect(peorLatenciaSec(rejilla, inicioSec, anchoSec)).toBeGreaterThanOrEqual(15);
    expect(peorLatenciaSec(rafaga, inicioSec, anchoSec)).toBeLessThanOrEqual(4);
  });

  it('el ULTIMO disparo cierra el borde', () => {
    // Sin esto, una liberacion al final del borde espera al minuto siguiente: 52 s.
    for (const n of [1, 2, 3, 5]) {
      const p = planRafaga({ inicioSec, anchoSec, n });
      expect(p[p.length - 1]).toBe(inicioSec + anchoSec);
    }
  });

  it('ningun disparo cae ANTES del borde: ahi no hay nada que ver', () => {
    for (const n of [1, 2, 3, 5]) {
      for (const s of planRafaga({ inicioSec, anchoSec, n })) {
        expect(s).toBeGreaterThan(inicioSec);
      }
    }
  });

  it('con UN solo poll, va al final del borde y no al principio', () => {
    // Es el caso del bot 246 (1 peticion por minuto). En s11 una liberacion en s20
    // esperaria 51 s; en s21 espera 10 s como maximo.
    const p = planRafaga({ inicioSec, anchoSec, n: 1 });
    expect(p).toEqual([inicioSec + anchoSec]);
    expect(peorLatenciaSec(p, inicioSec, anchoSec)).toBe(anchoSec);
  });

  it('mas disparos en la rafaga bajan la latencia', () => {
    const l = [1, 2, 3, 5].map((n) => peorLatenciaSec(planRafaga({ inicioSec, anchoSec, n }), inicioSec, anchoSec));
    for (let i = 1; i < l.length; i++) expect(l[i]!).toBeLessThanOrEqual(l[i - 1]!);
  });

  it('un plan que cae DESPUES del borde tiene latencia pesima', () => {
    // Es lo que hacia la ventana s22-31: dentro de la meseta, y tarde.
    expect(peorLatenciaSec([22, 42, 2], inicioSec, anchoSec)).toBeGreaterThan(8);
  });

  it('la latencia se mide dando la vuelta al minuto', () => {
    // Una liberacion en s58 con un disparo en s01 son 3 s, no 57.
    expect(peorLatenciaSec([1], 58, 2)).toBe(3);
  });
});

describe('el reloj de la rafaga', () => {
  const plan = planRafaga({ inicioSec: 11, anchoSec: 10, n: 3 });

  it('aterriza en un segundo del plan', () => {
    for (let s = 0; s < 60; s++) {
      const now = T(String(s).padStart(2, '0') + '.000');
      const d = siguienteEnRafaga({ nowMs: now, plan });
      expect(plan).toContain(segundoDe(now, d));
    }
  });

  it('nunca devuelve cero ni negativo', () => {
    for (const s of plan) {
      const now = T(String(s).padStart(2, '0') + '.000');
      expect(siguienteEnRafaga({ nowMs: now, plan })).toBeGreaterThan(0);
    }
  });

  it('nunca espera mas de un minuto', () => {
    for (let s = 0; s < 60; s++) {
      const d = siguienteEnRafaga({ nowMs: T(String(s).padStart(2, '0') + '.000'), plan });
      expect(d).toBeLessThanOrEqual(60);
    }
  });

  it('una vuelta completa da EXACTAMENTE los disparos del plan por minuto', () => {
    // Es la comprobacion de carga que importa: recorrer 5 minutos no puede producir mas
    // de 3 polls en ninguno de ellos.
    let now = T('00.000');
    const porMinuto = new Map<number, number>();
    for (let i = 0; i < 20; i++) {
      const d = siguienteEnRafaga({ nowMs: now, plan });
      now += d * 1000;
      const m = Math.floor(now / 60_000);
      porMinuto.set(m, (porMinuto.get(m) ?? 0) + 1);
    }
    for (const [, n] of porMinuto) expect(n).toBeLessThanOrEqual(plan.length);
  });

  it('respeta el piso de retraso', () => {
    const now = T('10.000');
    expect(siguienteEnRafaga({ nowMs: now, plan, minSec: 25 })).toBeGreaterThanOrEqual(25);
  });

  it('el piso que cruza el minuto sigue aterrizando en el plan', () => {
    const now = T('55.000');
    const d = siguienteEnRafaga({ nowMs: now, plan, minSec: 40 });
    expect(d).toBeGreaterThanOrEqual(40);
    expect(plan).toContain(segundoDe(now, d));
  });

  it('un plan vacio no revienta', () => {
    expect(siguienteEnRafaga({ nowMs: T('10.000'), plan: [] })).toBe(60);
  });
});

describe('la ventana sale del borde, no de la meseta', () => {
  it('es-co arranca en el borde medido, no en el centro de la meseta', () => {
    // La meseta va de s13 a s33. Apuntar a su centro (s23) es llegar 10 s tarde.
    const w = RAFAGA_LIBERACION['es-co']!;
    expect(w.inicioSec).toBeGreaterThanOrEqual(9);
    expect(w.inicioSec).toBeLessThanOrEqual(14);
  });

  it('el ancho cubre el jitter del borde, sin estirarse a la meseta', () => {
    const w = RAFAGA_LIBERACION['es-co']!;
    expect(w.anchoSec).toBeGreaterThanOrEqual(6);
    expect(w.anchoSec).toBeLessThanOrEqual(14);
  });
});

describe('el centinela: donde esta el borde', () => {
  const curva = (alt: (s: number) => number, polls = 40) =>
    Array.from({ length: 60 }, (_, s) => ({ segundo: s, suave: alt(s), polls }));
  /** Meseta de `ancho` segundos que arranca en `inicio`. Es la forma real. */
  const meseta = (inicio: number, ancho = 21, alto = 110, bajo = 6) =>
    curva((s) => {
      const d = (s - inicio + 60) % 60;
      return d < ancho ? alto : bajo;
    });

  it('encuentra el borde donde arranca la meseta', () => {
    expect(bordeDeSubida(meseta(11))).toBe(11);
    expect(bordeDeSubida(meseta(25))).toBe(25);
  });

  it('el borde a caballo del cambio de minuto no se parte', () => {
    expect(bordeDeSubida(meseta(58))).toBe(58);
  });

  it('la busqueda DA LA VUELTA al minuto', () => {
    // Con el borde en s0 el valle empieza en s21, entonces hay que recorrer hasta s59 y
    // SEGUIR por s0. Una busqueda recortada en s59 devuelve null y el centinela se queda
    // mudo justo cuando el portal libera en el cambio de minuto.
    expect(bordeDeSubida(meseta(0))).toBe(0);
  });

  it('devuelve el BORDE y no el pico, con la forma real de la curva', () => {
    // La curva de verdad no es un escalon: sube de s09 a s19, hace meseta hasta s33 y
    // baja. El pico esta en la meseta, a 8 s del borde. Apuntar al pico es llegar tarde,
    // que es exactamente el error que traia la ventana s22-31.
    const real = curva((s) => {
      if (s >= 9 && s < 19) return 6 + (110 - 6) * ((s - 9) / 10);   // rampa
      if (s >= 19 && s <= 33) return 110 + (s === 26 ? 8 : 0);        // meseta con su pico
      if (s > 33 && s <= 41) return 110 - (110 - 13) * ((s - 33) / 8); // bajada
      return 6;
    });
    const b = bordeDeSubida(real);
    expect(b).not.toBeNull();
    expect(b!).toBeGreaterThanOrEqual(12);
    expect(b!).toBeLessThanOrEqual(16);   // el pico esta en s26: muy lejos de aqui
  });

  it('una curva PLANA no tiene borde: no se inventa uno', () => {
    // Un borde inventado sobre ruido moveria la flota entera al lugar equivocado.
    expect(bordeDeSubida(curva(() => 50))).toBeNull();
    expect(bordeDeSubida(curva((s) => 50 + (s % 3)))).toBeNull();
  });

  it('sin polls suficientes no hay borde', () => {
    expect(bordeDeSubida(meseta(11, 21, 110, 6).map((c) => ({ ...c, polls: 1 })))).toBeNull();
  });

  it('una curva incompleta no da borde', () => {
    expect(bordeDeSubida(meseta(11).slice(0, 40))).toBeNull();
  });

  it('el borde medido concuerda con la rafaga configurada', () => {
    const w = RAFAGA_LIBERACION['es-co']!;
    expect(bordeSeMovio(11, w)).toBe(false);
    expect(bordeSeMovio(13, w)).toBe(false);
  });

  it('un corrimiento de mas de media anchura SI se reporta', () => {
    const w = RAFAGA_LIBERACION['es-co']!;
    expect(bordeSeMovio(25, w)).toBe(true);
    expect(bordeSeMovio(40, w)).toBe(true);
  });

  it('el corrimiento se mide circularmente', () => {
    // s58 esta a 8 s de s11 dando la vuelta, no a 47.
    expect(bordeSeMovio(58, { inicioSec: 2, anchoSec: 10 })).toBe(false);
  });

  it('sin borde no se reporta corrimiento', () => {
    expect(bordeSeMovio(null, RAFAGA_LIBERACION['es-co']!)).toBe(false);
  });
});

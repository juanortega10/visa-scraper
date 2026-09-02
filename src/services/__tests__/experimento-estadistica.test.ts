import { describe, it, expect } from 'vitest';
import {
  analizar, bootstrapRazon, sobredispersion, eventosNecesarios,
  EFECTO_OBJETIVO, BLOQUES_MINIMOS,
  siguienteEnRejilla, periodoValido, periodoDesdeIntervalo, faseAleatoria,
  curvaPorSegundo, mejorVentana, type FilaSegundo,
  textoTelegramFase, huecosComparables, type ReporteFase,
  type BloqueExperimento,
} from '../experimento-estadistica.js';

/**
 * La regla de este archivo: cada caso tiene que poder ponerse rojo.
 *
 * El modo de falla que motivo todo esto NO fue una excepcion: fue un `p = 0,005` bien
 * calculado sobre la unidad equivocada. Un test que solo compruebe "devolvio un numero"
 * reproduce el bug.
 */

const HORA = 3_600_000;
function bloques(
  n: number,
  opts: { pollsPorBloque?: number; evAlineado: number; evControl: number; ruido?: number } ,
): BloqueExperimento[] {
  const out: BloqueExperimento[] = [];
  const polls = opts.pollsPorBloque ?? 200;
  for (let i = 0; i < n; i++) {
    const alineado = i % 2 === 0;
    const base = alineado ? opts.evAlineado : opts.evControl;
    // Ruido determinista, para que el bootstrap sea reproducible entre corridas.
    const r = opts.ruido ? Math.round(opts.ruido * ((i * 7919) % 11 - 5)) : 0;
    out.push({
      botId: 200 + (i % 5), horaMs: i * HORA, polls,
      eventos: Math.max(0, base + r), alineado,
    });
  }
  return out;
}

describe('muestra contada en eventos', () => {
  it('mas eventos hacen falta cuando hay mas sobredispersion', () => {
    expect(eventosNecesarios(1.2, 1)).toBeLessThan(eventosNecesarios(1.2, 6.52));
  });

  it('un efecto grande necesita menos eventos que uno chico', () => {
    expect(eventosNecesarios(1.5, 1)).toBeLessThan(eventosNecesarios(1.2, 1));
  });

  it('con Poisson puro reproduce la cifra clasica', () => {
    // (1,96 + 0,8416)^2 / ln(1,2)^2 = 237
    expect(eventosNecesarios(1.2, 1)).toBe(237);
  });

  it('la cifra del 2026-09-01 se reproduce: phi 6,52 pide 1.540 por brazo', () => {
    expect(eventosNecesarios(1.2, 6.52)).toBe(1540);
  });

  it('un efecto de 1,0 pide infinito, no un numero', () => {
    expect(eventosNecesarios(1, 1)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('sobredispersion', () => {
  it('datos Poisson dan cerca de 1', () => {
    const b = bloques(60, { evAlineado: 20, evControl: 20 });
    expect(sobredispersion(b)).toBeLessThan(1.5);
  });

  it('datos con rafagas dan mucho mas que 1', () => {
    const b = bloques(60, { evAlineado: 20, evControl: 20, ruido: 4 });
    expect(sobredispersion(b)).toBeGreaterThan(2);
  });

  it('los bloques con pocos polls se excluyen: su esperanza no significa nada', () => {
    const b: BloqueExperimento[] = [
      { botId: 1, horaMs: 0, polls: 3, eventos: 3, alineado: true },
      { botId: 1, horaMs: HORA, polls: 3, eventos: 0, alineado: false },
    ];
    expect(sobredispersion(b)).toBe(1);
  });
});

describe('bootstrap por bloque', () => {
  it('es REPRODUCIBLE: dos corridas dan el mismo intervalo', () => {
    // Un reporte diario cuyo IC baila entre corridas no se puede leer.
    const b = bloques(80, { evAlineado: 20, evControl: 25, ruido: 3 });
    expect(bootstrapRazon(b)).toEqual(bootstrapRazon(b));
  });

  it('el intervalo CONTIENE la razon puntual', () => {
    const b = bloques(80, { evAlineado: 20, evControl: 25, ruido: 3 });
    const [lo, hi] = bootstrapRazon(b);
    const r = analizar(b).razon;
    expect(lo).toBeLessThanOrEqual(r);
    expect(hi).toBeGreaterThanOrEqual(r);
  });

  it('mas ruido entre bloques ENSANCHA el intervalo', () => {
    // Es la propiedad que la formula de Poisson no tiene, y por la que se hace bootstrap.
    const [lo1, hi1] = bootstrapRazon(bloques(80, { evAlineado: 20, evControl: 25 }));
    const [lo2, hi2] = bootstrapRazon(bloques(80, { evAlineado: 20, evControl: 25, ruido: 6 }));
    expect(hi2 - lo2).toBeGreaterThan(hi1 - lo1);
  });
});

describe('veredicto', () => {
  it('con pocos bloques NO hay veredicto, aunque la razon se vea grande', () => {
    const b = bloques(BLOQUES_MINIMOS - 2, { evAlineado: 60, evControl: 10 });
    const a = analizar(b);
    expect(a.veredicto).toBe('sin-muestra');
    expect(a.ic95[1]).toBe(Number.POSITIVE_INFINITY);
  });

  it('un IC que cruza 1 es empate aunque el punto este en 0,79', () => {
    // El caso real del 2026-09-01: RR 0,787 con IC [0,508 a 1,221].
    const b = bloques(160, { evAlineado: 19, evControl: 24, ruido: 7 });
    const a = analizar(b);
    expect(a.razon).toBeLessThan(0.95);
    expect(a.ic95[0]).toBeLessThan(1);
    expect(a.ic95[1]).toBeGreaterThan(1);
    expect(a.veredicto).not.toBe('pierde');
  });

  it('CON muestra, un IC que cruza 1 es empate aunque el punto este en 0,87', () => {
    // Este es el caso que importa y el que el primer reporte declaraba ganador. La
    // razon puntual dice 0,874, o sea el alineado va 13% peor, y el intervalo cruza 1.
    // Un veredicto sacado del punto diria "pierde"; el correcto dice "empata".
    const b = bloques(400, { pollsPorBloque: 400, evAlineado: 19, evControl: 22, ruido: 5 });
    const a = analizar(b);
    expect(a.hayMuestra).toBe(true);
    expect(a.razon).toBeLessThan(1);
    expect(a.ic95[0]).toBeLessThan(1);
    expect(a.ic95[1]).toBeGreaterThan(1);
    expect(a.veredicto).toBe('empata');
  });

  it('muchos polls con pocos eventos NO alcanzan: la muestra se cuenta en eventos', () => {
    // 200.000 polls por brazo y 100 eventos. Contando polls esto pareceria de sobra, y
    // es exactamente el error del primer reporte: 20.000 polls con 230 eventos.
    const b = bloques(200, { pollsPorBloque: 2000, evAlineado: 1, evControl: 1 });
    const a = analizar(b);
    expect(a.alineado.polls).toBeGreaterThan(100_000);
    expect(a.alineado.eventos).toBeLessThan(a.eventosNecesarios);
    expect(a.veredicto).toBe('sin-muestra');
  });

  it('un brazo con muchos polls y pocos eventos NO da muestra, aunque el otro sobre', () => {
    // Guarda contra volver a contar polls en UN lado. Alineado: 100 eventos sobre
    // 200.000 polls. Control: de sobra. La muestra la fija el brazo flaco.
    const b: BloqueExperimento[] = [];
    for (let i = 0; i < 200; i++) {
      b.push({ botId: 1, horaMs: i * HORA, polls: 2000, eventos: i % 2 === 0 ? 2 : 6, alineado: i % 2 === 0 });
    }
    const a = analizar(b);
    expect(a.alineado.polls).toBeGreaterThan(100_000);
    // El brazo flaco NO llega y el gordo SI. Solo el flaco decide `hayMuestra`.
    expect(a.alineado.eventos).toBeLessThan(a.eventosNecesarios);
    expect(a.control.eventos).toBeGreaterThanOrEqual(a.eventosNecesarios);
    expect(a.hayMuestra).toBe(false);
  });

  it('un IC que excluye 1 concluye SIN esperar la muestra de 1,20', () => {
    // El caso real del 2026-09-01 medido por segundo: razon 2,834 con IC [1,999 a 4,063]
    // y 364 eventos, contra los 1.351 que pedia la cuenta para un efecto de 1,20. La
    // cuenta contesta "cuanto falta para VER 1,20"; el IC ya contesto lo que se pregunto.
    const b = bloques(60, { pollsPorBloque: 300, evAlineado: 12, evControl: 4, ruido: 2 });
    const a = analizar(b);
    expect(a.ic95[0]).toBeGreaterThan(1);
    expect(a.ic95[1]).toBeGreaterThan(a.ic95[0]);   // el intervalo tiene ancho de verdad
    expect(a.control.eventos).toBeLessThan(a.eventosNecesarios);
    expect(a.hayMuestra).toBe(false);
    expect(a.veredicto).toBe('gana');
  });

  it('un efecto grande y limpio SI se declara ganador', () => {
    const b = bloques(400, { pollsPorBloque: 400, evAlineado: 40, evControl: 20 });
    const a = analizar(b);
    expect(a.ic95[0]).toBeGreaterThan(1);
    expect(a.veredicto).toBe('gana');
  });

  it('empate REAL: el IC contiene 1 y la muestra alcanzo para ver 1,20', () => {
    const b = bloques(600, { pollsPorBloque: 400, evAlineado: 20, evControl: 20, ruido: 2 });
    const a = analizar(b);
    expect(a.hayMuestra).toBe(true);
    expect(a.ic95[0]).toBeLessThan(1);
    expect(a.ic95[1]).toBeGreaterThan(1);
    expect(a.veredicto).toBe('empata');
  });

  it('sin muestra y con el IC cruzando 1, el veredicto queda abierto', () => {
    const b = bloques(BLOQUES_MINIMOS + 4, { pollsPorBloque: 100, evAlineado: 2, evControl: 2, ruido: 1 });
    const a = analizar(b);
    expect(a.hayMuestra).toBe(false);
    expect(a.veredicto).toBe('sin-muestra');
  });

  it('un efecto grande al reves se declara perdedor', () => {
    const b = bloques(400, { pollsPorBloque: 400, evAlineado: 20, evControl: 40 });
    expect(analizar(b).veredicto).toBe('pierde');
  });

  it('la muestra exige que los DOS brazos lleguen', () => {
    // Un brazo con muchos eventos y el otro con pocos no alcanza.
    const b = bloques(400, { pollsPorBloque: 400, evAlineado: 40, evControl: 1 });
    const a = analizar(b);
    expect(a.control.eventos).toBeLessThan(a.eventosNecesarios);
    expect(a.hayMuestra).toBe(false);
  });

  it('el efecto objetivo es 1,20 y se usa para la cuenta', () => {
    const a = analizar(bloques(80, { evAlineado: 20, evControl: 20 }));
    expect(a.eventosNecesarios).toBe(eventosNecesarios(EFECTO_OBJETIVO, a.sobredispersion));
  });

  it('sin bloques no revienta', () => {
    const a = analizar([]);
    expect(a.veredicto).toBe('sin-muestra');
    expect(a.alineado.eventos).toBe(0);
  });

  it('un brazo sin polls no produce una razon infinita', () => {
    const b: BloqueExperimento[] = [
      { botId: 1, horaMs: 0, polls: 100, eventos: 5, alineado: true },
      { botId: 1, horaMs: HORA, polls: 0, eventos: 0, alineado: false },
    ];
    expect(Number.isFinite(analizar(b).razon)).toBe(true);
  });
});

describe('fase por rejilla', () => {
  const T = (s: string) => Date.parse(`2026-09-01T13:00:${s}Z`);
  const segundoDe = (nowMs: number, retrasoSec: number) =>
    Math.floor((nowMs / 1000 + retrasoSec)) % 60;

  it('el aterrizaje cae en la fase pedida', () => {
    const now = T('07.000');
    const d = siguienteEnRejilla({ nowMs: now, periodoSec: 20, faseSec: 12 });
    expect(segundoDe(now, d) % 20).toBe(12 % 20);
  });

  it('el retraso nunca pasa del periodo: no se espera un minuto', () => {
    // Es la propiedad que `alignToReleaseWindow` no tiene, y por la que costaba
    // throughput: alli el retraso podia llegar a 60 s.
    for (let s = 0; s < 60; s++) {
      const d = siguienteEnRejilla({ nowMs: T(String(s).padStart(2, '0') + '.000'), periodoSec: 20, faseSec: 5 });
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(20);
    }
  });

  it('el intervalo entre aterrizajes es EXACTAMENTE el periodo', () => {
    // Throughput identico al natural. Sin esta propiedad los dos brazos no son comparables.
    let now = T('03.000');
    const saltos: number[] = [];
    for (let i = 0; i < 10; i++) {
      const d = siguienteEnRejilla({ nowMs: now, periodoSec: 15, faseSec: 8 });
      saltos.push(d);
      now += d * 1000;
    }
    // El primero ajusta la fase; del segundo en adelante el paso es constante.
    expect(saltos.slice(1)).toEqual(Array(9).fill(15));
  });

  it('nunca devuelve cero, ni cuando ahora YA esta en la rejilla', () => {
    const now = T('20.000');   // 20 es punto de la rejilla con periodo 20 y fase 0
    expect(siguienteEnRejilla({ nowMs: now, periodoSec: 20, faseSec: 0 })).toBe(20);
  });

  it('respeta el piso de retraso', () => {
    const now = T('01.000');
    const d = siguienteEnRejilla({ nowMs: now, periodoSec: 20, faseSec: 2, minSec: 10 });
    expect(d).toBeGreaterThanOrEqual(10);
  });

  it('una fase fraccionaria se redondea al segundo', () => {
    // Sin redondear, el aterrizaje queda a mitad de segundo y el analisis por segundo
    // reparte el mismo poll entre dos baldes.
    const now = T('00.000');
    const d = siguienteEnRejilla({ nowMs: now, periodoSec: 20, faseSec: 5.4 });
    expect(Number.isInteger(d)).toBe(true);
    expect(d).toBe(siguienteEnRejilla({ nowMs: now, periodoSec: 20, faseSec: 5 }));
  });

  it('una fase fuera de rango aterriza en los mismos instantes', () => {
    const now = T('00.000');
    expect(siguienteEnRejilla({ nowMs: now, periodoSec: 20, faseSec: 45 }))
      .toBe(siguienteEnRejilla({ nowMs: now, periodoSec: 20, faseSec: 5 }));
    expect(siguienteEnRejilla({ nowMs: now, periodoSec: 20, faseSec: -15 }))
      .toBe(siguienteEnRejilla({ nowMs: now, periodoSec: 20, faseSec: 5 }));
  });

  it('solo los divisores de 60 sirven para fijar la fase', () => {
    expect(periodoValido(20)).toBe(true);
    expect(periodoValido(30)).toBe(true);
    expect(periodoValido(23)).toBe(false);
    expect(periodoValido(0)).toBe(false);
    expect(periodoValido(20.5)).toBe(false);
  });

  it('con un periodo que NO divide a 60 el segundo se corre minuto a minuto', () => {
    // Por eso `periodoValido` existe. Con 23 s los aterrizajes no repiten segundo.
    let now = T('00.000');
    const segundos = new Set<number>();
    for (let i = 0; i < 6; i++) {
      const d = siguienteEnRejilla({ nowMs: now, periodoSec: 23, faseSec: 4 });
      segundos.add(segundoDe(now, d));
      now += d * 1000;
    }
    expect(segundos.size).toBeGreaterThan(3);
  });

  it('el periodo elegido NUNCA aumenta la carga', () => {
    // Un periodo mas corto que el natural son mas polls por minuto contra el portal, y
    // asi se gana un bloqueo de cuenta.
    for (const nat of [6, 9, 11, 20, 21, 30, 45, 59, 61]) {
      expect(periodoDesdeIntervalo(nat)).toBeGreaterThanOrEqual(Math.min(nat, 60));
    }
    expect(periodoDesdeIntervalo(20)).toBe(20);
    expect(periodoDesdeIntervalo(21)).toBe(30);
    expect(periodoDesdeIntervalo(9)).toBe(10);
  });

  it('el periodo elegido siempre divide a 60', () => {
    for (let nat = 1; nat <= 70; nat++) expect(periodoValido(periodoDesdeIntervalo(nat))).toBe(true);
  });
});

describe('fase sorteada por minuto', () => {
  const base = Date.parse('2026-09-01T13:00:00Z');

  it('es estable dentro del mismo minuto', () => {
    const a = faseAleatoria(301, base + 1_000, 20);
    const b = faseAleatoria(301, base + 59_000, 20);
    expect(a).toBe(b);
  });

  it('cambia de un minuto al siguiente', () => {
    const seq = Array.from({ length: 12 }, (_, i) => faseAleatoria(301, base + i * 60_000, 20));
    expect(new Set(seq).size).toBeGreaterThan(3);
  });

  it('dos bots del mismo minuto no comparten fase siempre', () => {
    // Si compartieran, todos los bots aterrizarian en el mismo segundo y una rafaga del
    // portal caeria entera sobre una sola fase.
    const seq = [246, 298, 300, 301, 303].map((b) => faseAleatoria(b, base, 20));
    expect(new Set(seq).size).toBeGreaterThan(1);
  });

  it('siempre cae dentro del periodo', () => {
    for (let i = 0; i < 400; i++) {
      const f = faseAleatoria(300 + (i % 7), base + i * 60_000, 20);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(20);
    }
  });

  it('cubre TODO el periodo a lo largo del dia', () => {
    // Sin cobertura completa no se puede estimar la curva por segundo.
    const vistos = new Set<number>();
    for (let i = 0; i < 1440; i++) vistos.add(faseAleatoria(301, base + i * 60_000, 20));
    expect(vistos.size).toBe(20);
  });

  it('reparte parejo: ninguna fase se lleva mas del doble de lo esperado', () => {
    const cuenta = new Array(20).fill(0);
    for (let i = 0; i < 4000; i++) cuenta[faseAleatoria(301, base + i * 60_000, 20)]! += 1;
    const esperado = 4000 / 20;
    for (const c of cuenta) {
      expect(c).toBeGreaterThan(esperado * 0.5);
      expect(c).toBeLessThan(esperado * 2);
    }
  });
});

describe('curva por segundo', () => {
  const plano = (porSeg: number, ev: number): FilaSegundo[] =>
    Array.from({ length: 60 }, (_, s) => ({ segundo: s, polls: porSeg, eventos: ev }));

  it('una curva plana sale plana', () => {
    const c = curvaPorSegundo(plano(100, 5));
    expect(c).toHaveLength(60);
    for (const p of c) expect(p.suave).toBeCloseTo(50, 1);
  });

  it('un pico se conserva despues de suavizar', () => {
    const filas = plano(100, 5);
    filas[25]!.eventos = 40;
    const c = curvaPorSegundo(filas);
    const pico = c.reduce((a, b) => (b.suave > a.suave ? b : a));
    expect(pico.segundo).toBeGreaterThanOrEqual(23);
    expect(pico.segundo).toBeLessThanOrEqual(27);
  });

  it('el suavizado es CIRCULAR: el pico del segundo 58 alcanza al 0', () => {
    // El segundo 59 y el 0 son vecinos. Con suavizado lineal, el balde 0 solo ve hacia
    // adelante y un pico al final del minuto nunca lo toca. El pico va SOLO en 58 y 59
    // a proposito: si tambien estuviera en 0, un suavizado recortado tambien lo veria.
    const filas = plano(100, 2);
    filas[58]!.eventos = 40;
    filas[59]!.eventos = 40;
    const c = curvaPorSegundo(filas);
    const base = c[30]!.suave;
    expect(c[0]!.suave).toBeGreaterThan(base * 1.5);
    expect(c[1]!.suave).toBeGreaterThan(base * 1.2);
    // Y el 30 sigue en la linea base: el suavizado no contamina todo el minuto.
    expect(base).toBeLessThan(30);
  });

  it('el suavizado pesa por POLLS, no por balde', () => {
    // Un balde con 10 polls no puede mover la curva igual que uno con 1.000.
    const filas = plano(1000, 10);
    filas[30] = { segundo: 30, polls: 10, eventos: 10 };  // tasa 1000 por mil, con 10 polls
    const c = curvaPorSegundo(filas);
    // La vecindad tiene 4.010 polls y 50 eventos: la tasa suave queda cerca de 12, no de 200.
    expect(c[30]!.suave).toBeLessThan(30);
  });

  it('un segundo sin polls no produce NaN', () => {
    const filas: FilaSegundo[] = [{ segundo: 5, polls: 100, eventos: 3 }];
    const c = curvaPorSegundo(filas);
    for (const p of c) {
      expect(Number.isFinite(p.porMil)).toBe(true);
      expect(Number.isFinite(p.suave)).toBe(true);
    }
  });

  it('segundos fuera de rango se normalizan al minuto', () => {
    const c = curvaPorSegundo([{ segundo: 65, polls: 100, eventos: 5 }]);
    expect(c[5]!.polls).toBe(100);
  });

  it('la mejor ventana encuentra el pico', () => {
    const filas = plano(200, 2);
    for (const s of [24, 25, 26, 27, 28, 29]) filas[s]!.eventos = 20;
    const v = mejorVentana(curvaPorSegundo(filas), 6);
    expect(v).not.toBeNull();
    expect(v!.startSec).toBeGreaterThanOrEqual(23);
    expect(v!.startSec).toBeLessThanOrEqual(25);
  });

  it('la mejor ventana puede cruzar el cambio de minuto', () => {
    // El pico arranca EN 59 y sigue en 0, 1 y 2. Solo una busqueda circular puede
    // devolver 59 como arranque; una recortada devolveria 0 y perderia un cuarto del pico.
    // Los cuatro segundos del pico llevan cuentas DISTINTAS a proposito. Con cuentas
    // iguales, una busqueda recortada que repite el balde 59 cuatro veces da la misma
    // tasa que la circular, y el test no distingue nada.
    const filas = plano(200, 2);
    filas[59]!.eventos = 10;
    filas[0]!.eventos = 40;
    filas[1]!.eventos = 40;
    filas[2]!.eventos = 40;
    const v = mejorVentana(curvaPorSegundo(filas), 4);
    expect(v!.startSec).toBe(59);
    expect(v!.endSec).toBe(3);
  });

  it('sin polls suficientes NO devuelve ventana: un pico sobre nada es ruido', () => {
    const filas = plano(2, 1);
    expect(mejorVentana(curvaPorSegundo(filas), 6, 500)).toBeNull();
  });

  it('un ancho invalido devuelve null', () => {
    const c = curvaPorSegundo(plano(200, 5));
    expect(mejorVentana(c, 0)).toBeNull();
    expect(mejorVentana(c, 61)).toBeNull();
  });
});

describe('mensaje diario de fase', () => {
  const anal = (evD: number, evF: number, pollsD = 300, pollsF = 300, ruido = 2) => {
    const b: BloqueExperimento[] = [];
    for (let i = 0; i < 120; i++) {
      const al = i % 2 === 0;
      const r = Math.round(ruido * ((i * 7919) % 11 - 5));
      b.push({ botId: 1, horaMs: i * 3_600_000, polls: al ? pollsD : pollsF,
        eventos: Math.max(0, (al ? evD : evF) + r), alineado: al });
    }
    return analizar(b);
  };
  const rep = (o: Partial<ReporteFase> = {}): ReporteFase => ({
    dias: 14,
    curva: curvaPorSegundo(Array.from({ length: 60 }, (_, s) => ({ segundo: s, polls: 200, eventos: 4 }))),
    configurada: { ventana: { startSec: 22, endSec: 32 }, analisis: anal(30, 10) },
    mejor: null,
    huecoDentroSec: 90, huecoFueraSec: 85,
    ...o,
  });

  it('huecos parecidos son comparables', () => {
    expect(huecosComparables(90, 85)).toBe(true);
    expect(huecosComparables(85, 90)).toBe(true);
  });

  it('huecos al doble NO son comparables', () => {
    // El caso real: 177 s dentro contra 85 s fuera.
    expect(huecosComparables(177, 85)).toBe(false);
  });

  it('el sesgo se detecta en LOS DOS sentidos', () => {
    // Huecos de dentro mas CORTOS enmascaran el efecto en vez de inflarlo, y tambien
    // invalidan la comparacion.
    expect(huecosComparables(40, 90)).toBe(false);
    expect(huecosComparables(90, 40)).toBe(false);
  });

  it('entradas imposibles no se declaran comparables', () => {
    expect(huecosComparables(90, 0)).toBe(false);
    expect(huecosComparables(NaN, 85)).toBe(false);
    expect(huecosComparables(90, NaN)).toBe(false);
  });

  it('con huecos sucios el titulo AVISA y pide no decidir', () => {
    // Aunque el veredicto diga "gana". Es lo que faltaba el 2026-09-01.
    const t = textoTelegramFase(rep({ huecoDentroSec: 177, huecoFueraSec: 85 }));
    expect(t).toMatch(/contaminada/);
    expect(t).toMatch(/No decidas/);
    expect(t).not.toMatch(/GANA/);
  });

  it('con huecos limpios y un IC que excluye 1, dice que gana', () => {
    const t = textoTelegramFase(rep());
    expect(t).toMatch(/GANA/);
    expect(t).not.toMatch(/contaminada/);
  });

  it('siempre lleva la razon Y su intervalo', () => {
    const t = textoTelegramFase(rep());
    expect(t).toMatch(/razon [\d.]+  IC95 \[/);
  });

  it('sin muestra dice cuantos eventos faltan de cada lado', () => {
    const t = textoTelegramFase(rep({ configurada: { ventana: { startSec: 22, endSec: 32 }, analisis: anal(2, 2, 100, 100, 1) } }));
    expect(t).toMatch(/sin veredicto/);
    expect(t).toMatch(/Faltan eventos/);
  });

  it('la mejor ventana se marca como elegida mirando los datos', () => {
    // Sin esa marca, una cifra inflada por la busqueda parece un hallazgo.
    const t = textoTelegramFase(rep({ mejor: { ventana: { startSec: 21, endSec: 31 }, analisis: anal(30, 10) } }));
    expect(t).toMatch(/mejor ventana medida s21-30/);
    expect(t).toMatch(/sirve para proponer, no para concluir/);
  });

  it('cabe en una notificacion', () => {
    const t = textoTelegramFase(rep({ huecoDentroSec: 177, huecoFueraSec: 85, mejor: { ventana: { startSec: 21, endSec: 31 }, analisis: anal(30, 10) } }));
    expect(t.split('\n').length).toBeLessThanOrEqual(16);
  });
});

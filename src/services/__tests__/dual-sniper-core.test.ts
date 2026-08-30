import { describe, it, expect } from 'vitest';
import {
  toMin, inWindow, buildPairs, rankCandidates, computePhase, movingRoles,
  verifyCandidate, rankCasDates, effectiveConfig, currentGapMin, inPreferred,
  type SniperConfig, type GroupState, type Candidate, type CasPick,
} from '../dual-sniper-core.js';

const CFG: SniperConfig = {
  windowStart: '2026-09-01',
  windowEnd: '2026-09-15',
  gapMaxMin: 60,
  rescueGapMaxMin: 480,
  gapIdealMin: 15,
  casInWindowRequired: false,
};
const TODAY = '2026-08-24';

const cas = (date: string): CasPick => ({ date, time: '07:00', inWindow: inWindow(date, CFG) });

function parents(over: Partial<GroupState> = {}): GroupState {
  return { role: 'PARENTS', consularDate: '2027-02-24', consularTime: '08:00', maxReschedules: null, rescheduleCount: 0, ...over };
}
function children(over: Partial<GroupState> = {}): GroupState {
  return { role: 'CHILDREN', consularDate: '2027-02-11', consularTime: '09:45', maxReschedules: null, rescheduleCount: 0, ...over };
}
function cand(over: Partial<Candidate> = {}): Candidate {
  return {
    date: '2026-09-10', parentsTime: '08:00', childrenTime: '08:15', gapMin: 15,
    parentsCas: cas('2026-09-03'), childrenCas: cas('2026-09-03'), ...over,
  };
}

describe('toMin', () => {
  it('convierte HH:MM a minutos', () => {
    expect(toMin('00:00')).toBe(0);
    expect(toMin('09:45')).toBe(585);
    expect(toMin('23:59')).toBe(1439);
  });
  it('rechaza formatos invalidos', () => {
    expect(() => toMin('9:45')).toThrow();
    expect(() => toMin('0945')).toThrow();
    expect(() => toMin('24:00')).toThrow();
    expect(() => toMin('10:60')).toThrow();
  });
});

describe('inWindow', () => {
  it('los bordes son inclusivos', () => {
    expect(inWindow('2026-09-01', CFG)).toBe(true);
    expect(inWindow('2026-09-15', CFG)).toBe(true);
  });
  it('rechaza fuera de rango y nulos', () => {
    expect(inWindow('2026-08-31', CFG)).toBe(false);
    expect(inWindow('2026-09-16', CFG)).toBe(false);
    expect(inWindow(null, CFG)).toBe(false);
    expect(inWindow('basura', CFG)).toBe(false);
  });
});

describe('buildPairs', () => {
  it('acepta la misma hora exacta para los dos grupos', () => {
    // El caso real del 2026-09-15: una sola hora, la misma para los dos grupos.
    // Los padres no quedan despues, entonces es un par valido con gap 0.
    expect(buildPairs('2026-09-15', ['10:15'], ['10:15'], CFG))
      .toEqual([{ p: '10:15', c: '10:15', gapMin: 0 }]);
  });
  it('rechaza ninos antes que padres', () => {
    expect(buildPairs('2026-09-10', ['10:15'], ['09:00'], CFG)).toEqual([]);
  });
  it('prefiere el gap 0 al ordenar', () => {
    const list = [
      cand({ date: '2026-09-09', parentsTime: '08:00', childrenTime: '08:15', gapMin: 15 }),
      cand({ date: '2026-09-11', parentsTime: '09:00', childrenTime: '09:00', gapMin: 0 }),
    ];
    expect(rankCandidates(list)[0]!.gapMin).toBe(0);
  });

  it('rechaza gap mayor al techo', () => {
    expect(buildPairs('2026-09-10', ['08:00'], ['09:01'], CFG)).toEqual([]);
    expect(buildPairs('2026-09-10', ['08:00'], ['09:00'], CFG)).toHaveLength(1);
  });
  it('devuelve todos los pares validos del dia', () => {
    const pairs = buildPairs('2026-09-10', ['08:00', '09:00'], ['08:15', '09:30'], CFG);
    expect(pairs).toEqual([
      { p: '08:00', c: '08:15', gapMin: 15 },
      { p: '09:00', c: '09:30', gapMin: 30 },
    ]);
  });
});

describe('rankCandidates', () => {
  it('prefiere el gap menor, luego la fecha temprana', () => {
    const list = [
      cand({ date: '2026-09-02', parentsTime: '08:00', childrenTime: '08:45', gapMin: 45 }),
      cand({ date: '2026-09-09', parentsTime: '08:00', childrenTime: '08:15', gapMin: 15 }),
      cand({ date: '2026-09-04', parentsTime: '10:00', childrenTime: '10:15', gapMin: 15 }),
    ];
    const [best, second, third] = rankCandidates(list);
    expect(best!.date).toBe('2026-09-04');
    expect(second!.date).toBe('2026-09-09');
    expect(third!.gapMin).toBe(45);
  });
});

describe('computePhase', () => {
  it('PAIR cuando ninguno esta en la ventana', () => {
    expect(computePhase(parents(), children(), CFG)).toBe('PAIR');
  });
  it('CHILD_ONLY cuando solo los padres entraron', () => {
    expect(computePhase(parents({ consularDate: '2026-09-10', consularTime: '08:00' }), children(), CFG))
      .toBe('CHILD_ONLY');
  });
  it('PARENT_ONLY cuando solo los ninos entraron', () => {
    expect(computePhase(parents(), children({ consularDate: '2026-09-10', consularTime: '08:00' }), CFG))
      .toBe('PARENT_ONLY');
  });
  it('DONE solo si mismo dia, padres antes y gap dentro del techo', () => {
    const p = parents({ consularDate: '2026-09-10', consularTime: '08:00' });
    expect(computePhase(p, children({ consularDate: '2026-09-10', consularTime: '08:15' }), CFG)).toBe('DONE');
    // mismo dia pero ninos primero → sigue siendo trabajo pendiente
    expect(computePhase(p, children({ consularDate: '2026-09-10', consularTime: '07:00' }), CFG)).toBe('PAIR');
    // misma hora exacta = objetivo cumplido
    expect(computePhase(p, children({ consularDate: '2026-09-10', consularTime: '08:00' }), CFG)).toBe('DONE');
    // mismo dia con gap de 61 min: quedo junto, entonces es DONE bajo el techo de rescate
    expect(computePhase(p, children({ consularDate: '2026-09-10', consularTime: '09:01' }), CFG)).toBe('DONE');
    // mismo dia pero 9 horas despues: pasa el techo de rescate, sigue habiendo trabajo
    expect(computePhase(p, children({ consularDate: '2026-09-10', consularTime: '17:00' }), CFG)).toBe('PAIR');
    // dias distintos dentro de la ventana
    expect(computePhase(p, children({ consularDate: '2026-09-11', consularTime: '08:15' }), CFG)).toBe('PAIR');
  });
});

describe('movingRoles', () => {
  it('mapea la fase a los grupos que se mueven', () => {
    expect(movingRoles('PAIR')).toEqual(['PARENTS', 'CHILDREN']);
    expect(movingRoles('CHILD_ONLY')).toEqual(['CHILDREN']);
    expect(movingRoles('PARENT_ONLY')).toEqual(['PARENTS']);
  });
});

describe('verifyCandidate', () => {
  it('acepta el candidato bueno', () => {
    expect(verifyCandidate(cand(), parents(), children(), 'PAIR', CFG, TODAY)).toEqual([]);
  });

  it('V1 rechaza fuera de la ventana aunque el gap sea perfecto', () => {
    const c = cand({ date: '2026-09-16', parentsCas: cas('2026-09-14'), childrenCas: cas('2026-09-14') });
    const fails = verifyCandidate(c, parents(), children(), 'PAIR', CFG, TODAY);
    expect(fails.some((f) => f.startsWith('V1'))).toBe(true);
  });

  it('V3 rechaza ninos antes que padres', () => {
    const c = cand({ parentsTime: '09:00', childrenTime: '08:00', gapMin: -60 });
    const fails = verifyCandidate(c, parents(), children(), 'PAIR', CFG, TODAY);
    expect(fails.some((f) => f.startsWith('V3'))).toBe(true);
  });

  it('V3 acepta la misma hora exacta', () => {
    const c = cand({ parentsTime: '10:15', childrenTime: '10:15', gapMin: 0 });
    expect(verifyCandidate(c, parents(), children(), 'PAIR', CFG, TODAY)).toEqual([]);
  });

  it('V4 detecta un gap declarado que no coincide con el real', () => {
    const c = cand({ parentsTime: '08:00', childrenTime: '08:15', gapMin: 5 });
    const fails = verifyCandidate(c, parents(), children(), 'PAIR', CFG, TODAY);
    expect(fails.some((f) => f.startsWith('V4'))).toBe(true);
  });

  it('V4 rechaza el gap por encima del techo', () => {
    const c = cand({ parentsTime: '08:00', childrenTime: '09:01', gapMin: 61 });
    const fails = verifyCandidate(c, parents(), children(), 'PAIR', CFG, TODAY);
    expect(fails.some((f) => f.startsWith('V4'))).toBe(true);
  });

  it('V5 rechaza mover a una fecha igual o posterior a la actual', () => {
    // Ambos grupos tienen su cita el 2026-08-30, fuera de la ventana. El candidato
    // del 2026-09-10 es mas TARDE, entonces perderian dias. V5 debe frenarlo.
    const c = cand({ date: '2026-09-10' });
    const p = parents({ consularDate: '2026-08-30', consularTime: '08:00' });
    const ch = children({ consularDate: '2026-08-30', consularTime: '09:00' });
    const fails = verifyCandidate(c, p, ch, 'PAIR', CFG, TODAY);
    expect(fails.filter((f) => f.startsWith('V5'))).toHaveLength(2);
  });

  it('V5 exime la fecha igual solo porque el grupo ya esta en la ventana', () => {
    // La cita actual del grupo cae dentro de la ventana. Mover al mismo dia sirve
    // para alinear la hora con el otro grupo, entonces V5 no aplica.
    const c = cand({ date: '2026-09-10' });
    const p = parents({ consularDate: '2026-09-10', consularTime: '08:00' });
    expect(verifyCandidate(c, p, children(), 'PAIR', CFG, TODAY).filter((f) => f.startsWith('V5'))).toEqual([]);
  });

  it('V5 rechaza un dia mas tarde de la ventana para un grupo que sigue afuera', () => {
    const c = cand({ date: '2026-09-15', parentsTime: '08:00', childrenTime: '08:15', gapMin: 15 });
    const ch = children({ consularDate: '2026-09-14', consularTime: '09:00' });
    // Los ninos tienen su cita el 14, fuera... no: el 14 esta DENTRO de la ventana.
    expect(inWindow(ch.consularDate, CFG)).toBe(true);
    // Con la cita el 2026-08-25, que si esta afuera, el 15 de septiembre es mas tarde.
    const ch2 = children({ consularDate: '2026-08-25', consularTime: '09:00' });
    const fails = verifyCandidate(c, parents(), ch2, 'PAIR', CFG, TODAY);
    expect(fails.some((f) => f.startsWith('V5') && f.includes('CHILDREN'))).toBe(true);
  });

  it('V5 permite mover un grupo que YA esta en la ventana, para alinear la hora', () => {
    // Padres ya el 2026-09-10 08:00. El par bueno es el 2026-09-12, mas tarde que su cita.
    const p = parents({ consularDate: '2026-09-10', consularTime: '08:00' });
    const c = cand({ date: '2026-09-12' });
    const fails = verifyCandidate(c, p, children(), 'PAIR', CFG, TODAY);
    expect(fails.filter((f) => f.startsWith('V5'))).toEqual([]);
  });

  it('V5 no revisa al grupo que no se mueve', () => {
    const p = parents({ consularDate: '2026-09-10', consularTime: '08:00' });
    const fails = verifyCandidate(cand({ date: '2026-09-10' }), p, children(), 'CHILD_ONLY', CFG, TODAY);
    expect(fails.filter((f) => f.startsWith('V5'))).toEqual([]);
  });

  it('V6 rechaza una fecha pasada o de hoy', () => {
    const wide = { ...CFG, windowStart: '2026-08-01', windowEnd: '2026-09-15' };
    const c = cand({ date: TODAY, parentsCas: cas('2026-08-20'), childrenCas: cas('2026-08-20') });
    const fails = verifyCandidate(c, parents(), children(), 'PAIR', wide, TODAY);
    expect(fails.some((f) => f.startsWith('V6'))).toBe(true);
  });

  it('V7 rechaza si el grupo agoto sus reagendamientos', () => {
    const p = parents({ maxReschedules: 3, rescheduleCount: 3 });
    const fails = verifyCandidate(cand(), p, children(), 'PAIR', CFG, TODAY);
    expect(fails.some((f) => f.startsWith('V7') && f.includes('PARENTS'))).toBe(true);
  });

  it('V7 ignora al grupo que no se mueve', () => {
    const p = parents({ maxReschedules: 3, rescheduleCount: 3, consularDate: '2026-09-10', consularTime: '08:00' });
    const fails = verifyCandidate(cand({ date: '2026-09-10' }), p, children(), 'CHILD_ONLY', CFG, TODAY);
    expect(fails.filter((f) => f.startsWith('V7'))).toEqual([]);
  });

  it('V8 rechaza el muro CAS: cero dias de CAS', () => {
    const c = cand({ childrenCas: null });
    const fails = verifyCandidate(c, parents(), children(), 'PAIR', CFG, TODAY);
    expect(fails.some((f) => f.startsWith('V8') && f.includes('CHILDREN'))).toBe(true);
  });

  it('V8 exige la CAS en ventana solo si esta configurado asi', () => {
    const c = cand({ parentsCas: cas('2026-08-28'), childrenCas: cas('2026-08-28') });
    expect(verifyCandidate(c, parents(), children(), 'PAIR', CFG, TODAY).filter((f) => f.startsWith('V8'))).toEqual([]);
    const strict = { ...CFG, casInWindowRequired: true };
    expect(verifyCandidate(c, parents(), children(), 'PAIR', strict, TODAY).filter((f) => f.startsWith('V8'))).toHaveLength(2);
  });

  it('V9 rechaza la CAS despues del consular', () => {
    const c = cand({ date: '2026-09-05', parentsCas: cas('2026-09-10'), childrenCas: cas('2026-09-03') });
    const fails = verifyCandidate(c, parents(), children(), 'PAIR', CFG, TODAY);
    expect(fails.some((f) => f.startsWith('V9') && f.includes('PARENTS'))).toBe(true);
  });

  it('V9 rechaza la CAS en el pasado', () => {
    const c = cand({ parentsCas: cas('2026-08-01'), childrenCas: cas('2026-09-03') });
    const fails = verifyCandidate(c, parents(), children(), 'PAIR', CFG, TODAY);
    expect(fails.some((f) => f.startsWith('V9') && f.includes('PARENTS'))).toBe(true);
  });

  it('acumula varios fallos a la vez', () => {
    const c = cand({ date: '2026-10-01', parentsTime: '10:00', childrenTime: '09:00', gapMin: 99, childrenCas: null });
    const fails = verifyCandidate(c, parents(), children(), 'PAIR', CFG, TODAY);
    expect(fails.length).toBeGreaterThanOrEqual(4);
  });
});

describe('rankCasDates', () => {
  it('prefiere la ventana y dentro de ella la mas tardia', () => {
    const r = rankCasDates(['2026-08-20', '2026-09-03', '2026-09-12'], CFG, null);
    expect(r[0]).toBe('2026-09-12');
    expect(r[1]).toBe('2026-09-03');
    expect(r[2]).toBe('2026-08-20');
  });
  it('pone primero la fecha preferida del otro grupo', () => {
    const r = rankCasDates(['2026-09-03', '2026-09-12'], CFG, '2026-09-03');
    expect(r[0]).toBe('2026-09-03');
  });
  it('descarta las de fuera de ventana si es obligatoria', () => {
    const strict = { ...CFG, casInWindowRequired: true };
    expect(rankCasDates(['2026-08-20', '2026-09-03'], strict, null)).toEqual(['2026-09-03']);
    expect(rankCasDates(['2026-08-20'], strict, null)).toEqual([]);
  });
});

describe('effectiveConfig', () => {
  it('en PAIR manda el techo normal', () => {
    expect(effectiveConfig(CFG, 'PAIR').gapMaxMin).toBe(60);
  });
  it('en rescate manda el techo de rescate', () => {
    expect(effectiveConfig(CFG, 'CHILD_ONLY').gapMaxMin).toBe(480);
    expect(effectiveConfig(CFG, 'PARENT_ONLY').gapMaxMin).toBe(480);
  });
  it('el rescate acepta un par que el modo normal rechaza', () => {
    // Padres anclados 08:00, el unico cupo de los ninos ese dia es 11:00 (180 min).
    expect(buildPairs('2026-09-10', ['08:00'], ['11:00'], effectiveConfig(CFG, 'PAIR'))).toEqual([]);
    expect(buildPairs('2026-09-10', ['08:00'], ['11:00'], effectiveConfig(CFG, 'CHILD_ONLY')))
      .toEqual([{ p: '08:00', c: '11:00', gapMin: 180 }]);
  });
  it('ni siquiera el rescate acepta ninos antes que padres', () => {
    expect(buildPairs('2026-09-10', ['11:00'], ['08:00'], effectiveConfig(CFG, 'CHILD_ONLY'))).toEqual([]);
  });
  it('V4 usa el techo de la fase', () => {
    const c = cand({ parentsTime: '08:00', childrenTime: '11:00', gapMin: 180 });
    const p = parents({ consularDate: '2026-09-10', consularTime: '08:00' });
    const fails = verifyCandidate(c, p, children(), 'CHILD_ONLY', effectiveConfig(CFG, 'CHILD_ONLY'), TODAY);
    expect(fails.filter((f) => f.startsWith('V4'))).toEqual([]);
  });
});

describe('currentGapMin', () => {
  it('devuelve el gap cuando estan el mismo dia', () => {
    const p = parents({ consularDate: '2026-09-10', consularTime: '08:00' });
    const ch = children({ consularDate: '2026-09-10', consularTime: '10:30' });
    expect(currentGapMin(p, ch)).toBe(150);
  });
  it('devuelve null en dias distintos', () => {
    const p = parents({ consularDate: '2026-09-10', consularTime: '08:00' });
    const ch = children({ consularDate: '2026-09-11', consularTime: '08:15' });
    expect(currentGapMin(p, ch)).toBeNull();
  });
});

describe('sub-rango preferido', () => {
  const PREF: SniperConfig = { ...CFG, windowStart: '2026-09-16', windowEnd: '2026-09-30',
    preferStart: '2026-09-21', preferEnd: '2026-09-30' };

  it('inPreferred marca solo el sub-rango', () => {
    expect(inPreferred('2026-09-21', PREF)).toBe(true);
    expect(inPreferred('2026-09-30', PREF)).toBe(true);
    expect(inPreferred('2026-09-20', PREF)).toBe(false);
    expect(inPreferred('2026-09-16', PREF)).toBe(false);
    expect(inPreferred('2026-09-25', CFG)).toBe(false);  // sin sub-rango configurado
  });

  it('un par en el sub-rango gana aunque tenga peor gap', () => {
    const list = [
      cand({ date: '2026-09-16', parentsTime: '09:45', childrenTime: '09:45', gapMin: 0 }),
      cand({ date: '2026-09-29', parentsTime: '08:45', childrenTime: '09:30', gapMin: 45 }),
    ];
    expect(rankCandidates(list, PREF)[0]!.date).toBe('2026-09-29');
  });

  it('dentro del sub-rango sigue mandando el gap menor', () => {
    const list = [
      cand({ date: '2026-09-22', parentsTime: '08:00', childrenTime: '08:45', gapMin: 45 }),
      cand({ date: '2026-09-29', parentsTime: '08:45', childrenTime: '08:45', gapMin: 0 }),
    ];
    expect(rankCandidates(list, PREF)[0]!.date).toBe('2026-09-29');
  });

  it('sin config el orden es solo por gap, como antes', () => {
    const list = [
      cand({ date: '2026-09-29', parentsTime: '08:45', childrenTime: '09:30', gapMin: 45 }),
      cand({ date: '2026-09-16', parentsTime: '09:45', childrenTime: '09:45', gapMin: 0 }),
    ];
    expect(rankCandidates(list)[0]!.date).toBe('2026-09-16');
  });

  it('la ventana de aceptacion sigue siendo la que manda', () => {
    // 2026-09-16 esta fuera del preferido pero DENTRO de la ventana: es aceptable.
    const c = cand({ date: '2026-09-16', parentsCas: cas('2026-09-14'), childrenCas: cas('2026-09-14') });
    expect(verifyCandidate(c, parents(), children(), 'PAIR', PREF, TODAY).filter((f) => f.startsWith('V1'))).toEqual([]);
    // 2026-09-15 esta fuera de la ventana: se rechaza.
    const c2 = cand({ date: '2026-09-15', parentsCas: cas('2026-09-14'), childrenCas: cas('2026-09-14') });
    expect(verifyCandidate(c2, parents(), children(), 'PAIR', PREF, TODAY).some((f) => f.startsWith('V1'))).toBe(true);
  });
});

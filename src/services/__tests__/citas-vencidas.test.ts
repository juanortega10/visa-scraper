import { describe, it, expect } from 'vitest';
import {
  evaluarCitaVencida, ordenarHallazgos, resumir, textoTelegram, diasEntre,
  POLLS_RUIDOSO, DIAS_VIEJA,
  type EntradaCitaVencida,
} from '../citas-vencidas.js';

/**
 * Los 16 bots REALES que la flota tenia el 2026-08-31, con sus polls reales de 24 h
 * (`SUM(polls_since_prev)`). Se usan como fixture para que el test falle si alguien
 * cambia la regla de tal forma que este caso concreto deje de salir.
 *
 * Ninguno de estos aparecia en `audit-blind-bots.ts`: ese script busca bots que
 * pollean SIN ver fechas, y estos si ven fechas, solo que ninguna les sirve.
 */
const HOY = '2026-08-31';
const FLOTA_REAL: EntradaCitaVencida[] = [
  // `polls24h` es SUM(polls_since_prev), o sea polls REALES, no filas de poll_logs.
  // La escritura reducida solo guarda ~6% de los polls, entonces contar filas
  // subestima el gasto entre 2x y 6x segun el bot.
  { botId: 261, locale: 'es-co', status: 'active', cita: '2026-08-24', polls24h: 4377, agencia: null },
  { botId: 292, locale: 'es-co', status: 'active', cita: '2026-08-28', polls24h: 4130, agencia: null },
  { botId: 285, locale: 'es-co', status: 'active', cita: '2026-08-21', polls24h: 3896, agencia: null },
  { botId: 179, locale: 'es-co', status: 'active', cita: '2026-06-22', polls24h: 1886, agencia: 'VisasOK' },
  { botId: 180, locale: 'es-co', status: 'active', cita: '2026-06-15', polls24h: 1829, agencia: 'VisasOK' },
  { botId: 114, locale: 'es-co', status: 'active', cita: '2026-06-16', polls24h: 1800, agencia: null },
  { botId: 240, locale: 'es-co', status: 'active', cita: '2026-07-23', polls24h: 1463, agencia: null },
  { botId: 269, locale: 'es-co', status: 'active', cita: '2026-08-13', polls24h: 1137, agencia: null },
  { botId: 185, locale: 'es-co', status: 'active', cita: '2026-06-15', polls24h: 426,  agencia: 'VisasOK' },
  { botId: 242, locale: 'es-co', status: 'active', cita: '2026-08-12', polls24h: 379,  agencia: 'VisasOK' },
  { botId: 105, locale: 'es-co', status: 'active', cita: '2026-06-15', polls24h: 349,  agencia: null },
  { botId: 235, locale: 'es-co', status: 'active', cita: '2026-08-04', polls24h: 277,  agencia: null },
  { botId: 94,  locale: 'es-co', status: 'active', cita: '2026-06-10', polls24h: 252,  agencia: null },
  { botId: 66,  locale: 'es-co', status: 'active', cita: '2026-06-02', polls24h: 231,  agencia: null },
  { botId: 107, locale: 'es-co', status: 'active', cita: '2026-06-15', polls24h: 217,  agencia: null },
  { botId: 219, locale: 'es-co', status: 'active', cita: '2026-06-29', polls24h: 201,  agencia: 'VisasOK' },
];
/** Polls reales de TODA la flota en esas mismas 24 h. */
const FLOTA_TOTAL = 50251;


const evaluarTodos = (filas: EntradaCitaVencida[], hoy = HOY) =>
  filas.map((f) => evaluarCitaVencida(f, hoy)).filter((x) => x !== null);

describe('diasEntre', () => {
  it('cuenta dias enteros en UTC', () => {
    expect(diasEntre('2026-08-01', '2026-08-31')).toBe(30);
    expect(diasEntre('2026-08-31', '2026-08-31')).toBe(0);
    expect(diasEntre('2026-09-05', '2026-08-31')).toBe(-5);
  });

  it('no se corre por la zona horaria del que corre el test', () => {
    // `new Date('2026-08-31')` sin Z se lee como hora LOCAL en algunos runtimes y en
    // Bogota se corre 5 h, o sea un dia entero cerca de medianoche. Ver CLAUDE.md.
    expect(diasEntre('2026-08-30', '2026-08-31')).toBe(1);
    expect(diasEntre('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('una fecha basura da 0 en vez de NaN', () => {
    expect(diasEntre('no-es-fecha', HOY)).toBe(0);
  });
});

describe('evaluarCitaVencida', () => {
  it('los 16 bots reales del 2026-08-31 salen TODOS', () => {
    expect(evaluarTodos(FLOTA_REAL)).toHaveLength(16);
  });

  it('una cita futura NO sale', () => {
    const f = { ...FLOTA_REAL[0]!, cita: '2027-01-15' };
    expect(evaluarCitaVencida(f, HOY)).toBeNull();
  });

  it('la cita de HOY todavia no esta vencida', () => {
    // El borde importa: una cita hoy sigue siendo asistible, y avisar por ella seria
    // un falso positivo el mismo dia en que el cliente va al consulado.
    expect(evaluarCitaVencida({ ...FLOTA_REAL[0]!, cita: HOY }, HOY)).toBeNull();
    expect(evaluarCitaVencida({ ...FLOTA_REAL[0]!, cita: '2026-08-30' }, HOY)).not.toBeNull();
  });

  it('un bot PAUSADO no sale: pausarlo es la respuesta correcta', () => {
    // Sin esto, el correo llegaria cada dia con los mismos bots ya atendidos y nadie
    // lo leeria. Es la diferencia entre un detector y ruido.
    for (const st of ['paused', 'invalid_credentials', 'completed']) {
      expect(evaluarCitaVencida({ ...FLOTA_REAL[0]!, status: st }, HOY)).toBeNull();
    }
    expect(evaluarCitaVencida({ ...FLOTA_REAL[0]!, status: 'error' }, HOY)).not.toBeNull();
  });

  it('un bot sin cita no sale', () => {
    expect(evaluarCitaVencida({ ...FLOTA_REAL[0]!, cita: null }, HOY)).toBeNull();
  });
});

describe('severidad', () => {
  it('el GASTO manda sobre la antiguedad', () => {
    // Bot 292: vencida hace 3 dias, 4.130 polls al dia. Bot 66: vencida hace 90 dias,
    // 231 polls. El que hace dano AHORA es el 292, porque cada peticion inutil acerca
    // al portal a cerrar la ruta de toda la cuenta.
    const b292 = evaluarCitaVencida(FLOTA_REAL.find((f) => f.botId === 292)!, HOY)!;
    const b66 = evaluarCitaVencida(FLOTA_REAL.find((f) => f.botId === 66)!, HOY)!;
    expect(b292.severidad).toBe('critico');
    expect(b66.severidad).toBe('alto');
    expect(b292.diasVencida).toBeLessThan(b66.diasVencida);
  });

  it('el umbral de polls es el que separa critico de lo demas', () => {
    const base = { ...FLOTA_REAL[0]!, cita: '2026-08-30' };
    expect(evaluarCitaVencida({ ...base, polls24h: POLLS_RUIDOSO }, HOY)!.severidad).toBe('critico');
    expect(evaluarCitaVencida({ ...base, polls24h: POLLS_RUIDOSO - 1 }, HOY)!.severidad).toBe('medio');
  });

  it('el umbral de dias separa alto de medio cuando el gasto es bajo', () => {
    const base = { ...FLOTA_REAL[0]!, polls24h: 10 };
    const viejo = new Date(Date.parse(`${HOY}T00:00:00Z`) - DIAS_VIEJA * 86_400_000).toISOString().slice(0, 10);
    expect(evaluarCitaVencida({ ...base, cita: viejo }, HOY)!.severidad).toBe('alto');
    expect(evaluarCitaVencida({ ...base, cita: '2026-08-30' }, HOY)!.severidad).toBe('medio');
  });

  it('los 11 criticos reales son los que pasan de 300 polls', () => {
    const criticos = evaluarTodos(FLOTA_REAL).filter((f) => f.severidad === 'critico').map((f) => f.botId).sort((a, b) => a - b);
    expect(criticos).toEqual([105, 114, 179, 180, 185, 240, 242, 261, 269, 285, 292]);
  });
});

describe('ordenarHallazgos', () => {
  it('el que mas gasta va primero, sin importar cuando vencio', () => {
    const orden = ordenarHallazgos(evaluarTodos(FLOTA_REAL));
    expect(orden[0]!.botId).toBe(261);   // 4.377 polls, vencida hace 7 dias
    expect(orden[1]!.botId).toBe(292);   // 4.130, vencida hace 3
    expect(orden[2]!.botId).toBe(285);   // 3.896
  });

  it('no muta el arreglo que recibe', () => {
    const filas = evaluarTodos(FLOTA_REAL);
    const antes = filas.map((f) => f.botId);
    ordenarHallazgos(filas);
    expect(filas.map((f) => f.botId)).toEqual(antes);
  });
});

describe('resumir', () => {
  it('reproduce las cifras reales del 2026-08-31', () => {
    // 22.850 polls de los 16 sobre 50.251 de la flota entera = 45,5%. Ese numero es
    // el que justifico pausarlos, entonces tiene que ser reproducible.
    const r = resumir(evaluarTodos(FLOTA_REAL), FLOTA_TOTAL);
    expect(r.total).toBe(16);
    expect(r.criticos).toBe(11);
    expect(r.pollsDesperdiciados).toBe(22850);
    expect(r.porcentajeDeFlota).toBeCloseTo(45.5, 1);
  });

  it('con la flota en cero no divide por cero', () => {
    expect(resumir(evaluarTodos(FLOTA_REAL), 0).porcentajeDeFlota).toBe(0);
  });
});

describe('textoTelegram', () => {
  it('cabe en una notificacion: 8 lineas como maximo', () => {
    const filas = evaluarTodos(FLOTA_REAL);
    const t = textoTelegram(filas, resumir(filas, FLOTA_TOTAL));
    expect(t.split('\n').filter((l) => /^[🔴🟠🟡]/u.test(l))).toHaveLength(8);
    expect(t).toContain('y 8 mas');
  });

  it('lleva el total y los criticos, que es lo que decide si abres el correo', () => {
    const filas = evaluarTodos(FLOTA_REAL);
    const t = textoTelegram(filas, resumir(filas, FLOTA_TOTAL));
    expect(t).toContain('16 bots con la cita vencida');
    expect(t).toContain('11 criticos');
  });

  it('el mas caro sale de primero, tambien en Telegram', () => {
    const filas = evaluarTodos(FLOTA_REAL);
    const t = textoTelegram(filas, resumir(filas, FLOTA_TOTAL));
    const primera = t.split('\n').find((l) => /^[🔴🟠🟡]/u.test(l))!;
    expect(primera).toContain('bot 261');
  });

  it('sin hallazgos devuelve cadena vacia, para no mandar un mensaje vacio', () => {
    expect(textoTelegram([], resumir([], 100))).toBe('');
  });

  it('marca al dueno cuando es de una agencia', () => {
    const filas = evaluarTodos(FLOTA_REAL.filter((f) => f.agencia === 'VisasOK'));
    const t = textoTelegram(filas, resumir(filas, FLOTA_TOTAL));
    expect(t).toContain('VisasOK');
  });
});

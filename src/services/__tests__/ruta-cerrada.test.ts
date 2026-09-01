import { describe, it, expect } from 'vitest';
import {
  detectarRutasCerradas, textoRutaCerrada, MINUTOS_ALERTA, MINUTOS_CRITICO,
  type FilaBloqueo,
} from '../ruta-cerrada.js';

/**
 * La regla de este archivo: cada caso tiene que poder ponerse rojo.
 *
 * El corte que motivo el detector duro 17,4 h con el bot `active` y `updated_at`
 * fresco. Un test que solo compruebe "devolvio un arreglo" reproduce esa ceguera.
 */

const AHORA = Date.parse('2026-09-01T12:00:00Z');
const haceMin = (m: number) => AHORA - m * 60_000;

function fila(p: Partial<FilaBloqueo> & { botId: number; enMs: number }): FilaBloqueo {
  return {
    locale: 'es-pe', scheduleId: '75610929', status: 'tcp_blocked', cls: 'schedule_blocked',
    ...p,
  };
}

describe('deteccion de ruta cerrada', () => {
  it('un corte de 3 h avisa en alto', () => {
    const r = detectarRutasCerradas([
      fila({ botId: 299, enMs: haceMin(180) }),
      fila({ botId: 299, enMs: haceMin(20) }),
    ], AHORA);
    expect(r).toHaveLength(1);
    expect(r[0]!.severidad).toBe('alto');
    expect(r[0]!.minutos).toBe(180);
    expect(r[0]!.polls).toBe(2);
  });

  it('un corte de 7 h es critico', () => {
    const r = detectarRutasCerradas([fila({ botId: 299, enMs: haceMin(420) })], AHORA);
    expect(r[0]!.severidad).toBe('critico');
  });

  it('la duracion se mide contra AHORA, no contra la fila mas nueva', () => {
    // Con la curva larga (240 a 720 min) pasan horas entre dos polls. Si esto midiera
    // de fila a fila, un corte de 10 h con una sola fila reportaria 0 minutos y el
    // detector callaria justo en el caso peor.
    const r = detectarRutasCerradas([fila({ botId: 299, enMs: haceMin(600) })], AHORA);
    expect(r).toHaveLength(1);
    expect(r[0]!.minutos).toBe(600);
  });

  it('30 minutos no avisan: la sonda ya reintenta antes de declarar el bloqueo', () => {
    expect(detectarRutasCerradas([fila({ botId: 299, enMs: haceMin(30) })], AHORA)).toHaveLength(0);
  });

  it('el umbral se respeta en el borde exacto', () => {
    expect(detectarRutasCerradas([fila({ botId: 1, enMs: haceMin(MINUTOS_ALERTA) })], AHORA)).toHaveLength(1);
    expect(detectarRutasCerradas([fila({ botId: 1, enMs: haceMin(MINUTOS_ALERTA - 1) })], AHORA)).toHaveLength(0);
    const c = detectarRutasCerradas([fila({ botId: 1, enMs: haceMin(MINUTOS_CRITICO) })], AHORA);
    expect(c[0]!.severidad).toBe('critico');
  });

  it('si la fila MAS NUEVA ya no esta bloqueada, no avisa', () => {
    // El corte se resolvio solo. Avisar de esto entrena a no leer el aviso.
    const r = detectarRutasCerradas([
      fila({ botId: 299, enMs: haceMin(500) }),
      fila({ botId: 299, enMs: haceMin(400) }),
      fila({ botId: 299, enMs: haceMin(5), status: 'ok', cls: null }),
    ], AHORA);
    expect(r).toHaveLength(0);
  });

  it('un poll bueno EN MEDIO corta el episodio: solo cuenta el tramo actual', () => {
    const r = detectarRutasCerradas([
      fila({ botId: 299, enMs: haceMin(600) }),
      fila({ botId: 299, enMs: haceMin(500), status: 'ok', cls: null }),
      fila({ botId: 299, enMs: haceMin(90) }),
    ], AHORA);
    expect(r[0]!.minutos).toBe(90);
    expect(r[0]!.polls).toBe(1);
  });

  it('account_ban NO es ruta cerrada: es otro problema y otro backoff', () => {
    const r = detectarRutasCerradas([
      fila({ botId: 299, enMs: haceMin(300), cls: 'account_ban' }),
    ], AHORA);
    expect(r).toHaveLength(0);
  });

  it('un error comun tampoco cuenta', () => {
    const r = detectarRutasCerradas([
      fila({ botId: 299, enMs: haceMin(300), status: 'error', cls: null }),
    ], AHORA);
    expect(r).toHaveLength(0);
  });

  it('la clasificacion sola no basta: el status tiene que ser tcp_blocked', () => {
    // `deriveBlockClassification` escribe `blockClassification` en cuanto hay bytes de
    // socket, tambien en filas que NO son bloqueo. Mirar solo la clasificacion
    // convertiria un poll normal con ruido de red en un corte de la ruta.
    const r = detectarRutasCerradas([
      fila({ botId: 299, enMs: haceMin(300), status: 'ok' }),
    ], AHORA);
    expect(r).toHaveLength(0);
  });

  it('sin filas devuelve vacio', () => {
    expect(detectarRutasCerradas([], AHORA)).toEqual([]);
  });

  it('dos bots del mismo schedule salen en UNA sola ruta', () => {
    const r = detectarRutasCerradas([
      fila({ botId: 299, enMs: haceMin(120) }),
      fila({ botId: 7, enMs: haceMin(200) }),
    ], AHORA);
    expect(r).toHaveLength(1);
    expect(r[0]!.bots).toEqual([7, 299]);
    // El episodio empieza con el primer bot que vio caer la ruta.
    expect(r[0]!.minutos).toBe(200);
    expect(r[0]!.polls).toBe(2);
  });

  it('dos schedules distintos son dos rutas, la mas larga primero', () => {
    const r = detectarRutasCerradas([
      fila({ botId: 1, scheduleId: 'A', enMs: haceMin(90) }),
      fila({ botId: 2, scheduleId: 'B', enMs: haceMin(400) }),
    ], AHORA);
    expect(r.map((x) => x.scheduleId)).toEqual(['B', 'A']);
  });

  it('un bot sin scheduleId no se mezcla con los demas', () => {
    const r = detectarRutasCerradas([
      fila({ botId: 1, scheduleId: null, enMs: haceMin(90) }),
      fila({ botId: 2, scheduleId: null, enMs: haceMin(90) }),
    ], AHORA);
    expect(r).toHaveLength(2);
  });
});

describe('texto de Telegram', () => {
  it('nombra el schedule, los bots y las horas', () => {
    const r = detectarRutasCerradas([fila({ botId: 299, enMs: haceMin(420) })], AHORA);
    const t = textoRutaCerrada(r);
    expect(t).toContain('75610929');
    expect(t).toContain('299');
    expect(t).toContain('7.0 h');
    expect(t).toMatch(/nginx 444/);
  });

  it('dice que cambiar de IP no sirve: es el error que se comete', () => {
    const r = detectarRutasCerradas([fila({ botId: 299, enMs: haceMin(90) })], AHORA);
    expect(textoRutaCerrada(r)).toMatch(/NO sirve/);
  });

  it('con muchas rutas corta la lista y dice cuantas faltan', () => {
    const filas = Array.from({ length: 9 }, (_, i) =>
      fila({ botId: i + 1, scheduleId: `S${i}`, enMs: haceMin(100 + i) }));
    expect(textoRutaCerrada(detectarRutasCerradas(filas, AHORA))).toContain('y 3 mas');
  });
});

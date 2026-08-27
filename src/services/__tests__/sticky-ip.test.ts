import { describe, it, expect } from 'vitest';

/**
 * La IP pegajosa vive en `proxy-fetch.ts` y depende de undici, entonces el test
 * fija la REGLA con la misma implementacion, para que nadie la afloje sin darse
 * cuenta. Los numeros vienen de la medicion del 2026-08-27:
 * tunel frio 823 ms p50, tunel vivo 105 ms.
 */
const TTL = 90_000;

function crearSelector() {
  const sticky = new Map<string, { url: string; at: number }>();
  let rotaciones = 0;
  const elegir = (urls: string[], key?: string, ahora = 0) => {
    if (key) {
      const p = sticky.get(key);
      if (p && ahora - p.at < TTL && urls.includes(p.url)) return p.url;
      if (p) sticky.delete(key);
    }
    rotaciones += 1;
    const url = urls[rotaciones % urls.length]!;
    if (key) sticky.set(key, { url, at: ahora });
    return url;
  };
  const soltar = (key?: string) => { if (key) sticky.delete(key); };
  return { elegir, soltar, get rotaciones() { return rotaciones; } };
}

const IPS = ['ip-a', 'ip-b', 'ip-c', 'ip-d', 'ip-e'];

describe('IP pegajosa por run', () => {
  it('el camino critico completo sale por UNA sola IP', () => {
    const s = crearSelector();
    const key = 'run-1';
    const usadas = new Set<string>();
    // days.json → times.json → cas days → cas times → POST
    for (let i = 0; i < 5; i++) usadas.add(s.elegir(IPS, key, i * 400));
    expect(usadas.size).toBe(1);
    expect(s.rotaciones).toBe(1);
  });

  it('sin clave, cada peticion abre un tunel nuevo (comportamiento viejo)', () => {
    const s = crearSelector();
    for (let i = 0; i < 5; i++) s.elegir(IPS, undefined, i * 400);
    expect(s.rotaciones).toBe(5);
  });

  it('dos runs distintos no comparten IP forzosamente', () => {
    const s = crearSelector();
    const a = s.elegir(IPS, 'run-a', 0);
    const b = s.elegir(IPS, 'run-b', 0);
    expect(s.rotaciones).toBe(2);
    expect(typeof a).toBe('string');
    expect(typeof b).toBe('string');
  });

  it('un fallo suelta la IP y la siguiente eleccion rota de verdad', () => {
    const s = crearSelector();
    const key = 'run-2';
    const primera = s.elegir(IPS, key, 0);
    s.soltar(key);
    const segunda = s.elegir(IPS, key, 100);
    expect(s.rotaciones).toBe(2);
    expect(segunda).not.toBe(primera);
  });

  it('al vencer el TTL vuelve a rotar', () => {
    const s = crearSelector();
    const key = 'run-3';
    s.elegir(IPS, key, 0);
    s.elegir(IPS, key, TTL - 1);
    expect(s.rotaciones).toBe(1);
    s.elegir(IPS, key, TTL + 1);
    expect(s.rotaciones).toBe(2);
  });

  it('si la IP pegada ya no esta en el pool, rota', () => {
    const s = crearSelector();
    const key = 'run-4';
    const pegada = s.elegir(IPS, key, 0);
    const sinEsa = IPS.filter((u) => u !== pegada);
    s.elegir(sinEsa, key, 100);
    expect(s.rotaciones).toBe(2);
  });
});

import { describe, it, expect } from 'vitest';
import { alignToReleaseWindow, getReleaseWindow } from '../scheduling.js';

/** Instante con un segundo del minuto exacto, para leer los casos sin ambiguedad. */
const at = (sec: number, ms = 0) => Date.UTC(2026, 7, 27, 12, 30, sec, ms);
const secOf = (ms: number) => Math.floor(ms / 1000) % 60;

describe('getReleaseWindow', () => {
  it('es-pe libera temprano y en tramo angosto', () => {
    expect(getReleaseWindow('es-pe')).toEqual({ startSec: 13, endSec: 26 });
  });
  it('es-co libera mas tarde y mas ancho', () => {
    expect(getReleaseWindow('es-co')).toEqual({ startSec: 18, endSec: 36 });
  });
  it('un locale sin medicion no tiene ventana', () => {
    expect(getReleaseWindow('fr-ca')).toBeNull();
    expect(getReleaseWindow(undefined)).toBeNull();
  });
});

describe('alignToReleaseWindow', () => {
  it('sin ventana medida devuelve el intervalo tal cual', () => {
    const r = alignToReleaseWindow({ locale: 'fr-ca', baseSeconds: 20, nowMs: at(50) });
    expect(r).toEqual({ seconds: 20, aligned: false });
  });

  it('si el poll natural ya cae dentro, no toca nada', () => {
    // es-pe, ventana 13-26. Ahora s10 + 6s = s16, dentro.
    const r = alignToReleaseWindow({ locale: 'es-pe', baseSeconds: 6, nowMs: at(10) });
    expect(r).toEqual({ seconds: 6, aligned: false });
  });

  it('si cae fuera, salta al inicio de la proxima ventana', () => {
    // Ahora s30 + 6s = s36, fuera. Debe ir al s13 del minuto siguiente.
    const now = at(30);
    const r = alignToReleaseWindow({ locale: 'es-pe', baseSeconds: 6, nowMs: now });
    expect(r.aligned).toBe(true);
    expect(secOf(now + r.seconds * 1000)).toBe(13);
  });

  it('el poll siempre termina dentro de la ventana', () => {
    for (let sec = 0; sec < 60; sec++) {
      const now = at(sec);
      const r = alignToReleaseWindow({ locale: 'es-pe', baseSeconds: 6, nowMs: now });
      const s = secOf(now + r.seconds * 1000);
      expect(s, `arrancando en s${sec}`).toBeGreaterThanOrEqual(13);
      expect(s, `arrancando en s${sec}`).toBeLessThan(26);
    }
  });

  it('lo mismo para es-co con su intervalo de 20s', () => {
    for (let sec = 0; sec < 60; sec++) {
      const now = at(sec);
      const r = alignToReleaseWindow({ locale: 'es-co', baseSeconds: 20, nowMs: now });
      const s = secOf(now + r.seconds * 1000);
      expect(s, `arrancando en s${sec}`).toBeGreaterThanOrEqual(18);
      expect(s, `arrancando en s${sec}`).toBeLessThan(36);
    }
  });

  it('nunca espera menos de 1 segundo', () => {
    for (let sec = 0; sec < 60; sec++) {
      const r = alignToReleaseWindow({ locale: 'es-pe', baseSeconds: 1, nowMs: at(sec) });
      expect(r.seconds).toBeGreaterThanOrEqual(1);
    }
  });

  it('nunca espera mas de 60 s mas el intervalo', () => {
    for (let sec = 0; sec < 60; sec++) {
      const r = alignToReleaseWindow({ locale: 'es-pe', baseSeconds: 6, nowMs: at(sec) });
      expect(r.seconds).toBeLessThanOrEqual(66);
    }
  });

  it('en regimen, es-pe da 3 polls por minuto, todos dentro de la ventana', () => {
    let t = at(0);
    const secs: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = alignToReleaseWindow({ locale: 'es-pe', baseSeconds: 6, nowMs: t });
      t += r.seconds * 1000;
      secs.push(secOf(t));
    }
    expect(secs.every((s) => s >= 13 && s < 26)).toBe(true);
    // 13, 19, 25, luego salta al 13 del minuto siguiente
    expect(secs.slice(0, 3)).toEqual([13, 19, 25]);
  });
});

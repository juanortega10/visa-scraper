/**
 * Frontera de observabilidad del API.
 *
 * El 30 de agosto de 2026 un 400 dejo a una agencia bloqueada 40 minutos sin
 * una sola linea de log. Estas pruebas fijan el contrato que lo impide, y cada
 * una nombra el fallo concreto que atrapa.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { requestLog, newRequestId } from './request-log.js';

function appConLog() {
  const app = new Hono();
  app.use('/api/*', requestLog());
  app.get('/api/ok', (c) => c.json({ ok: true }));
  // Reproduce validateCreateBot: retorna 400 sin registrar nada por su cuenta.
  app.post('/api/bots', (c) => c.json({ error: 'visaPassword is required' }, 400));
  app.get('/api/boom', (c) => c.json({ error: 'Internal server error' }, 500));
  app.post('/api/secreto', (c) =>
    c.json({ error: 'bad', visaPassword: 'VALOR-FALSO-DE-PRUEBA-no-es-una-clave', token: 'VALOR-FALSO-DE-PRUEBA-no-es-un-token' }, 400));
  return app;
}

let logged: string[] = [];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logged = [];
  spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(String(a[0])); });
});
afterEach(() => spy.mockRestore());

const lineas = () => logged.filter((l) => l.startsWith('[api] '));
const parse = (l: string) => JSON.parse(l.slice('[api] '.length));

describe('requestLog', () => {
  it('un 400 sin log propio deja una linea con el motivo', async () => {
    const res = await appConLog().request('/api/bots', { method: 'POST', body: '{}' });

    expect(res.status).toBe(400);
    expect(lineas()).toHaveLength(1);
    const l = parse(lineas()[0]!);
    expect(l.route).toBe('POST /api/bots');
    expect(l.status).toBe(400);
    expect(l.lvl).toBe('warn');
    // Lo que faltaba el 30 de agosto: el motivo, no solo el estado.
    expect(l.error).toContain('visaPassword is required');
  });

  it('un 500 sube el nivel a error', async () => {
    await appConLog().request('/api/boom');
    expect(parse(lineas()[0]!).lvl).toBe('error');
  });

  it('una respuesta buena no ensucia el log', async () => {
    const res = await appConLog().request('/api/ok');
    expect(res.status).toBe(200);
    expect(lineas()).toHaveLength(0);
  });

  it('nunca escribe contrasenas ni tokens en el log', async () => {
    await appConLog().request('/api/secreto', { method: 'POST', body: '{}' });

    const crudo = lineas()[0]!;
    expect(crudo).not.toContain('VALOR-FALSO-DE-PRUEBA-no-es-una-clave');
    expect(crudo).not.toContain('VALOR-FALSO-DE-PRUEBA-no-es-un-token');
    expect(crudo).toContain('[oculto]');
  });

  it('respeta el request id que manda el navegador', async () => {
    const res = await appConLog().request('/api/bots', {
      method: 'POST', body: '{}', headers: { 'X-Request-Id': 'ABC123-XY' },
    });

    expect(res.headers.get('X-Request-Id')).toBe('ABC123-XY');
    expect(parse(lineas()[0]!).req).toBe('ABC123-XY');
  });

  it.each([
    ['con espacios', 'id con espacios'],
    ['demasiado largo', 'x'.repeat(200)],
    ['demasiado corto', 'ab'],
    ['con comillas', 'id"raro"'],
  ])('rechaza un request id %s y genera el suyo', async (_caso, malo) => {
    // Un id libre deja inyectar basura en el log y romper el parseo.
    const res = await appConLog().request('/api/bots', {
      method: 'POST', body: '{}', headers: { 'X-Request-Id': malo },
    });

    const devuelto = res.headers.get('X-Request-Id')!;
    expect(devuelto).not.toBe(malo);
    expect(devuelto).toMatch(/^[A-Z0-9]+-[A-Z0-9]+$/);
  });

  it('devuelve el request id tambien cuando todo sale bien', async () => {
    // Sin esto el navegador no puede citar el id al reportar un problema.
    const res = await appConLog().request('/api/ok');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('el cuerpo del cliente sigue intacto despues de leerlo para el log', async () => {
    // peekBody clona la respuesta. Si consumiera el original, el navegador
    // recibiria un cuerpo vacio y el error volveria a ser invisible.
    const res = await appConLog().request('/api/bots', { method: 'POST', body: '{}' });
    expect(await res.json()).toEqual({ error: 'visaPassword is required' });
  });

  it('el id es unico entre llamadas', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newRequestId()));
    expect(ids.size).toBe(500);
  });
});

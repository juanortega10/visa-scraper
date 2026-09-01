import { describe, it, expect } from 'vitest';
import {
  evaluarVision, textoVision, HORAS_PENDIENTE_VIEJO,
  type EstadoVision, type ProveedorVision,
} from '../salud-vision.js';

/**
 * La regla de este archivo: cada caso tiene que poder ponerse rojo.
 *
 * El modo de falla que motivo todo esto devolvia HTTP 200 y no leia nada durante
 * trece dias. Un test que solo compruebe "no lanzo excepcion" reproduce el bug en
 * vez de atraparlo.
 */

const arriba = (nombre: string): ProveedorVision => ({ nombre, ok: true, detalle: 'responde' });
const caido = (nombre: string, detalle: string): ProveedorVision => ({ nombre, ok: false, detalle });

function estado(p: ProveedorVision[], pend: Partial<EstadoVision['pendientes']> = {}): EstadoVision {
  return { proveedores: p, pendientes: { total: 0, conUrl: 0, masViejoHoras: 0, ...pend } };
}

describe('salud de la lectura de imagenes', () => {
  it('cero proveedores arriba es CRITICO: toda imagen que llegue ahora se pierde', () => {
    const v = evaluarVision(estado([caido('vercel-gateway', 'HTTP 402 insufficient_funds')]));
    expect(v.alerta).toBe(true);
    expect(v.severidad).toBe('critico');
    expect(v.arriba).toBe(0);
  });

  it('una lista VACIA de proveedores es critica, no silencio', () => {
    // Este es el caso que costo $589.800. Una sonda que no probo nada NO es una sonda
    // que dijo "todo bien". Si este test pasa a verde con `alerta: false`, el detector
    // volvio a ser ciego.
    const v = evaluarVision(estado([]));
    expect(v.alerta).toBe(true);
    expect(v.severidad).toBe('critico');
    expect(v.motivo).toMatch(/no pudo probar/);
  });

  it('un proveedor arriba alcanza: la cadena lee con uno solo', () => {
    const v = evaluarVision(estado([
      caido('vercel-gateway', 'HTTP 402'),
      arriba('anthropic-directo'),
    ]));
    expect(v.alerta).toBe(false);
    expect(v.arriba).toBe(1);
    expect(v.caidos).toHaveLength(1);
  });

  it('todo arriba y sin pendientes calla', () => {
    expect(evaluarVision(estado([arriba('a'), arriba('b')])).alerta).toBe(false);
  });

  it('pendientes VIEJOS con los proveedores arriba avisan en alto', () => {
    const v = evaluarVision(estado([arriba('a')], { total: 4, conUrl: 4, masViejoHoras: 50 }));
    expect(v.alerta).toBe(true);
    expect(v.severidad).toBe('alto');
    expect(v.motivo).toContain('4 medios');
  });

  it('pendientes RECIENTES no avisan: pueden ser de hace un minuto', () => {
    const v = evaluarVision(estado([arriba('a')], { total: 3, conUrl: 3, masViejoHoras: 2 }));
    expect(v.alerta).toBe(false);
  });

  it('el umbral de antiguedad se respeta en el borde exacto', () => {
    const justo = estado([arriba('a')], { total: 1, conUrl: 1, masViejoHoras: HORAS_PENDIENTE_VIEJO });
    const antes = estado([arriba('a')], { total: 1, conUrl: 1, masViejoHoras: HORAS_PENDIENTE_VIEJO - 1 });
    expect(evaluarVision(justo).alerta).toBe(true);
    expect(evaluarVision(antes).alerta).toBe(false);
  });

  it('total > 0 con masViejoHoras alto pero total 0 no se contradice', () => {
    // Guarda contra una regla que mire solo la antiguedad e ignore el conteo.
    expect(evaluarVision(estado([arriba('a')], { total: 0, masViejoHoras: 99 })).alerta).toBe(false);
  });

  it('la caida manda sobre los pendientes: se reporta critico, no alto', () => {
    const v = evaluarVision(estado([caido('a', 'HTTP 402')], { total: 9, conUrl: 9, masViejoHoras: 99 }));
    expect(v.severidad).toBe('critico');
  });
});

describe('texto de Telegram', () => {
  it('nombra al proveedor caido y su detalle: sin eso no se sabe que arreglar', () => {
    const e = estado([caido('vercel-gateway', 'HTTP 402 insufficient_funds')]);
    const t = textoVision(evaluarVision(e), e);
    expect(t).toContain('vercel-gateway');
    expect(t).toContain('402');
    expect(t).toContain('recuperar-medios-perdidos');
  });

  it('avisa cuando queda UN solo proveedor arriba', () => {
    const e = estado([arriba('anthropic-directo')], { total: 2, conUrl: 2, masViejoHoras: 30 });
    expect(textoVision(evaluarVision(e), e)).toMatch(/UN solo proveedor/);
  });

  it('no habla de respaldo cuando hay dos arriba', () => {
    const e = estado([arriba('a'), arriba('b')], { total: 2, conUrl: 2, masViejoHoras: 30 });
    expect(textoVision(evaluarVision(e), e)).not.toMatch(/UN solo proveedor/);
  });

  it('dice cuantos pendientes NO se pueden reintentar', () => {
    const e = estado([arriba('a')], { total: 5, conUrl: 2, masViejoHoras: 30 });
    expect(textoVision(evaluarVision(e), e)).toContain('3 sin URL');
  });

  it('con la lista vacia lo dice en vez de mostrar una tabla vacia', () => {
    const e = estado([]);
    expect(textoVision(evaluarVision(e), e)).toContain('no devolvio ningun proveedor');
  });

  it('cabe en una notificacion: 12 lineas o menos', () => {
    const e = estado([caido('a', 'HTTP 402'), caido('b', 'HTTP 500')], { total: 9, conUrl: 4, masViejoHoras: 99 });
    expect(textoVision(evaluarVision(e), e).split('\n').length).toBeLessThanOrEqual(12);
  });
});

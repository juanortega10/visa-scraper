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

function estado(
  p: ProveedorVision[],
  pend: Partial<EstadoVision['pendientes']> = {},
  lecturas24h = 0,
): EstadoVision {
  return { proveedores: p, lecturas24h, pendientes: { total: 0, conUrl: 0, masViejoHoras: 0, ...pend } };
}

describe('salud de la lectura de imagenes', () => {
  it('cero proveedores Y cero lecturas en 24 h es CRITICO: los dos caminos estan muertos', () => {
    const v = evaluarVision(estado([caido('vercel-gateway', 'HTTP 402 insufficient_funds')]));
    expect(v.alerta).toBe(true);
    expect(v.severidad).toBe('critico');
    expect(v.arriba).toBe(0);
  });

  it('cero proveedores pero CON lecturas no alerta: el agente nativo cubre', () => {
    // Desde el 2026-09-01 el agente nativo de Kapso lee con `ask_about_file` y creditos
    // de Kapso. El gateway paso a ser redundante. Si esto alertara solo por el gateway,
    // sonaria todos los dias y se dejaria de leer el aviso.
    const v = evaluarVision(estado([caido('vercel-gateway', 'HTTP 402')], {}, 12));
    expect(v.alerta).toBe(false);
  });

  it('una lista VACIA de proveedores, sin lecturas, es critica y no silencio', () => {
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

  it('pendientes VIEJOS avisan aunque los proveedores esten arriba', () => {
    const v = evaluarVision(estado([arriba('a')], { total: 4, conUrl: 4, masViejoHoras: 50 }, 30));
    expect(v.alerta).toBe(true);
    expect(v.severidad).toBe('critico');
    expect(v.motivo).toContain('4 medios');
  });

  it('un pendiente viejo alerta incluso con lecturas recientes', () => {
    // Que el agente lea lo nuevo no arregla lo que quedo atras. Son dos cosas.
    expect(evaluarVision(estado([arriba('a')], { total: 1, conUrl: 1, masViejoHoras: 99 }, 40)).alerta).toBe(true);
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

  it('los pendientes mandan sobre la caida: el motivo habla de los medios', () => {
    const v = evaluarVision(estado([caido('a', 'HTTP 402')], { total: 9, conUrl: 9, masViejoHoras: 99 }));
    expect(v.severidad).toBe('critico');
    expect(v.motivo).toContain('9 medios');
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

  it('dice cuantas lecturas hubo: es lo que separa un corte de un camino redundante', () => {
    const e = estado([caido('a', 'HTTP 402')], { total: 2, conUrl: 2, masViejoHoras: 30 }, 17);
    const t = textoVision(evaluarVision(e), e);
    expect(t).toContain('lecturas en 24 h: 17');
    expect(t).toMatch(/agente nativo/);
  });

  it('no habla del agente nativo cuando el gateway si responde', () => {
    const e = estado([arriba('a')], { total: 2, conUrl: 2, masViejoHoras: 30 }, 5);
    expect(textoVision(evaluarVision(e), e)).not.toMatch(/agente nativo/);
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

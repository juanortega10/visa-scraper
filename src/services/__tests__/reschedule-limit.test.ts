import { describe, it, expect } from 'vitest';
import { parseRescheduleLimit, effectiveRescheduleBudget } from '../html-parsers.js';

/** Texto real capturado del portal peruano el 2026-08-27 (bots 7 y 299). */
const ES_PE = (quedan: number) => `
<div class="alert"><p>Advertencia: Hay un n&uacute;mero m&aacute;ximo de 2
cancelaciones/reprogramaciones permitidas por este servicio. Le quedan ${quedan}
intentos antes de alcanzar el l&iacute;mite. Tenga en cuenta que si alcanza el
l&iacute;mite, su cita se bloquear&aacute;.</p></div>`;

describe('parseRescheduleLimit', () => {
  it('lee el texto real de es-pe', () => {
    expect(parseRescheduleLimit(ES_PE(1))).toEqual({ max: 2, remaining: 1 });
    expect(parseRescheduleLimit(ES_PE(2))).toEqual({ max: 2, remaining: 2 });
    expect(parseRescheduleLimit(ES_PE(0))).toEqual({ max: 2, remaining: 0 });
  });

  it('lee ingles', () => {
    const html = '<p>There is a maximum of 3 reschedules allowed. You have 2 attempts remaining.</p>';
    expect(parseRescheduleLimit(html)).toEqual({ max: 3, remaining: 2 });
  });

  it('lee frances (caso del bot 162 en fr-ca)', () => {
    const html = '<p>Il y a un nombre maximum de 3 annulations. Il vous reste 2 tentatives restantes.</p>';
    expect(parseRescheduleLimit(html)).toEqual({ max: 3, remaining: 2 });
  });

  it('la pagina del formulario no trae el tope', () => {
    const form = '<form><input name="authenticity_token" value="abc"><select name="facility_id"></select></form>';
    expect(parseRescheduleLimit(form)).toEqual({ max: null, remaining: null });
  });

  it('tolera etiquetas y espacios raros', () => {
    const html = '<p>numero  <b>m&aacute;ximo</b>  de\n\n 2 </p><span>Le  quedan\t1  intentos</span>';
    expect(parseRescheduleLimit(html.replace('&aacute;', 'á'))).toEqual({ max: 2, remaining: 1 });
  });
});

describe('effectiveRescheduleBudget — separa el tope del portal de nuestro presupuesto', () => {
  it('el caso del bot 299: el portal da 2, nosotros autorizamos 1', () => {
    expect(effectiveRescheduleBudget({ portalRemaining: 2, ourMax: 1, ourCount: 0 }))
      .toEqual({ left: 1, capBy: 'nuestro' });
  });

  it('el caso del bot 7: el portal da 1, nosotros autorizamos 2', () => {
    expect(effectiveRescheduleBudget({ portalRemaining: 1, ourMax: 2, ourCount: 1 }))
      .toEqual({ left: 1, capBy: 'portal' });
  });

  it('el portal manda cuando es mas estricto', () => {
    expect(effectiveRescheduleBudget({ portalRemaining: 0, ourMax: 5, ourCount: 0 }))
      .toEqual({ left: 0, capBy: 'portal' });
  });

  it('nuestro presupuesto manda cuando es mas estricto', () => {
    expect(effectiveRescheduleBudget({ portalRemaining: 9, ourMax: 3, ourCount: 3 }))
      .toEqual({ left: 0, capBy: 'nuestro' });
  });

  it('sin dato del portal, manda nuestro presupuesto', () => {
    expect(effectiveRescheduleBudget({ portalRemaining: null, ourMax: 2, ourCount: 0 }))
      .toEqual({ left: 2, capBy: 'nuestro' });
  });

  it('sin presupuesto nuestro, manda el portal', () => {
    expect(effectiveRescheduleBudget({ portalRemaining: 3, ourMax: null, ourCount: 7 }))
      .toEqual({ left: 3, capBy: 'portal' });
  });

  it('sin ninguno de los dos, no hay tope', () => {
    const r = effectiveRescheduleBudget({ portalRemaining: null, ourMax: null, ourCount: 0 });
    expect(r.capBy).toBe('sin_tope');
    expect(r.left).toBe(Number.POSITIVE_INFINITY);
  });

  it('nunca devuelve negativo si el contador se paso', () => {
    expect(effectiveRescheduleBudget({ portalRemaining: -1, ourMax: 2, ourCount: 5 }).left).toBe(0);
  });
});

/**
 * La guarda de claimSlot vive en SQL. Aqui se fija la regla que debe cumplir,
 * para que nadie la afloje por accidente al editar la consulta.
 *
 * Condicion real en `reschedule-logic.ts` (claimSlot):
 *   (max_reschedules IS NULL OR reschedule_count < max_reschedules)
 *   AND (portal_remaining_reschedules IS NULL OR portal_remaining_reschedules > 0)
 */
describe('regla de claimSlot — el tope mas estricto manda', () => {
  const puedeReclamar = (b: {
    count: number; ourMax: number | null; portalRemaining: number | null;
  }) => (b.ourMax === null || b.count < b.ourMax)
     && (b.portalRemaining === null || b.portalRemaining > 0);

  it('bot 299: presupuesto 1 agotado, aunque el portal tenga 2', () => {
    expect(puedeReclamar({ count: 0, ourMax: 1, portalRemaining: 2 })).toBe(true);
    expect(puedeReclamar({ count: 1, ourMax: 1, portalRemaining: 2 })).toBe(false);
  });

  it('el portal en cero bloquea aunque nos sobre presupuesto', () => {
    expect(puedeReclamar({ count: 0, ourMax: 9, portalRemaining: 0 })).toBe(false);
  });

  it('sin dato del portal, decide solo nuestro presupuesto', () => {
    expect(puedeReclamar({ count: 1, ourMax: 2, portalRemaining: null })).toBe(true);
    expect(puedeReclamar({ count: 2, ourMax: 2, portalRemaining: null })).toBe(false);
  });

  it('sin presupuesto nuestro, decide solo el portal', () => {
    expect(puedeReclamar({ count: 99, ourMax: null, portalRemaining: 1 })).toBe(true);
    expect(puedeReclamar({ count: 0, ourMax: null, portalRemaining: 0 })).toBe(false);
  });

  it('sin ninguno de los dos, siempre puede', () => {
    expect(puedeReclamar({ count: 500, ourMax: null, portalRemaining: null })).toBe(true);
  });
});

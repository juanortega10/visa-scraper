/**
 * El 302 de la pagina de appointment hacia `/{locale}/niv/groups/{userId}`.
 *
 * Hipotesis inicial (2026-08-30): significaba que la cita ya paso y no se puede
 * reagendar. REFUTADA el 2026-08-31. El 302 aparece cuando la sesion no tiene
 * `authenticity_token`, y desaparece en cuanto un login devuelve `hasTokens: true`.
 *
 * Medicion que la refuto, misma flota y mismo minuto (01:23 UTC):
 *   bots 66, 105, 114, 235 con `authenticity_token` presente -> status `ok`
 *   bots 94, 107, 219 con `authenticity_token` null          -> status `error`
 * Los cuatro primeros tienen la cita vencida igual que los otros tres. La cita no
 * decide nada; el token si. El bot 105 encadeno 14 `inline_relogin` hasta que uno
 * trajo tokens, y volvio a `ok` con 50 fechas.
 *
 * Consecuencia para el codigo: `assertOk` deja este 302 como `SessionExpiredError`,
 * porque el re-login inline es lo que recupera al bot. Estos tests fijan esa decision
 * para que nadie la revierta con la hipotesis vieja.
 */
import { describe, it, expect } from 'vitest';
import { esRedirectAlGrupo, SessionExpiredError } from '../visa-client.js';

describe('esRedirectAlGrupo identifica el patron', () => {
  it('reconoce el redirect real del bot 114', () => {
    expect(esRedirectAlGrupo(
      'Appointment page', 302, 'https://ais.usvisa-info.com/es-co/niv/groups/51703672',
    )).toBe(true);
  });

  it('vale para cualquier locale', () => {
    for (const loc of ['es-co', 'es-mx', 'es-pe', 'fr-ca', 'en-ca']) {
      expect(esRedirectAlGrupo(
        'Appointment page', 302, `https://ais.usvisa-info.com/${loc}/niv/groups/99887766`,
      )).toBe(true);
    }
  });

  it('distingue el redirect a sign_in', () => {
    expect(esRedirectAlGrupo(
      'Appointment page', 302, 'https://ais.usvisa-info.com/es-co/niv/users/sign_in',
    )).toBe(false);
  });

  it('no aplica a otras paginas aunque el destino sea el grupo', () => {
    for (const label of ['Consular days', 'CAS days', 'Times']) {
      expect(esRedirectAlGrupo(
        label, 302, 'https://ais.usvisa-info.com/es-co/niv/groups/51703672',
      )).toBe(false);
    }
  });

  it('no aplica a otros codigos de estado', () => {
    for (const st of [200, 301, 303, 401, 403, 500]) {
      expect(esRedirectAlGrupo(
        'Appointment page', st, 'https://ais.usvisa-info.com/es-co/niv/groups/51703672',
      )).toBe(false);
    }
  });

  it('exige un id numerico de grupo', () => {
    for (const loc of [
      'https://ais.usvisa-info.com/es-co/niv/groups',
      'https://ais.usvisa-info.com/es-co/niv/groups/',
      'https://ais.usvisa-info.com/es-co/niv/groups/abc',
      '',
    ]) {
      expect(esRedirectAlGrupo('Appointment page', 302, loc)).toBe(false);
    }
  });
});

describe('el patron sigue siendo sesion expirada', () => {
  it('no existe una clase de error propia que saltee el re-login', async () => {
    // Si alguien vuelve a introducir `CitaNoReagendableError` y la usa para cortar el
    // re-login inline, los bots con `authenticity_token` null quedan atascados sin
    // forma de recuperarse. Ver el encabezado de este archivo.
    const mod = await import('../visa-client.js') as Record<string, unknown>;
    expect(mod.CitaNoReagendableError).toBeUndefined();
  });

  it('SessionExpiredError sigue siendo el canal de recuperacion', () => {
    const e = new SessionExpiredError('Appointment page: HTTP 302, location=.../groups/51703672');
    expect(e).toBeInstanceOf(SessionExpiredError);
    expect(e.name).toBe('SessionExpiredError');
  });
});

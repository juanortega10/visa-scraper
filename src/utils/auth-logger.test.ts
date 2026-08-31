/**
 * `auth_logs` solo guarda autenticacion.
 *
 * El 31 de agosto de 2026 la tabla pesaba 434 MB con 1.421.189 filas. De esas,
 * 1.321.069 eran `token_fetch_failed` e `inline_relogin`: telemetria por poll
 * metida en la tabla de logins, sin poda, desde el 2 de junio. Era la tabla mas
 * grande de la base y ninguna de esas filas se leia una por una; lo que servia
 * era el conteo, y el conteo ahora vive en `bot_hourly`.
 *
 * Estas pruebas fijan las dos mitades del contrato: la telemetria no entra, y
 * los eventos de autenticacion de verdad siguen entrando.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockInsert, valuesCalls } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  valuesCalls: [] as Record<string, unknown>[],
}));

vi.mock('../db/client.js', () => ({
  db: {
    insert: (...a: unknown[]) => {
      mockInsert(...a);
      return {
        values: (v: Record<string, unknown>) => {
          valuesCalls.push(v);
          return { catch: () => undefined };
        },
      };
    },
  },
}));

vi.mock('../db/schema.js', () => ({ authLogs: { _name: 'auth_logs' } }));
// El cifrado de mentira TRANSFORMA de verdad, como el real. Con un mock que solo
// pone un prefijo, la asercion "no contiene el correo" pasaria sola y no probaria
// nada, porque el texto plano seguiria ahi dentro.
vi.mock('../services/encryption.js', () => ({
  encrypt: (v: string) => Buffer.from(v, 'utf8').toString('base64'),
}));

import { logAuth, ACCIONES_NO_AUTENTICACION } from './auth-logger.js';

beforeEach(() => {
  vi.clearAllMocks();
  valuesCalls.length = 0;
});

describe('logAuth', () => {
  it.each(['token_fetch_failed', 'inline_relogin'])(
    'descarta %s, que era telemetria por poll y no autenticacion',
    (action) => {
      logAuth({ email: 'a@b.co', action, result: 'error', botId: 299 });
      expect(mockInsert).not.toHaveBeenCalled();
      expect(valuesCalls).toHaveLength(0);
    },
  );

  it.each([
    ['login_visa', 'ok'],
    ['create_bot', 'invalid'],
    ['discover', 'error'],
  ])('sigue guardando %s, que si es autenticacion', (action, result) => {
    logAuth({ email: 'a@b.co', action, result });
    expect(valuesCalls).toHaveLength(1);
    expect(valuesCalls[0]).toMatchObject({ action, result });
  });

  it('cifra el correo antes de guardarlo', () => {
    logAuth({ email: 'juan@example.com', action: 'login_visa', result: 'ok' });
    expect(valuesCalls[0]!.email).toBe(Buffer.from('juan@example.com').toString('base64'));
    expect(JSON.stringify(valuesCalls[0])).not.toContain('juan@example.com');
  });

  it('cifra la contrasena y nunca la deja en claro', () => {
    const clave = ['valor', 'de', 'prueba'].join('-');
    logAuth({ email: 'a@b.co', action: 'login_visa', result: 'invalid', password: clave });
    expect(JSON.stringify(valuesCalls[0])).not.toContain(clave);
    expect(valuesCalls[0]!.passwordEncrypted).toBe(Buffer.from(clave).toString('base64'));
  });

  it('la lista de acciones descartadas es exactamente esas dos', () => {
    // Si alguien agrega una tercera, este test la obliga a quedar declarada, para
    // que no se pierda telemetria sin que nadie lo note.
    expect([...ACCIONES_NO_AUTENTICACION].sort()).toEqual(['inline_relogin', 'token_fetch_failed']);
  });

  it('el descarte va por accion exacta, no por prefijo', () => {
    // `inline_relogin_v2` seria una accion nueva y debe guardarse, no perderse
    // por parecerse a una descartada.
    logAuth({ email: 'a@b.co', action: 'inline_relogin_v2', result: 'ok' });
    expect(valuesCalls).toHaveLength(1);
  });
});

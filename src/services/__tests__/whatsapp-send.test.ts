import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pickTarget, sendWhatsAppText } from '../whatsapp-send.js';

/**
 * El punto de estas pruebas: garantizar que el cobro deja de depender del
 * teléfono. Cuando Meta deje de entregarlo, el BSUID tiene que bastar.
 */

describe('pickTarget', () => {
  it('prefiere el BSUID aunque haya teléfono', () => {
    expect(pickTarget({ waBsuid: 'CO.1049384871137821', phone: '573135359930' }))
      .toEqual({ via: 'bsuid', value: 'CO.1049384871137821' });
  });

  it('cae al teléfono cuando no hay BSUID', () => {
    expect(pickTarget({ waBsuid: null, phone: '573135359930' }))
      .toEqual({ via: 'phone', value: '573135359930' });
  });

  it('funciona solo con BSUID, sin teléfono: el caso que viene', () => {
    expect(pickTarget({ waBsuid: 'CO.2045428816061848', phone: null }))
      .toEqual({ via: 'bsuid', value: 'CO.2045428816061848' });
  });

  it('rechaza un BSUID con formato inválido', () => {
    expect(pickTarget({ waBsuid: 'no-es-un-bsuid', phone: null })).toBeNull();
    expect(pickTarget({ waBsuid: '1049384871137821', phone: null })).toBeNull();
  });

  it('rechaza teléfonos que no son dígitos', () => {
    expect(pickTarget({ phone: '+57 313 535 9930' })).toBeNull();
  });

  it('devuelve null cuando no hay ninguna vía', () => {
    expect(pickTarget({ waBsuid: null, phone: null })).toBeNull();
  });
});

describe('sendWhatsAppText', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.KAPSO_API_KEY = 'test-key';
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  const ok = () => ({
    ok: true,
    json: async () => ({ messages: [{ id: 'wamid.TEST' }] }),
  });

  it('manda por BSUID usando recipient, no to', async () => {
    fetchMock.mockResolvedValue(ok());
    const r = await sendWhatsAppText({ waBsuid: 'CO.1049384871137821' }, 'hola');
    expect(r).toMatchObject({ ok: true, via: 'bsuid' });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.recipient).toBe('CO.1049384871137821');
    expect(body.to).toBeUndefined();
  });

  it('nunca manda to y recipient juntos: Meta le daría precedencia al teléfono', async () => {
    fetchMock.mockResolvedValue(ok());
    await sendWhatsAppText({ waBsuid: 'CO.1049384871137821', phone: '573135359930' }, 'hola');
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect('to' in body && 'recipient' in body).toBe(false);
  });

  it('reintenta por teléfono si Meta responde 131062', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 131062, message: 'BSUID no soportado' } }),
      })
      .mockResolvedValueOnce(ok());
    const r = await sendWhatsAppText(
      { waBsuid: 'CO.1049384871137821', phone: '573135359930' },
      'hola',
    );
    expect(r).toMatchObject({ ok: true, via: 'phone' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('no reintenta 131062 si no hay teléfono al cual caer', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 131062, message: 'BSUID no soportado' } }),
    });
    const r = await sendWhatsAppText({ waBsuid: 'CO.1049384871137821' }, 'hola');
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falla claro cuando no hay ninguna vía de contacto', async () => {
    const r = await sendWhatsAppText({ waBsuid: null, phone: null }, 'hola');
    expect(r).toEqual({ ok: false, error: 'el cliente no tiene ni BSUID ni teléfono válido' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no manda mensajes vacíos', async () => {
    const r = await sendWhatsAppText({ waBsuid: 'CO.1049384871137821' }, '   ');
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('usa X-API-Key, no Bearer: Kapso no acepta Bearer', async () => {
    fetchMock.mockResolvedValue(ok());
    await sendWhatsAppText({ waBsuid: 'CO.1049384871137821' }, 'hola');
    const headers = fetchMock.mock.calls[0]![1].headers;
    expect(headers['X-API-Key']).toBe('test-key');
    expect(headers.Authorization).toBeUndefined();
  });
});

/**
 * Envío de WhatsApp por Kapso, direccionado por BSUID o por teléfono.
 *
 * El teléfono se está muriendo como identificador: Meta solo lo entrega
 * mientras haya habido interacción en los últimos 30 días, y la UI de WhatsApp
 * ya dejó de mostrarlo. El BSUID llega siempre, así que es el destinatario
 * preferido. Meta habilitó el campo `recipient` para esto en julio de 2026.
 */

const PHONE_NUMBER_ID = process.env.KAPSO_PHONE_NUMBER_ID || '953370504536165';
const KAPSO_META_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0';

export type SendTarget = {
  /** Business-Scoped User ID, ej. "CO.1049384871137821". Preferido. */
  waBsuid?: string | null;
  /** Teléfono en dígitos. Fallback cuando todavía lo tenemos. */
  phone?: string | null;
};

export type SendResult =
  | { ok: true; via: 'bsuid' | 'phone'; messageId?: string }
  | { ok: false; error: string };

export function pickTarget(t: SendTarget): { via: 'bsuid' | 'phone'; value: string } | null {
  // BSUID primero: es el que va a seguir existiendo.
  if (t.waBsuid && /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/.test(t.waBsuid)) {
    return { via: 'bsuid', value: t.waBsuid };
  }
  if (t.phone && /^\d{10,15}$/.test(t.phone)) {
    return { via: 'phone', value: t.phone };
  }
  return null;
}

export async function sendWhatsAppText(
  target: SendTarget,
  text: string,
): Promise<SendResult> {
  if (!text.trim()) return { ok: false, error: 'mensaje vacío' };
  return enviar(target, { type: 'text', text: { body: text, preview_url: false } });
}

/**
 * Plantilla aprobada con parámetros posicionales en el cuerpo. Es la única vía fuera de la
 * ventana de 24 h desde el último mensaje entrante.
 */
export async function sendWhatsAppTemplate(
  target: SendTarget,
  name: string,
  bodyParams: string[],
  languageCode = 'es',
): Promise<SendResult> {
  return enviar(target, {
    type: 'template',
    template: {
      name,
      language: { code: languageCode },
      components: bodyParams.length
        ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
        : [],
    },
  });
}

async function enviar(
  target: SendTarget,
  contenido: Record<string, unknown>,
): Promise<SendResult> {
  const apiKey = process.env.KAPSO_API_KEY;
  if (!apiKey) return { ok: false, error: 'KAPSO_API_KEY no está configurada' };

  const picked = pickTarget(target);
  if (!picked) {
    return { ok: false, error: 'el cliente no tiene ni BSUID ni teléfono válido' };
  }

  // `to` para teléfono, `recipient` para BSUID. Si van los dos, Meta le da
  // precedencia al teléfono, así que mandamos solo uno.
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    ...contenido,
    ...(picked.via === 'bsuid'
      ? { recipient: picked.value }
      : { to: picked.value }),
  };

  try {
    const res = await fetch(`${KAPSO_META_BASE}/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok) {
      // 131062: BSUID no soportado para este tipo de mensaje. Reintenta por
      // teléfono si todavía lo tenemos, en vez de perder el cobro.
      const code = data?.error?.code;
      if (code === 131062 && picked.via === 'bsuid' && target.phone) {
        return enviar({ phone: target.phone }, contenido);
      }
      // Kapso responde `{ error: { message } }` (Meta) o `{ error: "texto" }` (sus validaciones).
      const mensaje = data?.error?.message || (typeof data?.error === 'string' ? data.error : null);
      return { ok: false, error: mensaje ? `${res.status}: ${mensaje}` : `Kapso respondió ${res.status}` };
    }
    return { ok: true, via: picked.via, messageId: data?.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'fallo de red' };
  }
}

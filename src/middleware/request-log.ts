import { createMiddleware } from 'hono/factory';

/**
 * Frontera de observabilidad del API.
 *
 * El 30 de agosto de 2026 una agencia quedo bloqueada 40 minutos. El API le
 * devolvio 400 y no quedo NI UNA linea en el log: `validateCreateBot` retorna
 * antes de cualquier `console.log`. Reconstruir el caso exigio leer el codigo.
 *
 * Este middleware envuelve toda respuesta con estado 400 o mayor y emite una
 * linea JSON. Ninguna ruta tiene que acordarse de registrar nada, y una ruta
 * nueva queda cubierta el dia que se escribe.
 *
 * Reglas que sostiene:
 *   - Todo error que ve una persona deja una fila en el servidor.
 *   - Un `request_id` une navegador, API y worker. El navegador lo propone en
 *     `X-Request-Id`; si no viene, lo genera el servidor y lo devuelve.
 *   - Todo en UTC con sufijo Z. Nunca hora local.
 *   - El cuerpo del error se recorta y jamas incluye la contrasena.
 */

const MAX_ERROR_BODY = 400;

/** Campos que nunca salen en un log, aunque el cuerpo del error los traiga. */
const SECRETOS = /"(visaPassword|password|token|discoveryToken|apiKey|secret)"\s*:\s*"[^"]*"/gi;

export function newRequestId(): string {
  // Ordenable por tiempo y corto, para que quepa en un mensaje de error visible.
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${t}-${r}`;
}

function redact(text: string): string {
  return text.replace(SECRETOS, (_m, k) => `"${k}":"[oculto]"`);
}

/**
 * Lee el cuerpo de una respuesta de error sin consumirlo para el cliente.
 * Devuelve cadena vacia si el cuerpo no es texto o no se puede leer.
 */
async function peekBody(res: Response): Promise<string> {
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json') && !type.includes('text')) return '';
  try {
    const text = await res.clone().text();
    return redact(text).slice(0, MAX_ERROR_BODY);
  } catch {
    return '';
  }
}

export interface RequestLogVars {
  requestId: string;
}

export function requestLog() {
  return createMiddleware<{ Variables: RequestLogVars }>(async (c, next) => {
    const incoming = c.req.header('X-Request-Id');
    // Solo se acepta un id con forma sana. Asi un cliente no puede inyectar
    // saltos de linea ni inflar el log.
    const requestId = incoming && /^[A-Za-z0-9_-]{4,40}$/.test(incoming) ? incoming : newRequestId();
    c.set('requestId', requestId);

    const started = Date.now();
    await next();

    c.res.headers.set('X-Request-Id', requestId);
    if (c.res.status < 400) return;

    const clerkUser = c.get('clerkUser' as never) as { clerkUserId?: string } | undefined;
    const line = {
      ts: new Date().toISOString(),
      lvl: c.res.status >= 500 ? 'error' : 'warn',
      req: requestId,
      route: `${c.req.method} ${new URL(c.req.url).pathname}`,
      status: c.res.status,
      error: await peekBody(c.res),
      clerk: clerkUser?.clerkUserId ?? null,
      ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      ms: Date.now() - started,
    };
    console.log(`[api] ${JSON.stringify(line)}`);
  });
}

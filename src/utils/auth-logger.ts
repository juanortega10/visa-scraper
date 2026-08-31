import { db } from '../db/client.js';
import { authLogs } from '../db/schema.js';
import { encrypt } from '../services/encryption.js';

/**
 * Acciones que NO son de autenticacion y por eso ya no van a `auth_logs`.
 *
 * El 31 de agosto de 2026 la tabla pesaba 434 MB con 1.421.189 filas, y 1.321.069
 * de ellas eran estas dos: telemetria por poll metida en la tabla de logins. Su
 * valor es el conteo, no la fila: ahora se cuentan por hora en `bot_hourly`
 * (`relogins` y `token_failures`) y el detalle sigue en el log del worker.
 *
 * Un `logAuth` con una de estas acciones se descarta en silencio a proposito:
 * asi ningun llamador viejo vuelve a inflar la tabla sin darse cuenta.
 */
export const ACCIONES_NO_AUTENTICACION = new Set(['token_fetch_failed', 'inline_relogin']);

export function logAuth(params: {
  email: string; action: string; locale?: string;
  result: string; errorMessage?: string; password?: string;
  clerkUserId?: string | null; ip?: string | null; botId?: number;
}): void {
  if (ACCIONES_NO_AUTENTICACION.has(params.action)) return;
  db.insert(authLogs).values({
    email: encrypt(params.email),
    action: params.action,
    locale: params.locale ?? null,
    result: params.result,
    errorMessage: params.errorMessage ?? null,
    passwordEncrypted: params.password ? encrypt(params.password) : null,
    clerkUserId: params.clerkUserId ?? null,
    ip: params.ip ?? null,
    botId: params.botId ?? null,
  }).catch((e) => console.error('[auth_logs] insert failed:', e));
}

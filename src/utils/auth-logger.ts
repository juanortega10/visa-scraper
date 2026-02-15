import { db } from '../db/client.js';
import { authLogs } from '../db/schema.js';
import { encrypt } from '../services/encryption.js';

export function logAuth(params: {
  email: string; action: string; locale?: string;
  result: string; errorMessage?: string;
  clerkUserId?: string | null; ip?: string | null; botId?: number;
}): void {
  db.insert(authLogs).values({
    email: encrypt(params.email),
    action: params.action,
    locale: params.locale ?? null,
    result: params.result,
    errorMessage: params.errorMessage ?? null,
    clerkUserId: params.clerkUserId ?? null,
    ip: params.ip ?? null,
    botId: params.botId ?? null,
  }).catch((e) => console.error('[auth_logs] insert failed:', e));
}

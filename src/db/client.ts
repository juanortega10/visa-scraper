import ws from 'ws';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import * as schema from './schema.js';

// Node.js 20 no tiene WebSocket nativo — proveemos el polyfill.
// El WebSocket pool mantiene conexiones TCP persistentes (a diferencia del driver
// HTTP que abría una conexión nueva por cada query), eliminando los ETIMEDOUT
// del ISP residencial del RPi bajo carga concurrente.
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 5 });

export const db = drizzle({ client: pool, schema });
export type Database = NeonDatabase<typeof schema>;

// Retry wrapper para errores transitorios de red (ETIMEDOUT, connection reset).
// Aplicar en queries síncronas críticas al inicio de cada run.
// Las queries de background (allSettled) no lo necesitan — el siguiente poll reintenta.
export async function withDbRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTransient =
        msg.includes('ETIMEDOUT') ||
        msg.includes('fetch failed') ||
        msg.includes('connection timeout') ||
        msg.includes('Connection terminated') ||
        msg.includes('write CONNECTION_ENDED') ||
        msg.includes('read CONNECTION_END');
      if (!isTransient || attempt === maxAttempts) throw e;
      lastError = e;
      await new Promise(r => setTimeout(r, attempt * 500));
    }
  }
  throw lastError;
}

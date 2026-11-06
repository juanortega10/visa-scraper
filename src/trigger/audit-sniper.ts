/**
 * Vigilante de snipers · cada 5 min en PRODUCTION · avisa por Telegram.
 * La regla vive en `src/services/sniper-vivo.ts`, que es la que tiene tests.
 * Corre en la nube a proposito: si el RPi se cae entero, el aviso sale igual.
 */
import { schedules, logger } from '@trigger.dev/sdk/v3';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  SNIPERS_VIGILADOS, snipersCaidos, debeAvisar, textoSniperCaido, type EstadoSniper,
} from '../services/sniper-vivo.js';
import { sendTelegram } from '../services/notifications.js';

export async function leerEstadosSniper(): Promise<EstadoSniper[]> {
  const estados: EstadoSniper[] = [];
  for (const v of SNIPERS_VIGILADOS) {
    // extract(epoch): `scanned_at` es timestamp sin zona. Ver la nota en audit-ruta-cerrada.ts.
    const r = await db.execute<Record<string, unknown>>(sql`
      SELECT (SELECT extract(epoch from max(scanned_at)) * 1000 FROM sniper_scans WHERE scan_key = ${v.scanKey}) AS ultimo_ms,
             (SELECT status FROM bots WHERE id = ${v.botId}) AS status
    `);
    const f = r.rows[0] ?? {};
    estados.push({
      scanKey: v.scanKey,
      botId: v.botId,
      botActivo: f.status === 'active',
      ultimoMs: f.ultimo_ms === null || f.ultimo_ms === undefined ? null : Number(f.ultimo_ms),
    });
  }
  return estados;
}

export const auditSniper = schedules.task({
  id: 'audit-sniper',
  cron: { pattern: '*/5 * * * *', environments: ['PRODUCTION'] },
  machine: { preset: 'micro' },
  maxDuration: 60,
  run: async () => {
    const caidos = snipersCaidos(await leerEstadosSniper(), Date.now());
    if (caidos.length === 0) { logger.info('audit-sniper: todos vivos'); return { caidos: 0, avisos: 0 }; }
    let avisos = 0;
    for (const c of caidos) {
      logger.warn('audit-sniper: caido', { ...c });
      if (debeAvisar(c.minutos) && (await sendTelegram(textoSniperCaido(c)))) avisos += 1;
    }
    return { caidos: caidos.length, avisos };
  },
});

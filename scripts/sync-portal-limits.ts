/**
 * Lee el TOPE REAL del portal para cada bot y lo guarda, separado de nuestro
 * presupuesto.
 *
 * Dos numeros distintos, a proposito:
 *   bots.portal_max_reschedules / portal_remaining_reschedules
 *       lo dice el portal en su pagina de advertencia. Es duro. Al agotarlo la
 *       cita se BLOQUEA y no hay vuelta atras.
 *   bots.max_reschedules
 *       lo fijamos nosotros. Puede ser MENOR para dejar reserva. Ejemplo real:
 *       bot 299 tiene presupuesto 1 aunque el portal permita 2.
 *
 * El limite efectivo es el menor de los dos (`effectiveRescheduleBudget`).
 *
 * Fuente: `/schedule/{id}/appointment` SIN `confirmed_limit_message=1`. Con ese
 * parametro la advertencia se salta y el numero no aparece.
 *
 * Solo GET al portal. Escribe unicamente las 3 columnas `portal_*`.
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/sync-portal-limits.ts --bots 299,7
 *   npx tsx --env-file=.env scripts/sync-portal-limits.ts --locale es-pe
 *   npx tsx --env-file=.env scripts/sync-portal-limits.ts --locale es-pe --commit
 */
import { eq, inArray, and } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { loginWithFallback } from '../src/services/login.js';
import { proxyFetch } from '../src/services/proxy-fetch.js';
import { parseRescheduleLimit, effectiveRescheduleBudget } from '../src/services/html-parsers.js';
import { BROWSER_HEADERS, USER_AGENT } from '../src/utils/constants.js';

const argOf = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const COMMIT = process.argv.includes('--commit');
const IDS = argOf('--bots')?.split(',').map(Number);
const LOCALE = argOf('--locale');

if (!IDS && !LOCALE) {
  console.log('Falta --bots 299,7 o --locale es-pe');
  process.exit(1);
}

const where = IDS
  ? inArray(bots.id, IDS)
  : and(eq(bots.locale, LOCALE!), eq(bots.status, 'active'));
const rows = await db.select().from(bots).where(where);

console.log(`SINCRONIZAR TOPE DEL PORTAL · ${rows.length} bot(s) · ${COMMIT ? '*** ESCRIBE ***' : 'DRY-RUN'}\n`);
const pad = (v: unknown, n: number) => String(v ?? '-').padEnd(n);
console.log(`${pad('bot', 6)}${pad('portal', 14)}${pad('presupuesto', 14)}${pad('efectivo', 20)}nota`);

let cambios = 0;
for (const r of rows) {
  const base = `https://ais.usvisa-info.com/${r.locale}/niv`;
  let limite = { max: null as number | null, remaining: null as number | null };
  let nota = '';

  try {
    const { result: login } = await loginWithFallback({
      email: decrypt(r.visaEmail as string), password: decrypt(r.visaPassword as string),
      scheduleId: String(r.scheduleId), applicantIds: (r.applicantIds ?? []) as string[],
      locale: r.locale ?? 'es-co',
    });
    const headers = {
      Cookie: `_yatri_session=${login.cookie}`,
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      ...BROWSER_HEADERS,
    };
    const url = `${base}/schedule/${r.scheduleId}/appointment`;
    let html = '';
    for (const provider of ['direct', 'webshare'] as const) {
      try {
        const { response } = await proxyFetch(url, { headers, redirect: 'manual' }, provider,
          provider === 'direct' ? undefined : (r.proxyUrls as string[] | null) ?? undefined);
        if (response.status === 200) { html = await response.text(); break; }
      } catch { /* siguiente ruta */ }
    }
    if (!html) { nota = 'la pagina de advertencia no respondio'; }
    else {
      limite = parseRescheduleLimit(html);
      if (limite.max === null && limite.remaining === null) nota = 'la pagina no menciona el tope';
    }
  } catch (e) {
    nota = `login fallo: ${(e as Error).message.slice(0, 40)}`;
  }

  const ef = effectiveRescheduleBudget({
    portalRemaining: limite.remaining, ourMax: r.maxReschedules, ourCount: r.rescheduleCount ?? 0,
  });
  const usadosPortal = limite.max !== null && limite.remaining !== null ? limite.max - limite.remaining : null;
  if (usadosPortal !== null && usadosPortal !== (r.rescheduleCount ?? 0)) {
    nota = `${nota ? nota + ' · ' : ''}nuestro contador dice ${r.rescheduleCount}, el portal dice ${usadosPortal}`;
  }

  console.log(
    `${pad(r.id, 6)}${pad(limite.max !== null ? `${limite.remaining}/${limite.max}` : '?', 14)}` +
    `${pad(`${r.rescheduleCount}/${r.maxReschedules ?? '∞'}`, 14)}` +
    `${pad(`${ef.left === Infinity ? '∞' : ef.left} (tope: ${ef.capBy})`, 20)}${nota}`,
  );

  if (COMMIT && (limite.max !== null || limite.remaining !== null)) {
    await db.update(bots).set({
      portalMaxReschedules: limite.max,
      portalRemainingReschedules: limite.remaining,
      portalLimitCheckedAt: new Date(),
    }).where(eq(bots.id, r.id));
    cambios += 1;
  }
}

console.log(`\n${COMMIT ? `${cambios} fila(s) actualizadas.` : 'DRY-RUN. Con --commit se guarda.'}`);
console.log('El presupuesto (max_reschedules) NO se toca aqui. Es decision tuya.');
process.exit(0);

/**
 * Que URLs del portal responden y cuales no, para un schedule dado.
 *
 * Nace del hallazgo del 2026-08-27: el bot 299 pollea bien (`days.json` responde)
 * pero la pagina HTML `/schedule/{id}/appointment` falla por las DOS rutas. Sin esa
 * pagina no hay `authenticity_token`, y sin token el POST devuelve 302 a `sign_in`.
 *
 * Compara el bot afectado contra uno sano del mismo locale, para separar
 * "bloqueo del schedule" de "portal caido".
 *
 * Solo GET. Sin POST. Sin escrituras.
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/probe-schedule-block.ts --bots 299,7
 */
import os from 'node:os';
import { inArray } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { loginWithFallback } from '../src/services/login.js';
import { proxyFetch } from '../src/services/proxy-fetch.js';
import { BROWSER_HEADERS, USER_AGENT } from '../src/utils/constants.js';

const argOf = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const IDS = (argOf('--bots') ?? '299,7').split(',').map(Number);

console.log(`SONDA DE BLOQUEO POR SCHEDULE · host ${os.hostname()} · solo GET\n`);

const rows = await db.select().from(bots).where(inArray(bots.id, IDS));

for (const id of IDS) {
  const r = rows.find((b) => b.id === id);
  if (!r) { console.log(`bot ${id} no existe\n`); continue; }

  const base = `https://ais.usvisa-info.com/${r.locale}/niv`;
  const { result: login } = await loginWithFallback({
    email: decrypt(r.visaEmail as string), password: decrypt(r.visaPassword as string),
    scheduleId: String(r.scheduleId), applicantIds: (r.applicantIds ?? []) as string[],
    locale: r.locale ?? 'es-co',
  });

  const htmlHeaders = {
    Cookie: `_yatri_session=${login.cookie}`,
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    ...BROWSER_HEADERS,
  };
  const jsonHeaders = {
    Cookie: `_yatri_session=${login.cookie}`,
    'User-Agent': USER_AGENT,
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json',
    ...(login.csrfToken ? { 'X-CSRF-Token': login.csrfToken } : {}),
    ...BROWSER_HEADERS,
  };

  const fac = String(r.consularFacilityId ?? '115');
  const targets: Array<[string, string, Record<string, string>]> = [
    ['HTML  appointment', `${base}/schedule/${r.scheduleId}/appointment?confirmed_limit_message=1`, htmlHeaders],
    ['HTML  groups', `${base}/groups/${r.userId}`, htmlHeaders],
    ['JSON  days', `${base}/schedule/${r.scheduleId}/appointment/days/${fac}.json`, jsonHeaders],
    ['HTML  raiz niv', `${base}`, htmlHeaders],
  ];

  console.log(`── bot ${id} · ${r.locale} · schedule ${r.scheduleId} · login ok=${!!login.cookie} tokens=${!!login.authenticityToken}`);
  for (const [label, url, headers] of targets) {
    for (const provider of ['direct', 'webshare'] as const) {
      const t = Date.now();
      let out: string;
      try {
        const { response } = await proxyFetch(url, { headers, redirect: 'manual' }, provider,
          provider === 'direct' ? undefined : (r.proxyUrls as string[] | null) ?? undefined);
        const loc = response.headers.get('location');
        const len = response.headers.get('content-length');
        out = `HTTP ${response.status}${loc ? ` → ${loc.replace(base, '')}` : ''}${len ? ` (${len}b)` : ''}`;
      } catch (e) {
        out = `FALLO ${(e as Error).message.slice(0, 42)}`;
      }
      console.log(`   ${label.padEnd(20)} ${provider.padEnd(9)} ${String(Date.now() - t).padStart(6)} ms  ${out}`);
    }
  }
  console.log('');
}
process.exit(0);

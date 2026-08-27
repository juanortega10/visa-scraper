/**
 * Mapea EN VIVO el estado de una cuenta del portal, con nuestro propio login.
 *
 * Responde tres cosas que hoy solo sabiamos a medias:
 *   1. Que grupos existen, con el token de estado que sale de la CLASE del card
 *      (nunca del texto visible, que cambia de idioma en la misma pagina).
 *   2. Si la pagina de reprogramar abre, y que dice sobre INTENTOS RESTANTES.
 *   3. De donde sale ese numero exactamente, mostrando el HTML alrededor.
 *
 * Solo GET. Sin POST. Sin escrituras a la base de datos.
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/map-account-state.ts --bots 299,7
 *   npx tsx --env-file=.env scripts/map-account-state.ts --bots 299 --html
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
const IDS = (argOf('--bots') ?? '299').split(',').map(Number);
const DUMP = process.argv.includes('--html');

/** Palabras que el portal usa cuando habla del tope de reprogramaciones. */
const LIMIT_WORDS = [
  'restante', 'restantes', 'remaining', 'tentative', 'intento', 'intentos',
  'attempt', 'limit reached', 'límite', 'limite', 'reprogramar', 'reschedule',
  'no puede', 'cannot', 'excedido', 'exceeded',
];

/**
 * Lee el tope de reprogramaciones de la pagina de ADVERTENCIA.
 *
 * El portal la sirve en `/schedule/{id}/appointment` SIN `confirmed_limit_message=1`.
 * Con ese parametro la advertencia se salta y sale el formulario, entonces el numero
 * solo se puede leer en la version sin parametro.
 *
 * Texto real de es-pe (2026-08-27, bot 7):
 *   "Hay un numero maximo de 2 cancelaciones/reprogramaciones permitidas por este
 *    servicio. Le quedan 1 intentos antes de alcanzar el limite."
 */
export function parseRescheduleLimit(html: string): { max: number | null; restantes: number | null } {
  const t = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const max = t.match(/n[uú]mero m[aá]ximo de\s+(\d+)/i)
    ?? t.match(/maximum of\s+(\d+)\s+(?:cancellation|reschedul)/i)
    ?? t.match(/maximum de\s+(\d+)/i);
  const left = t.match(/[Ll]e quedan\s+(\d+)/i)
    ?? t.match(/[Yy]ou have\s+(\d+)\s+(?:attempt|remaining)/i)
    ?? t.match(/(\d+)\s+tentatives?\s+restantes?/i)
    ?? t.match(/(\d+)\s+(?:attempts?|intentos?)\s+(?:remaining|restantes?)/i);
  return { max: max ? Number(max[1]) : null, restantes: left ? Number(left[1]) : null };
}

const strip = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function findLimitText(html: string): string[] {
  const out: string[] = [];
  const text = strip(html);
  const low = text.toLowerCase();
  for (const w of LIMIT_WORDS) {
    let from = 0;
    for (;;) {
      const i = low.indexOf(w, from);
      if (i === -1) break;
      const frag = text.slice(Math.max(0, i - 110), Math.min(text.length, i + 130)).trim();
      if (!out.some((o) => o.includes(frag.slice(20, 60)))) out.push(frag);
      from = i + w.length;
      if (out.length > 14) return out;
    }
  }
  return out;
}

console.log(`MAPA DE CUENTA · host ${os.hostname()} · solo GET\n`);
const rows = await db.select().from(bots).where(inArray(bots.id, IDS));

for (const id of IDS) {
  const r = rows.find((b) => b.id === id);
  if (!r) { console.log(`bot ${id} no existe\n`); continue; }
  const base = `https://ais.usvisa-info.com/${r.locale}/niv`;

  const { result: login, via } = await loginWithFallback({
    email: decrypt(r.visaEmail as string), password: decrypt(r.visaPassword as string),
    scheduleId: String(r.scheduleId), applicantIds: (r.applicantIds ?? []) as string[],
    locale: r.locale ?? 'es-co',
  });

  console.log('═'.repeat(72));
  console.log(`BOT ${id} · ${r.locale} · schedule ${r.scheduleId} · userId ${r.userId}`);
  console.log(`login via ${via} · cookie ${login.cookie ? 'si' : 'NO'} · authenticity ${login.authenticityToken ? 'si' : 'NO'}`);
  console.log('═'.repeat(72));

  const headers = {
    Cookie: `_yatri_session=${login.cookie}`,
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    ...BROWSER_HEADERS,
  };
  /**
   * Pide la URL por las dos rutas y se queda con la mejor respuesta.
   * Un 5xx o un fallo de red NO cortan la busqueda: el portal devuelve 502
   * de forma intermitente y esconderia el resultado bueno de la otra ruta.
   */
  const get = async (url: string) => {
    let best = { html: '', status: 0, via: 'ninguno', loc: null as string | null };
    for (const provider of ['direct', 'webshare'] as const) {
      for (let intento = 1; intento <= 2; intento++) {
        try {
          const { response } = await proxyFetch(url, { headers, redirect: 'manual' }, provider,
            provider === 'direct' ? undefined : (r.proxyUrls as string[] | null) ?? undefined);
          if (response.status === 200) return { html: await response.text(), status: 200, via: provider, loc: null };
          const cand = { html: '', status: response.status, via: provider, loc: response.headers.get('location') };
          // Un 3xx dice mas que un 5xx: es una decision del portal, no una falla.
          if (best.status === 0 || (response.status < 500 && best.status >= 500)) best = cand;
          if (response.status < 500) break;   // 3xx/4xx es definitivo para esta ruta
        } catch { /* red caida: reintenta y luego cambia de ruta */ }
      }
    }
    return best;
  };

  // ── 1. Grupos ──────────────────────────────────────────────────────
  const g = await get(`${base}/groups/${r.userId}`);
  console.log(`\n1) GRUPOS  /groups/${r.userId}  → HTTP ${g.status} via ${g.via}`);
  if (g.status === 200) {
    const cards = [...g.html.matchAll(/<div[^>]*class=['"]([^'"]*\bapplication\b[^'"]*)['"][^>]*>([\s\S]*?)(?=<div[^>]*class=['"][^'"]*\bapplication\b|<\/body>)/g)];
    console.log(`   ${cards.length} card(s) encontrados`);
    for (const c of cards) {
      const cls = c[1]!.trim();
      const body = c[2] ?? '';
      const gid = body.match(/schedule\/(\d+)/)?.[1] ?? body.match(/\b(\d{8})\b/)?.[1] ?? '?';
      const txt = strip(body).slice(0, 150);
      console.log(`   · grupo ${gid}`);
      console.log(`     class : ${cls}`);
      console.log(`     texto : ${txt}`);
    }
    if (!cards.length) console.log(`   texto plano: ${strip(g.html).slice(0, 300)}`);
  } else if (g.loc) {
    console.log(`   redirige a ${g.loc}`);
  }

  // ── 2. Pagina de reprogramar ───────────────────────────────────────
  // Las DOS variantes importan y dicen cosas distintas:
  //   sin parametro  → pagina de ADVERTENCIA, trae el contador de intentos
  //   con parametro  → FORMULARIO, trae authenticity_token y el select de consulado
  const appts = [
    ['advertencia, sin params', `${base}/schedule/${r.scheduleId}/appointment`],
    ['formulario, confirmed_limit_message=1', `${base}/schedule/${r.scheduleId}/appointment?confirmed_limit_message=1`],
  ] as const;
  for (const [label, url] of appts) {
    const a = await get(url);
    console.log(`\n2) REPROGRAMAR (${label}) → HTTP ${a.status} via ${a.via}${a.loc ? ` → ${a.loc.replace(base, '')}` : ''}`);
    if (a.status !== 200) continue;

    const hasAuth = /name=['"]authenticity_token['"]\s+value=['"]([^'"]+)/.exec(a.html);
    const hasFacility = /<select[^>]+consulate_appointment\]\[facility_id[^>]*>/.test(a.html);
    const hasAsc = a.html.includes('asc_appointment_facility_id');
    console.log(`   authenticity_token: ${hasAuth ? `si (${hasAuth[1]!.length} chars)` : 'NO'}`);
    console.log(`   select de consulado: ${hasFacility ? 'si' : 'NO'} · campos ASC: ${hasAsc ? 'si' : 'NO'}`);

    const opts = [...a.html.matchAll(/<option[^>]*value=['"](\d+)['"][^>]*(selected)?[^>]*>([^<]+)</g)]
      .slice(0, 12).map((m) => `${m[1]}=${m[3]!.trim()}${m[2] ? ' [SELECCIONADO]' : ''}`);
    if (opts.length) console.log(`   opciones: ${opts.join(' · ')}`);

    const lim = parseRescheduleLimit(a.html);
    if (lim.max !== null || lim.restantes !== null) {
      console.log(`   TOPE: maximo ${lim.max ?? '?'} · le quedan ${lim.restantes ?? '?'}`);
      const usados = lim.max !== null && lim.restantes !== null ? lim.max - lim.restantes : null;
      if (usados !== null) {
        const enDb = Number(r.rescheduleCount ?? 0);
        console.log(`   usados segun el portal: ${usados} · segun nuestra DB: ${enDb} ${usados === enDb ? '(coinciden)' : '*** NO COINCIDEN ***'}`);
        console.log(`   maxReschedules en DB: ${r.maxReschedules ?? '(sin definir)'} ${r.maxReschedules === lim.max ? '(coincide)' : '*** revisar ***'}`);
      }
    }
    const hits = findLimitText(a.html).filter((h) => !h.includes('MODULE_NOT_FOUND'));
    if (hits.length) {
      console.log(`   texto original:`);
      for (const h of hits.slice(0, 2)) console.log(`      "${h}"`);
    }

    if (DUMP) {
      const path = `/private/tmp/claude-501/-Users-juanortega-visa-scraper/3042e4c9-8b47-4b04-98b4-8c3ab17929ab/scratchpad/appt-${id}.html`;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, a.html);
      console.log(`\n   HTML completo en ${path} (${a.html.length} bytes)`);
    }
  }
  console.log('');
}
process.exit(0);

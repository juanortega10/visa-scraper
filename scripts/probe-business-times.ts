/**
 * Que trae `times.json` en CADA dia de un rango, este o no en `days.json`.
 *
 * Nace de una hipotesis con n = 1. El 2026-08-31 se midio una sola fecha con cupo:
 *
 *   2028-01-12   available ["09:45"]   business ["09:45","10:00","10:15","10:30"]
 *   2026-09-05   available [null]      business []
 *
 * De ahi se supuso que `business_times` es el horario del consulado y
 * `available_times` el subconjunto libre. Una muestra no alcanza para afirmarlo.
 * Este script junta las muestras que faltan.
 *
 * Las tres preguntas que responde:
 *
 *   1. Es `available_times` SIEMPRE un subconjunto de `business_times`?
 *      Si aparece una hora libre que no esta en el horario, la hipotesis se cae.
 *   2. Sale `business_times` lleno en algun dia que `days.json` NO ofrece?
 *      Si sale, sirve para adivinar horas sin depender del calendario.
 *   3. Depende `business_times` del dia de la semana?
 *      Un horario de consulado deberia repetirse por dia de semana.
 *
 * SOLO GET. Ni un POST. No toca la cita de nadie.
 *
 * CARGA: una peticion por dia del rango. 180 dias son 180 peticiones. Va con
 * espaciado y por webshare (IP rotativa) porque el portal ya cerro la ruta del
 * schedule 75610929 dos veces este mes. NO lo corras contra un bot bloqueado.
 *
 *   npx tsx --env-file=.env scripts/probe-business-times.ts --bot 7 --dias 180
 *   npx tsx --env-file=.env scripts/probe-business-times.ts --bot 7 --dias 30 --espera 3000
 */
import { writeFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { loginWithFallback } from '../src/services/login.js';
import { proxyFetch } from '../src/services/proxy-fetch.js';
import { USER_AGENT } from '../src/utils/constants.js';

const argS = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const BOT = Number(argS('bot', '7'));
const DIAS = Number(argS('dias', '180'));
/** Espaciado entre peticiones. Con 2.500 ms son 24 por minuto, ~4x el ritmo normal de es-pe. */
const ESPERA = Number(argS('espera', '2500'));
const SALIDA = argS('salida', `/tmp/business-times-bot${BOT}.json`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad = (v: unknown, n: number) => String(v ?? '').padStart(n);
const padr = (v: unknown, n: number) => String(v ?? '').padEnd(n);
const DIA_SEMANA = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];

const [b] = await db.select().from(bots).where(eq(bots.id, BOT));
if (!b) { console.error(`bot ${BOT} no existe`); process.exit(1); }

const { result: login, via } = await loginWithFallback({
  email: decrypt(b.visaEmail as string), password: decrypt(b.visaPassword as string),
  scheduleId: String(b.scheduleId), applicantIds: (b.applicantIds ?? []) as string[],
  locale: b.locale ?? 'es-pe',
});
const base = `https://ais.usvisa-info.com/${b.locale}/niv/schedule/${b.scheduleId}/appointment`;
const FAC = String(b.consularFacilityId ?? '115');
const H = {
  Cookie: `_yatri_session=${login.cookie}`,
  'User-Agent': USER_AGENT,
  'X-CSRF-Token': login.csrfToken ?? '',
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json, text/javascript, */*; q=0.01',
};

/** Un GET con reintentos. El portal cierra el socket de vez en cuando sin motivo. */
async function pedir(url: string): Promise<{ ok: boolean; texto: string; ms: number }> {
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    try {
      const { response } = await proxyFetch(url, { headers: H }, 'webshare', b!.proxyUrls as string[] | null);
      return { ok: response.status === 200, texto: await response.text(), ms: Date.now() - t };
    } catch {
      await sleep(1200);
    }
  }
  return { ok: false, texto: '', ms: 0 };
}

console.log(`\nSONDA business_times · bot ${BOT} · ${b.locale} · schedule ${b.scheduleId} · facility ${FAC}`);
console.log(`login por ${via} · ${DIAS} dias · ${ESPERA} ms entre peticiones · SOLO GET\n`);

// ── El calendario, para saber que dias SI ofrece el portal ───────────────────
const dRes = await pedir(`${base}/days/${FAC}.json?appointments[expedite]=false`);
let ofrecidas = new Set<string>();
try {
  ofrecidas = new Set((JSON.parse(dRes.texto) as Array<{ date: string }>).map((d) => d.date));
} catch { /* days.json no respondio json */ }
console.log(`days.json ofrece ${ofrecidas.size} fechas${ofrecidas.size ? `, la primera ${[...ofrecidas].sort()[0]}` : ''}\n`);

// ── Barrido dia por dia ──────────────────────────────────────────────────────
interface Muestra {
  fecha: string; diaSemana: string; enDays: boolean;
  available: string[]; business: string[]; crudo: string; ms: number; ok: boolean;
}
const muestras: Muestra[] = [];
const hoy = new Date();
let fallos = 0;

for (let i = 1; i <= DIAS; i++) {
  const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() + i));
  const fecha = d.toISOString().slice(0, 10);
  const r = await pedir(`${base}/times/${FAC}.json?date=${fecha}&appointments[expedite]=false`);
  let available: string[] = [];
  let business: string[] = [];
  try {
    const j = JSON.parse(r.texto) as { available_times?: (string | null)[]; business_times?: (string | null)[] };
    available = (j.available_times ?? []).filter((x): x is string => !!x);
    business = (j.business_times ?? []).filter((x): x is string => !!x);
  } catch { fallos += 1; }
  muestras.push({
    fecha, diaSemana: DIA_SEMANA[d.getUTCDay()]!, enDays: ofrecidas.has(fecha),
    available, business, crudo: r.texto.slice(0, 200), ms: r.ms, ok: r.ok,
  });
  // Solo se imprime lo que trae algo. 180 renglones vacios no dicen nada.
  if (business.length > 0 || available.length > 0 || ofrecidas.has(fecha)) {
    console.log(`  ${fecha} ${padr(DIA_SEMANA[d.getUTCDay()], 4)} ${ofrecidas.has(fecha) ? 'EN-DAYS' : '       '}` +
      ` avail ${padr(`[${available.join(',')}]`, 30)} business [${business.join(',')}]`);
  }
  if (i % 30 === 0) console.log(`  ... ${i}/${DIAS}`);
  await sleep(ESPERA);
}

// ── Y las fechas que el calendario SI ofrece ────────────────────────────────
// Son las unicas que pueden traer `business_times` lleno, entonces son las unicas
// que responden P1 y P3. Casi nunca caen dentro del rango de 6 meses: en es-pe el
// portal ofrece enero de 2028. Sin este bloque el barrido sale sin una sola muestra
// del caso poblado, y las tres preguntas quedan abiertas.
const yaVistas = new Set(muestras.map((m) => m.fecha));
const pendientes = [...ofrecidas].sort().filter((f) => !yaVistas.has(f));
if (pendientes.length > 0) {
  console.log(`\n  ── ${pendientes.length} fechas del calendario, fuera del rango de ${DIAS} dias ──`);
  for (const fecha of pendientes) {
    const d = new Date(`${fecha}T00:00:00Z`);
    const r = await pedir(`${base}/times/${FAC}.json?date=${fecha}&appointments[expedite]=false`);
    let available: string[] = [];
    let business: string[] = [];
    try {
      const j = JSON.parse(r.texto) as { available_times?: (string | null)[]; business_times?: (string | null)[] };
      available = (j.available_times ?? []).filter((x): x is string => !!x);
      business = (j.business_times ?? []).filter((x): x is string => !!x);
    } catch { fallos += 1; }
    muestras.push({
      fecha, diaSemana: DIA_SEMANA[d.getUTCDay()]!, enDays: true,
      available, business, crudo: r.texto.slice(0, 200), ms: r.ms, ok: r.ok,
    });
    console.log(`  ${fecha} ${padr(DIA_SEMANA[d.getUTCDay()], 4)} EN-DAYS` +
      ` avail ${padr(`[${available.join(',')}]`, 30)} business [${business.join(',')}]`);
    await sleep(ESPERA);
  }
}

writeFileSync(SALIDA, JSON.stringify(muestras, null, 1));
console.log(`\n${muestras.length} muestras guardadas en ${SALIDA}${fallos ? ` · ${fallos} sin json` : ''}`);

// ── Las tres preguntas ───────────────────────────────────────────────────────
const linea = (t: string) => console.log(`\n${'─'.repeat(84)}\n${t}\n${'─'.repeat(84)}`);

linea('P1 · Es available_times siempre un subconjunto de business_times?');
const conAvail = muestras.filter((m) => m.available.length > 0);
const fuera = conAvail.filter((m) => m.available.some((h) => !m.business.includes(h)));
console.log(`  ${conAvail.length} dias con horas libres.`);
if (conAvail.length === 0) console.log('  SIN MUESTRA. La pregunta queda abierta.');
else if (fuera.length === 0) console.log(`  ${conAvail.length} de ${conAvail.length} cumplen. La hipotesis aguanta con esta muestra.`);
else {
  console.log(`  ROTA: ${fuera.length} dias con una hora libre que NO esta en business_times.`);
  for (const m of fuera.slice(0, 5)) console.log(`    ${m.fecha} avail [${m.available}] business [${m.business}]`);
}

linea('P2 · Sale business_times lleno en un dia que days.json NO ofrece?');
const fueraDeDays = muestras.filter((m) => !m.enDays);
const conBusiness = fueraDeDays.filter((m) => m.business.length > 0);
console.log(`  ${fueraDeDays.length} dias fuera del calendario · ${conBusiness.length} con business_times lleno.`);
if (conBusiness.length === 0) {
  console.log('  NUNCA. business_times solo aparece en dias que el calendario ya ofrece.');
  console.log('  Entonces NO sirve para adivinar la hora de una fecha que el portal no lista.');
} else {
  console.log('  SI. Sirve como lista de candidatos sin depender del calendario:');
  for (const m of conBusiness.slice(0, 10)) console.log(`    ${m.fecha} ${m.diaSemana} business [${m.business}]`);
}

linea('P3 · Depende business_times del dia de la semana?');
const porDia = new Map<string, Set<string>>();
for (const m of muestras) {
  if (m.business.length === 0) continue;
  const s = porDia.get(m.diaSemana) ?? new Set<string>();
  s.add(m.business.join(','));
  porDia.set(m.diaSemana, s);
}
if (porDia.size === 0) console.log('  SIN MUESTRA: ningun dia trajo business_times.');
else {
  for (const d of DIA_SEMANA) {
    const s = porDia.get(d);
    if (!s) continue;
    console.log(`  ${d}: ${s.size} horario(s) distinto(s)`);
    for (const h of [...s].slice(0, 3)) console.log(`      [${h}]`);
  }
}

linea('P4 · Es business_times INDEPENDIENTE de available_times, o derivado?');
// Esta es la pregunta que decide todo. Si `business_times` sale DE `available_times`,
// entonces cuando `available` esta vacio `business` tambien lo estara, y no sirve para
// adivinar la hora en el caso `no_times`, que es justo para lo que se queria usar.
if (conAvail.length === 0) console.log('  SIN MUESTRA.');
else {
  const enMinutos = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3));
  const contigua = (a: string[]) => a.every((h, i) => i === 0 || enMinutos(h) - enMinutos(a[i - 1]!) === 15);
  const mismoInicio = conAvail.filter((m) => m.business[0] === m.available[0]).length;
  const rejillas = conAvail.filter((m) => contigua(m.business)).length;
  const finales = new Set(conAvail.map((m) => m.business.at(-1)));
  const tamanos = new Set(conAvail.map((m) => m.available.length));
  console.log(`  business[0] === available[0]        ${mismoInicio} de ${conAvail.length}`);
  console.log(`  business es rejilla de 15 min       ${rejillas} de ${conAvail.length}`);
  console.log(`  ultima hora de business             ${[...finales].join(', ')}`);
  console.log(`  cuantas horas trae available        ${[...tamanos].join(', ')}`);
  if (mismoInicio === conAvail.length && rejillas === conAvail.length && finales.size === 1) {
    console.log('\n  DERIVADO. business_times es la rejilla de 15 min que va DESDE la hora libre');
    console.log('  hasta el cierre. Su primer elemento nunca es otro que available[0].');
    console.log('  Entonces con available vacio, business tambien saldra vacio, y NO sirve');
    console.log('  para adivinar la hora en el caso no_times.');
  } else {
    console.log('\n  NO se ve derivado. Hay dias donde business empieza antes que available,');
    console.log('  entonces trae informacion propia y si podria servir de lista de candidatos.');
  }
}

linea('RESPUESTAS CRUDAS distintas que devolvio el portal');
const crudos = new Map<string, number>();
for (const m of muestras) crudos.set(m.crudo, (crudos.get(m.crudo) ?? 0) + 1);
for (const [c, n] of [...crudos.entries()].sort((a, z) => z[1] - a[1]).slice(0, 8)) {
  console.log(`  ${pad(n, 4)}x  ${c || '(vacio)'}`);
}

console.log('\nLIMITE: esto NO mide el caso que importa, un dia DENTRO de days.json con');
console.log('available_times vacio. Ese caso no se puede provocar, hay que esperarlo.\n');
process.exit(0);

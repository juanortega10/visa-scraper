/**
 * Que cupos CERCANOS aparecen, y a que hora.
 *
 * Responde dos preguntas que se ven parecidas y tienen fuentes distintas:
 *
 *   1. QUE FECHAS aparecen y a cuantos dias. Fuente `poll_logs.top_dates`, que guarda
 *      lo que devolvio `days.json`. Es una fuente de OFERTA: dice que existio, sin
 *      importar si lo agarramos. Sin sesgo de exito.
 *
 *   2. A QUE HORA. Fuente `reschedule_logs` con `success = true` y `new_consular_time`.
 *      El portal ACEPTO esa hora, entonces la hora existia de verdad.
 *
 * Por que la 2 no sale de `days.json`: `days.json` da dias, nunca horas. La unica otra
 * fuente de horas es `reschedule_logs.detail.timesFound`, y esa esta CONTAMINADA por
 * `SPECULATIVE_TIMES`. Ver [[horas-especulativas-contaminadas]].
 *
 * SESGO que hay que tener presente en la pregunta 2: son los cupos que GANAMOS, no los
 * que aparecieron. Si el bot llega tarde a las horas tempranas, este histograma sale
 * corrido hacia las tardias. Contra eso no hay dato hoy. La pregunta 1 no tiene ese
 * problema, porque `top_dates` se escribe mire quien mire.
 *
 *   npx tsx --env-file=.env scripts/analyze-cupos-cercanos.ts
 *   npx tsx --env-file=.env scripts/analyze-cupos-cercanos.ts --locale es-pe
 *   npx tsx --env-file=.env scripts/analyze-cupos-cercanos.ts --cerca 90 --dias 60
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';

const argS = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const LOCALE = argS('locale', 'todos');
/** Un cupo cuenta como CERCANO si esta a menos de estos dias. */
const CERCA = Number(argS('cerca', '180'));
/** Ventana de historia a mirar. `poll_logs` se poda a 30 dias. */
const DIAS = Number(argS('dias', '30'));

const FILTRO_LOC = LOCALE === 'todos' ? sql`` : sql`AND b.locale = ${LOCALE}`;
const pad = (v: unknown, n: number) => String(v ?? '').padStart(n);
const padr = (v: unknown, n: number) => String(v ?? '').padEnd(n);
const h = (t: string) => console.log(`\n${'─'.repeat(88)}\n${t}\n${'─'.repeat(88)}`);
const barra = (v: number, max: number, ancho = 26) =>
  '█'.repeat(Math.max(v > 0 ? 1 : 0, Math.round((v / Math.max(max, 1)) * ancho)));

console.log(`\nCUPOS CERCANOS · locale ${LOCALE} · cercano = menos de ${CERCA} dias · ultimos ${DIAS} dias`);
console.log('poll_logs se poda a 30 dias: pedir mas no trae mas.');

// ── 1. A cuantos dias aparecen las fechas ofrecidas ──────────────────────────
h(`1. A CUANTOS DIAS estan las fechas que ofrece days.json (fuente: poll_logs.top_dates)`);

const tramos = await db.execute(sql`
  WITH ofertas AS (
    SELECT b.locale,
           (d.value #>> '{}')::date - p.created_at::date AS dias
    FROM poll_logs p
    JOIN bots b ON b.id = p.bot_id
    CROSS JOIN LATERAL jsonb_array_elements(p.top_dates) AS d(value)
    WHERE p.top_dates IS NOT NULL
      AND p.created_at > now() - (${DIAS} || ' days')::interval
      ${FILTRO_LOC}
  )
  SELECT locale,
         CASE WHEN dias < 0 THEN 'pasada'
              WHEN dias < 8 THEN '0-7'
              WHEN dias < 15 THEN '8-14'
              WHEN dias < 31 THEN '15-30'
              WHEN dias < 61 THEN '31-60'
              WHEN dias < 91 THEN '61-90'
              WHEN dias < 181 THEN '91-180'
              WHEN dias < 366 THEN '181-365'
              ELSE '365+' END AS tramo,
         min(dias) mind, count(*) n
  FROM ofertas GROUP BY 1,2 ORDER BY 1, mind
`);

const orden = ['pasada', '0-7', '8-14', '15-30', '31-60', '61-90', '91-180', '181-365', '365+'];
type T = { locale: string; tramo: string; n: string };
const porLocale = new Map<string, Map<string, number>>();
for (const r of tramos.rows as unknown as T[]) {
  if (!porLocale.has(r.locale)) porLocale.set(r.locale, new Map());
  porLocale.get(r.locale)!.set(r.tramo, Number(r.n));
}
for (const [loc, m] of [...porLocale.entries()].sort()) {
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  const max = Math.max(...m.values());
  const cercanas = orden
    .filter((t) => t !== 'pasada' && Number(t.split('-')[0]) < CERCA)
    .reduce((a, t) => a + (m.get(t) ?? 0), 0);
  console.log(`\n  ${loc} · ${total.toLocaleString()} apariciones de fecha · ${((100 * cercanas) / total).toFixed(1)}% a menos de ${CERCA} dias`);
  for (const t of orden) {
    const v = m.get(t);
    if (v === undefined) continue;
    console.log(`    ${padr(t, 9)} ${pad(v.toLocaleString(), 9)} ${pad(`${((100 * v) / total).toFixed(1)}%`, 7)}  ${barra(v, max)}`);
  }
}
console.log('\n  Una fecha que sale en 500 polls cuenta 500 veces: esto pesa PERMANENCIA, no eventos.');
console.log('  Para eventos, mira la seccion 2, que cuenta un renglon por reagendamiento.');

// ── 2. Horas reales de los cupos que se ganaron ──────────────────────────────
h('2. A QUE HORA quedaron los cupos que SI se ganaron (fuente: reschedule_logs success)');

const horas = await db.execute(sql`
  SELECT b.locale, r.new_consular_time hora, count(*) n,
         count(*) FILTER (WHERE r.new_consular_date - r.created_at::date < ${CERCA}) cercanos
  FROM reschedule_logs r JOIN bots b ON b.id = r.bot_id
  WHERE r.success AND r.new_consular_time IS NOT NULL ${FILTRO_LOC}
  GROUP BY 1,2 ORDER BY 1, 3 DESC
`);
type Hr = { locale: string; hora: string; n: string; cercanos: string };
const hPorLoc = new Map<string, Hr[]>();
for (const r of horas.rows as unknown as Hr[]) {
  if (!hPorLoc.has(r.locale)) hPorLoc.set(r.locale, []);
  hPorLoc.get(r.locale)!.push(r);
}
for (const [loc, lista] of [...hPorLoc.entries()].sort()) {
  const total = lista.reduce((a, r) => a + Number(r.n), 0);
  const max = Math.max(...lista.map((r) => Number(r.n)));
  console.log(`\n  ${loc} · ${total} reagendamientos con hora real · ${lista.length} horas distintas`);
  let acum = 0;
  for (const r of lista.slice(0, 14)) {
    acum += Number(r.n);
    console.log(
      `    ${padr(r.hora, 7)} ${pad(r.n, 5)} ${pad(`${((100 * Number(r.n)) / total).toFixed(1)}%`, 7)}` +
      ` ${pad(`ac ${((100 * acum) / total).toFixed(0)}%`, 8)}  ${barra(Number(r.n), max)}`,
    );
  }
  if (lista.length > 14) console.log(`    ... y ${lista.length - 14} horas mas`);
}

// ── 3. Cuando aparece un cupo cercano, a cuantos dias y a que hora ───────────
h(`3. LOS CUPOS CERCANOS GANADOS, uno por uno (menos de ${CERCA} dias)`);

const cerca = await db.execute(sql`
  SELECT b.locale, r.bot_id, r.created_at, r.new_consular_date fecha, r.new_consular_time hora,
         r.new_consular_date - r.created_at::date dias,
         r.old_consular_date - r.new_consular_date ganados
  FROM reschedule_logs r JOIN bots b ON b.id = r.bot_id
  WHERE r.success AND r.new_consular_time IS NOT NULL
    AND r.new_consular_date - r.created_at::date < ${CERCA} ${FILTRO_LOC}
  ORDER BY dias
`);
type C = { locale: string; bot_id: number; fecha: string; hora: string; dias: number; ganados: number };
const filasC = cerca.rows as unknown as C[];
console.log(`\n  ${filasC.length} cupos ganados a menos de ${CERCA} dias.\n`);
if (filasC.length) {
  console.log(`  ${padr('locale', 8)}${pad('bot', 5)}  ${padr('fecha', 12)}${padr('hora', 7)}${pad('dias', 6)}${pad('adelanto', 10)}`);
  for (const r of filasC.slice(0, 30)) {
    console.log(`  ${padr(r.locale, 8)}${pad(r.bot_id, 5)}  ${padr(r.fecha, 12)}${padr(r.hora, 7)}${pad(r.dias, 6)}${pad(`${r.ganados} d`, 10)}`);
  }
  if (filasC.length > 30) console.log(`  ... y ${filasC.length - 30} mas`);

  // La hora depende de la distancia? Es la pregunta que decide si se puede adivinar.
  const cercanos = filasC.filter((r) => r.dias < 30).map((r) => r.hora).sort();
  const lejanos = filasC.filter((r) => r.dias >= 30).map((r) => r.hora).sort();
  const moda = (a: string[]) => {
    const m = new Map<string, number>();
    for (const x of a) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m.entries()].sort((p, q) => q[1] - p[1]).slice(0, 3).map(([k, v]) => `${k} (${v})`).join(', ');
  };
  console.log(`\n  a menos de 30 dias (${cercanos.length}): ${moda(cercanos) || 'sin muestra'}`);
  console.log(`  de 30 a ${CERCA} dias (${lejanos.length}): ${moda(lejanos) || 'sin muestra'}`);
}

console.log('\nSESGO: la seccion 2 y la 3 cuentan los cupos que GANAMOS, no los que aparecieron.');
console.log('Si el bot llega tarde a las horas tempranas, el histograma sale corrido. No hay dato contra eso.\n');
process.exit(0);

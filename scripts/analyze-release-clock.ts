/**
 * ¿En que segundo del minuto libera cupos el portal?
 *
 * Si hay un borde, alinear la fase del poll a ese borde sube la tasa de captura
 * sin subir el numero de peticiones. Es la optimizacion mas barata que existe.
 *
 * Metodo. La fila de `poll_logs` se escribe al final del run, entonces su
 * `created_at` NO es el momento del fetch. Se reconstruye asi:
 *
 *   momento_fetch = created_at - response_time_ms + load + fetch
 *
 * Se agrupa por el segundo del minuto de ese momento.
 *
 * SESGO A TENER EN CUENTA: `poll_logs` tiene reduccion de escritura. Las filas con
 * cambio de fecha SIEMPRE se guardan; las tranquilas se guardan por latido cada
 * 5 min. Entonces el denominador NO son todos los polls. El latido es por tiempo,
 * no por segundo del minuto, asi que la COMPARACION ENTRE TRAMOS sigue siendo
 * valida. La tasa absoluta esta inflada; la forma de la curva no.
 *
 * Solo lectura.
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/analyze-release-clock.ts
 *   npx tsx --env-file=.env scripts/analyze-release-clock.ts --locale es-pe --dias 20
 *   npx tsx --env-file=.env scripts/analyze-release-clock.ts --paso 5
 *   npx tsx --env-file=.env scripts/analyze-release-clock.ts --meses 6
 *
 * `--meses N` separa las fechas CERCANAS (a menos de N meses de hoy) del resto.
 * Una fecha a 18 meses no sirve para casi nadie; el patron que importa es el de
 * las cercanas.
 */
import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

const argOf = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const DAYS = Number(argOf('--dias') ?? 10);
const STEP = Number(argOf('--paso') ?? 10);
const LOCALE = argOf('--locale');
const MESES = Number(argOf('--meses') ?? 6);
const onlyLocale = LOCALE ? sql`AND b.locale = ${LOCALE}` : sql``;

const rows = (await db.execute(sql`
  WITH base AS (
    SELECT
      p.created_at
        - make_interval(secs => COALESCE(p.response_time_ms, 0) / 1000.0)
        + make_interval(secs => (COALESCE((p.phase_timings->>'load')::int, 0)
                               + COALESCE((p.phase_timings->>'fetch')::int, 0)) / 1000.0) AS t_fetch,
      jsonb_array_length(COALESCE(p.date_changes->'appeared', '[]'::jsonb)) AS nuevas,
      (SELECT count(*) FROM jsonb_array_elements_text(COALESCE(p.date_changes->'appeared', '[]'::jsonb)) d
        WHERE d.value ~ '^\\d{4}-\\d{2}-\\d{2}$'
          AND d.value::date < (now() + interval '${sql.raw(String(MESES))} months')::date) AS cercanas
    FROM poll_logs p JOIN bots b ON b.id = p.bot_id
    WHERE p.created_at > now() - interval '${sql.raw(String(DAYS))} days'
      AND p.phase_timings IS NOT NULL
      ${onlyLocale}
  )
  SELECT (floor(extract(second FROM t_fetch) / ${sql.raw(String(STEP))}) * ${sql.raw(String(STEP))})::int AS tramo,
         count(*) AS polls,
         count(*) FILTER (WHERE nuevas > 0) AS con_nuevas,
         COALESCE(sum(nuevas), 0) AS fechas_nuevas,
         count(*) FILTER (WHERE cercanas > 0) AS con_cercanas,
         COALESCE(sum(cercanas), 0) AS fechas_cercanas
  FROM base GROUP BY tramo ORDER BY tramo
`)).rows as any[];

const totPolls = rows.reduce((a, r) => a + Number(r.polls), 0);
const totCon = rows.reduce((a, r) => a + Number(r.con_nuevas), 0);
const totFechas = rows.reduce((a, r) => a + Number(r.fechas_nuevas), 0);
const totCerca = rows.reduce((a, r) => a + Number(r.con_cercanas), 0);
const totFechasCerca = rows.reduce((a, r) => a + Number(r.fechas_cercanas), 0);

console.log(`RELOJ DE LIBERACION · ${DAYS} dias · tramos de ${STEP}s${LOCALE ? ` · ${LOCALE}` : ' · toda la flota'}`);
console.log(`${totPolls.toLocaleString('es')} filas · ${totCon.toLocaleString('es')} con fecha nueva (${totFechas.toLocaleString('es')} fechas)`);
console.log(`de esas, CERCANAS (< ${MESES} meses): ${totCerca.toLocaleString('es')} filas · ${totFechasCerca.toLocaleString('es')} fechas\n`);

if (!rows.length) { console.log('sin datos'); process.exit(0); }

const tasaGlobal = totCon / Math.max(1, totPolls);
const tasaCerca = totCerca / Math.max(1, totPolls);
const maxTasa = Math.max(...rows.map((r) => Number(r.con_nuevas) / Math.max(1, Number(r.polls))));
const maxCerca = Math.max(...rows.map((r) => Number(r.con_cercanas) / Math.max(1, Number(r.polls))), 1e-9);
const pad = (v: unknown, n: number) => String(v).padStart(n);

console.log(`${'tramo'.padEnd(9)}${pad('polls', 7)}${pad('todas', 7)}${pad('tasa', 7)}${pad('<' + MESES + 'm', 7)}${pad('tasa', 7)}${pad('vs media', 9)}  curva (cercanas)`);
for (const r of rows) {
  const polls = Number(r.polls), con = Number(r.con_nuevas), cerca = Number(r.con_cercanas);
  const tasa = con / Math.max(1, polls);
  const tc = cerca / Math.max(1, polls);
  const lift = tc / Math.max(1e-9, tasaCerca);
  const bar = '█'.repeat(Math.max(0, Math.round((tc / Math.max(1e-9, maxCerca)) * 38)));
  const marca = lift >= 1.15 ? ' ←' : '';
  console.log(
    `${`${r.tramo}-${Number(r.tramo) + STEP - 1}s`.padEnd(9)}${pad(polls.toLocaleString('es'), 7)}` +
    `${pad(con.toLocaleString('es'), 7)}${pad((tasa * 100).toFixed(1) + '%', 7)}` +
    `${pad(cerca.toLocaleString('es'), 7)}${pad((tc * 100).toFixed(1) + '%', 7)}` +
    `${pad(lift.toFixed(2) + 'x', 9)}  ${bar}${marca}`,
  );
}

const rate = (r: any) => Number(r.con_cercanas) / Math.max(1, Number(r.polls));
const mejor = rows.reduce((a, r) => (rate(r) > rate(a) ? r : a));
const peor = rows.reduce((a, r) => (rate(r) < rate(a) ? r : a));
const tMejor = rate(mejor);
const tPeor = rate(peor);

console.log(`\nmedia de cercanas: ${(tasaCerca * 100).toFixed(2)}%  (todas: ${(tasaGlobal * 100).toFixed(2)}%)`);
console.log(`mejor tramo:  ${mejor.tramo}-${Number(mejor.tramo) + STEP - 1}s  ${(tMejor * 100).toFixed(2)}%  (${(tMejor / tasaGlobal).toFixed(2)}x)`);
console.log(`peor tramo:   ${peor.tramo}-${Number(peor.tramo) + STEP - 1}s  ${(tPeor * 100).toFixed(2)}%  (${(tPeor / tasaGlobal).toFixed(2)}x)`);
// Un tramo con cero aciertos no da un cociente util. Se compara contra la media.
const liftMejor = tMejor / Math.max(1e-9, tasaCerca);
console.log(tPeor > 0
  ? `separacion mejor/peor: ${(tMejor / tPeor).toFixed(1)}x`
  : `el peor tramo no vio ninguna fecha cercana`);
console.log(`el mejor tramo rinde ${liftMejor.toFixed(2)}x la media`);
if (liftMejor < 1.3) {
  console.log('\nLectura: la curva es plana. No hay borde util que perseguir.');
} else {
  console.log(`\nLectura: hay borde. Alinear la fase del poll al tramo ${mejor.tramo}s sube la captura.`);
}
process.exit(0);

/**
 * ¿En que MOMENTO de la semana libera cupos el portal?
 *
 * Complementa a `analyze-release-clock.ts`, que mira el segundo del minuto.
 * Aqui se mira la hora del dia (tramos de 30 min) y el dia de la semana.
 *
 * Solo cuentan las fechas CERCANAS (menos de N meses), porque una fecha a 18
 * meses no le sirve a casi nadie.
 *
 * Todo en UTC-5 (Bogota/Lima), que es la hora que usa Juan.
 *
 * SESGO: `poll_logs` tiene reduccion de escritura, entonces la tasa absoluta esta
 * inflada. La reduccion no depende de la hora, asi que la COMPARACION entre tramos
 * se sostiene. Ademas se normaliza por cuantos polls caen en cada tramo.
 *
 * Solo lectura.
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/analyze-release-calendar.ts
 *   npx tsx --env-file=.env scripts/analyze-release-calendar.ts --locale es-pe --dias 30
 *   npx tsx --env-file=.env scripts/analyze-release-calendar.ts --meses 6 --paso 30
 */
import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

const argOf = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const DAYS = Number(argOf('--dias') ?? 10);
const MESES = Number(argOf('--meses') ?? 6);
const PASO = Number(argOf('--paso') ?? 30);   // minutos por tramo
const LOCALE = argOf('--locale');
const onlyLocale = LOCALE ? sql`AND b.locale = ${LOCALE}` : sql``;

const base = sql`
  WITH base AS (
    SELECT
      p.created_at - interval '5 hours' AS t_local,
      (SELECT count(*) FROM jsonb_array_elements_text(COALESCE(p.date_changes->'appeared', '[]'::jsonb)) d
        WHERE d.value ~ '^\\d{4}-\\d{2}-\\d{2}$'
          AND d.value::date < (now() + interval '${sql.raw(String(MESES))} months')::date) AS cercanas
    FROM poll_logs p JOIN bots b ON b.id = p.bot_id
    WHERE p.created_at > now() - interval '${sql.raw(String(DAYS))} days'
      AND p.phase_timings IS NOT NULL
      ${onlyLocale}
  )`;

const pad = (v: unknown, n: number) => String(v).padStart(n);
const DOW = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

console.log(`CALENDARIO DE LIBERACION · ${DAYS} dias · fechas a menos de ${MESES} meses${LOCALE ? ` · ${LOCALE}` : ' · toda la flota'}`);
console.log(`hora local UTC-5 (Bogota/Lima)\n`);

// ── Por hora del dia ─────────────────────────────────────────────────
const horas = (await db.execute(sql`
  ${base}
  SELECT (floor((extract(hour FROM t_local) * 60 + extract(minute FROM t_local)) / ${sql.raw(String(PASO))}) * ${sql.raw(String(PASO))})::int AS min_del_dia,
         count(*) AS polls,
         count(*) FILTER (WHERE cercanas > 0) AS con_cercanas
  FROM base GROUP BY min_del_dia ORDER BY min_del_dia`)).rows as any[];

const totP = horas.reduce((a, r) => a + Number(r.polls), 0);
const totC = horas.reduce((a, r) => a + Number(r.con_cercanas), 0);
const media = totC / Math.max(1, totP);
const maxT = Math.max(...horas.map((r) => Number(r.con_cercanas) / Math.max(1, Number(r.polls))), 1e-9);

console.log(`── POR HORA DEL DIA (tramos de ${PASO} min) ──`);
console.log(`${'hora'.padEnd(8)}${pad('polls', 8)}${pad('cercanas', 10)}${pad('tasa', 8)}${pad('vs media', 10)}  curva`);
for (const r of horas) {
  const m = Number(r.min_del_dia);
  const hh = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const polls = Number(r.polls), c = Number(r.con_cercanas);
  const tasa = c / Math.max(1, polls);
  const lift = tasa / Math.max(1e-9, media);
  const bar = '█'.repeat(Math.max(0, Math.round((tasa / maxT) * 34)));
  console.log(`${hh.padEnd(8)}${pad(polls.toLocaleString('es'), 8)}${pad(c.toLocaleString('es'), 10)}${pad((tasa * 100).toFixed(1) + '%', 8)}${pad(lift.toFixed(2) + 'x', 10)}  ${bar}${lift >= 1.3 ? ' ←' : ''}`);
}

// ── Por dia de la semana ─────────────────────────────────────────────
const dias = (await db.execute(sql`
  ${base}
  SELECT extract(dow FROM t_local)::int AS dow,
         count(*) AS polls,
         count(*) FILTER (WHERE cercanas > 0) AS con_cercanas
  FROM base GROUP BY dow ORDER BY dow`)).rows as any[];

const maxD = Math.max(...dias.map((r) => Number(r.con_cercanas) / Math.max(1, Number(r.polls))), 1e-9);
console.log(`\n── POR DIA DE LA SEMANA ──`);
console.log(`${'dia'.padEnd(11)}${pad('polls', 8)}${pad('cercanas', 10)}${pad('tasa', 8)}${pad('vs media', 10)}  curva`);
for (const r of dias) {
  const polls = Number(r.polls), c = Number(r.con_cercanas);
  const tasa = c / Math.max(1, polls);
  const lift = tasa / Math.max(1e-9, media);
  const bar = '█'.repeat(Math.max(0, Math.round((tasa / maxD) * 34)));
  console.log(`${DOW[Number(r.dow)]!.padEnd(11)}${pad(polls.toLocaleString('es'), 8)}${pad(c.toLocaleString('es'), 10)}${pad((tasa * 100).toFixed(1) + '%', 8)}${pad(lift.toFixed(2) + 'x', 10)}  ${bar}${lift >= 1.3 ? ' ←' : ''}`);
}

// ── Cruce dia x franja ───────────────────────────────────────────────
const cruce = (await db.execute(sql`
  ${base}
  SELECT extract(dow FROM t_local)::int AS dow,
         (floor(extract(hour FROM t_local) / 4) * 4)::int AS franja,
         count(*) AS polls,
         count(*) FILTER (WHERE cercanas > 0) AS con_cercanas
  FROM base GROUP BY dow, franja ORDER BY dow, franja`)).rows as any[];

const franjas = [...new Set(cruce.map((r) => Number(r.franja)))].sort((a, b) => a - b);
console.log(`\n── CRUCE dia x franja de 4h (tasa de cercanas) ──`);
console.log(`${'dia'.padEnd(11)}${franjas.map((f) => pad(`${String(f).padStart(2, '0')}h`, 8)).join('')}`);
for (const d of [1, 2, 3, 4, 5, 6, 0]) {
  const fila = franjas.map((f) => {
    const r = cruce.find((x) => Number(x.dow) === d && Number(x.franja) === f);
    if (!r || Number(r.polls) < 30) return pad('·', 8);
    const t = Number(r.con_cercanas) / Number(r.polls);
    return pad((t * 100).toFixed(1) + '%', 8);
  });
  console.log(`${DOW[d]!.padEnd(11)}${fila.join('')}`);
}
console.log(`\nmedia global de cercanas: ${(media * 100).toFixed(2)}%  ·  "·" = menos de 30 polls, sin dato util`);
process.exit(0);

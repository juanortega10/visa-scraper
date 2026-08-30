/**
 * Que devuelve `times.json` para los dias que `days.json` SI ofrece.
 *
 * `days.json` lista un dia. Solo `times.json` dice si ese dia se puede reservar y con
 * cuantas horas. Este script arma el histograma de cuantas horas vuelven.
 *
 * Fuente: `reschedule_logs.detail`, que guarda `timesFound` de dos formas:
 *   - `detail.timesFound`              las horas del intento que quedo registrado
 *   - `detail.allAttempts[].timesFound` una entrada por intento de la misma vuelta
 * Las dos se unen aqui. Son 4.044 filas desde 2026-04-15.
 *
 * Un `timesFound` vacio quiere decir que el dia aparecio en `days.json` y `times.json`
 * volvio sin horas. Eso es un dia fantasma, o una carrera perdida.
 *
 *   npx tsx --env-file=.env scripts/analyze-times-disponibles.ts
 *   npx tsx --env-file=.env scripts/analyze-times-disponibles.ts --locale es-pe
 */
import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

const argS = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const LOCALE = argS('locale', 'todos');

async function main() {
  const loc = LOCALE === 'todos' ? sql`` : sql`AND b.locale = ${LOCALE}`;

  // Se unen las dos formas del JSON en una sola lista de intentos.
  const base = sql`
    WITH intentos AS (
      SELECT r.bot_id, b.locale, r.created_at,
             (a.value->>'date')::date AS fecha,
             jsonb_array_length(COALESCE(a.value->'timesFound', '[]'::jsonb)) AS horas,
             a.value->>'failReason' AS motivo
      FROM reschedule_logs r
      JOIN bots b ON b.id = r.bot_id
      CROSS JOIN LATERAL jsonb_array_elements(r.detail->'allAttempts') AS a(value)
      WHERE r.detail ? 'allAttempts' AND a.value ? 'timesFound' ${loc}
      UNION ALL
      SELECT r.bot_id, b.locale, r.created_at,
             r.new_consular_date AS fecha,
             jsonb_array_length(r.detail->'timesFound') AS horas,
             COALESCE(r.fail_reason, CASE WHEN r.success THEN 'success' ELSE NULL END) AS motivo
      FROM reschedule_logs r
      JOIN bots b ON b.id = r.bot_id
      WHERE r.detail ? 'timesFound' ${loc}
    )`;

  const hist = (await db.execute(sql`${base}
    SELECT CASE WHEN horas = 0 THEN 'a  0 horas (vacio)'
                WHEN horas = 1 THEN 'b  1 hora'
                WHEN horas = 2 THEN 'c  2 horas'
                WHEN horas BETWEEN 3 AND 5 THEN 'd  3-5 horas'
                WHEN horas BETWEEN 6 AND 10 THEN 'e  6-10 horas'
                ELSE 'f  11+ horas' END AS tramo,
           COUNT(*)::int AS n
    FROM intentos GROUP BY 1 ORDER BY 1`)).rows as any[];

  const tot = hist.reduce((a, x) => a + x.n, 0);
  const max = Math.max(1, ...hist.map((x) => x.n));
  console.log(`\nTIMES.JSON PARA DIAS QUE DAYS.JSON SI OFRECIA · ${LOCALE}`);
  console.log(`${tot} intentos registrados\n`);
  console.log('  cuantas horas devolvio        n       %    perfil');
  for (const x of hist) {
    console.log(`  ${String(x.tramo).slice(3).padEnd(22)} ${String(x.n).padStart(6)} ${(x.n * 100 / tot).toFixed(1).padStart(6)}%   ${'#'.repeat(Math.round(x.n / max * 40))}`);
  }

  const stats = (await db.execute(sql`${base}
    SELECT COUNT(*) FILTER (WHERE horas = 0)::int AS vacios,
           COUNT(*) FILTER (WHERE horas > 0)::int AS con_horas,
           ROUND(AVG(horas) FILTER (WHERE horas > 0), 2) AS prom_si_hay,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY horas) FILTER (WHERE horas > 0) AS mediana_si_hay,
           MAX(horas)::int AS maximo
    FROM intentos`)).rows[0] as any;
  console.log(`\n  vacios ${stats.vacios} · con horas ${stats.con_horas} · cuando hay: promedio ${stats.prom_si_hay}, mediana ${stats.mediana_si_hay}, maximo ${stats.maximo}`);

  // Por distancia: la disponibilidad no es pareja entre fechas cercanas y lejanas.
  const dist = (await db.execute(sql`${base}
    SELECT CASE WHEN (fecha - created_at::date) < 15 THEN 'a  <15d'
                WHEN (fecha - created_at::date) < 30 THEN 'b  15-29d'
                WHEN (fecha - created_at::date) < 60 THEN 'c  30-59d'
                WHEN (fecha - created_at::date) < 120 THEN 'd  60-119d'
                ELSE 'e  >=120d' END AS tramo,
           COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE horas > 0)::int AS con_horas,
           ROUND(AVG(horas) FILTER (WHERE horas > 0), 1) AS prom
    FROM intentos WHERE fecha IS NOT NULL GROUP BY 1 ORDER BY 1`)).rows as any[];
  console.log('\n  POR DISTANCIA A LA FECHA\n  tramo          n   con horas     %   horas prom si hay');
  for (const x of dist) {
    console.log(`  ${String(x.tramo).slice(3).padEnd(10)} ${String(x.n).padStart(6)} ${String(x.con_horas).padStart(11)} ${(x.con_horas * 100 / x.n).toFixed(0).padStart(5)}% ${String(x.prom ?? '-').padStart(18)}`);
  }

  // Por locale, para ver si Peru se comporta distinto.
  if (LOCALE === 'todos') {
    const porLoc = (await db.execute(sql`${base}
      SELECT locale, COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE horas > 0)::int AS con_horas,
             ROUND(AVG(horas) FILTER (WHERE horas > 0), 1) AS prom
      FROM intentos GROUP BY 1 ORDER BY 2 DESC`)).rows as any[];
    console.log('\n  POR LOCALE\n  locale     n   con horas     %   horas prom si hay');
    for (const x of porLoc) {
      console.log(`  ${String(x.locale).padEnd(7)} ${String(x.n).padStart(6)} ${String(x.con_horas).padStart(11)} ${(x.con_horas * 100 / x.n).toFixed(0).padStart(5)}% ${String(x.prom ?? '-').padStart(18)}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

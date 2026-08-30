/**
 * Horario de liberacion: a que HORA del dia aparecen cupos nuevos.
 *
 * Complementa a `scripts/analyze-release-clock.ts`, que mide el SEGUNDO del minuto.
 * Este mide la hora del dia, en Bogota (UTC-5). Lima usa el mismo huso.
 *
 * Metodo y sus dos cuidados:
 *
 *  1. NORMALIZA POR POLLS. Nuestra cadencia no es pareja entre horas, entonces contar
 *     apariciones crudas mide cuando polleamos, no cuando el portal libera. Se divide
 *     por `SUM(polls_since_prev)`, que reconstruye los polls reales detras de la
 *     reduccion de escritura de `poll_logs`.
 *
 *  2. VENTANA COMUN. `poll_logs` se poda y hoy arranca el 2026-08-20; `date_sightings`
 *     llega hasta marzo. Si se cruzan ventanas distintas, la tasa sale inflada. El
 *     script detecta el arranque de `poll_logs` y recorta las dos tablas ahi.
 *
 *  3. CONTROL DE RAFAGA. Las apariciones vienen en dias muy desparejos (21.100 el
 *     2026-07-24 contra 11 el 2026-08-22). Una sola rafaga puede inventar un pico.
 *     Por eso cada hora trae ademas la MEDIANA POR DIA: si el pico sobrevive a la
 *     mediana, no lo hizo un solo dia.
 *
 *   npx tsx --env-file=.env scripts/analyze-horario-liberacion.ts
 *   npx tsx --env-file=.env scripts/analyze-horario-liberacion.ts --locale es-pe --meses 6
 */
import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

const argS = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const LOCALE = argS('locale', 'todos');
const MESES = Number(argS('meses', '0'));   // 0 = todas las fechas; 6 = solo las cercanas

interface Fila { h: number; polls: number; vistas: number; dias: number; medianaDia: number }

async function main() {
  const [{ desde }] = (await db.execute(sql`SELECT min(created_at) AS desde FROM poll_logs`)).rows as any[];
  const inicio = new Date(desde as string).toISOString();

  const locP = LOCALE === 'todos' ? sql`` : sql`AND b.locale = ${LOCALE}`;
  const cerca = MESES > 0 ? sql`AND ds.days_from_now < ${Math.round(MESES * 30.4)}` : sql``;

  const filas = (await db.execute(sql`
    WITH polls AS (
      SELECT EXTRACT(HOUR FROM (p.created_at - interval '5 hours'))::int AS h,
             SUM(COALESCE(p.polls_since_prev, 1))::bigint AS n
      FROM poll_logs p JOIN bots b ON b.id = p.bot_id
      WHERE p.created_at >= ${inicio} ${locP}
      GROUP BY 1
    ),
    porDia AS (
      SELECT EXTRACT(HOUR FROM (ds.appeared_at - interval '5 hours'))::int AS h,
             (ds.appeared_at - interval '5 hours')::date AS d,
             COUNT(*)::int AS n
      FROM date_sightings ds JOIN bots b ON b.id = ds.bot_id
      WHERE ds.appeared_at >= ${inicio} ${locP} ${cerca}
      GROUP BY 1, 2
    ),
    vistas AS (
      SELECT h, SUM(n)::bigint AS n, COUNT(*)::int AS dias,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY n) AS mediana
      FROM porDia GROUP BY 1
    )
    SELECT p.h, p.n AS polls, COALESCE(v.n, 0) AS vistas,
           COALESCE(v.dias, 0) AS dias, COALESCE(v.mediana, 0) AS mediana_dia
    FROM polls p LEFT JOIN vistas v ON v.h = p.h ORDER BY p.h
  `)).rows.map((r: any): Fila => ({
    h: Number(r.h), polls: Number(r.polls), vistas: Number(r.vistas),
    dias: Number(r.dias), medianaDia: Number(r.mediana_dia),
  }));

  const totV = filas.reduce((a, r) => a + r.vistas, 0);
  const totP = filas.reduce((a, r) => a + r.polls, 0);
  const media = totP > 0 ? (totV * 10000) / totP : 0;
  const tasa = (r: Fila) => (r.polls > 0 ? (r.vistas * 10000) / r.polls : 0);
  const maxTasa = Math.max(...filas.map(tasa));
  const maxMed = Math.max(...filas.map((r) => r.medianaDia));
  const barra = (v: number, max: number, w = 34) => '#'.repeat(Math.max(0, Math.round((v / Math.max(max, 1e-9)) * w)));

  const dias = Math.round((Date.now() - new Date(inicio).getTime()) / 86_400_000);
  console.log(`\nHORARIO DE LIBERACION · ${LOCALE} · ${MESES > 0 ? `solo fechas a menos de ${MESES} meses` : 'todas las fechas'}`);
  console.log(`Ventana comun: desde ${inicio.slice(0, 16)} (${dias} dias, limitada por poll_logs)`);
  console.log(`${totV.toLocaleString('es')} apariciones sobre ${totP.toLocaleString('es')} polls · media ${media.toFixed(1)} por 10k\n`);
  console.log('  hora      polls   vistas   por10k  vs med  dias  med/dia   perfil normalizado');
  for (const r of filas) {
    const t = tasa(r);
    const rel = media > 0 ? t / media : 0;
    console.log(
      `  ${String(r.h).padStart(2, '0')}:00 ${String(r.polls.toLocaleString('es')).padStart(9)} ${String(r.vistas).padStart(8)} ` +
      `${t.toFixed(1).padStart(8)} ${(rel.toFixed(2) + 'x').padStart(7)} ${String(r.dias).padStart(5)} ${r.medianaDia.toFixed(1).padStart(8)}   ${barra(t, maxTasa)}`,
    );
  }

  console.log('\n  CONTROL DE RAFAGA · mediana de apariciones por dia (un solo dia no puede inventar un pico)');
  for (const r of filas) {
    console.log(`  ${String(r.h).padStart(2, '0')}:00  ${r.medianaDia.toFixed(1).padStart(7)}  ${barra(r.medianaDia, maxMed)}`);
  }

  const orden = [...filas].sort((a, b) => tasa(b) - tasa(a));
  const top = orden.slice(0, 5);
  const bajo = orden.slice(-3);
  console.log(`\n  MEJORES 5 horas: ${top.map((r) => `${String(r.h).padStart(2, '0')}:00 (${(tasa(r) / media).toFixed(2)}x)`).join(' · ')}`);
  console.log(`  PEORES 3 horas:  ${bajo.map((r) => `${String(r.h).padStart(2, '0')}:00 (${(tasa(r) / media).toFixed(2)}x)`).join(' · ')}`);
  console.log(`  separacion mejor/peor: ${(tasa(orden[0]!) / Math.max(tasa(orden[orden.length - 1]!), 1e-9)).toFixed(1)}x`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Analisis de la operacion es-pe (Peru).
 *
 * Peru es distinto de Colombia en un punto que manda sobre todo el diseno:
 * el portal permite MUY POCOS reagendamientos y el bloqueo es irreversible.
 * Por eso aqui la prioridad es medir antes de disparar.
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/analyze-peru.ts
 *   npx tsx --env-file=.env scripts/analyze-peru.ts --bot 299
 *   npx tsx --env-file=.env scripts/analyze-peru.ts --dias 7
 */
import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';

const argOf = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const BOT = argOf('--bot') ? Number(argOf('--bot')) : null;
const DAYS = Number(argOf('--dias') ?? 30);
const SINCE = sql.raw(`now() - interval '${DAYS} days'`);
const ONLY = BOT ? sql`AND b.id = ${BOT}` : sql``;

const h = (t: string) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const pad = (v: unknown, n: number) => String(v ?? '-').padStart(n);
const padr = (v: unknown, n: number) => String(v ?? '-').padEnd(n);

// ── 1. Flota ───────────────────────────────────────────────────────────
h('1. FLOTA es-pe');
const fleet = await db.execute(sql`
  SELECT b.id, b.status, b.visa_email, b.schedule_id, b.current_consular_date,
         b.current_consular_time, b.reschedule_count, b.max_reschedules,
         b.target_date_before, b.proxy_provider, b.poll_environments
  FROM bots b WHERE b.locale = 'es-pe' ${ONLY} ORDER BY b.id
`);
console.log(`${padr('bot', 5)}${padr('estado', 21)}${padr('cita actual', 18)}${padr('meta antes de', 14)}${padr('cuota', 15)}correo`);
for (const r of fleet.rows as any[]) {
  const quota = `${r.reschedule_count}/${r.max_reschedules ?? '?'}`;
  const agotada = r.max_reschedules != null && r.reschedule_count >= r.max_reschedules;
  console.log(
    `${padr(r.id, 5)}${padr(r.status, 21)}` +
    `${padr(`${r.current_consular_date} ${r.current_consular_time ?? ''}`.trim(), 18)}` +
    `${padr(r.target_date_before, 14)}${padr(quota + (agotada ? ' AGOTADA' : ''), 15)}` +
    `${decrypt(r.visa_email as string)}`,
  );
}

// ── 2. Embudo ──────────────────────────────────────────────────────────
h(`2. EMBUDO de conversion · ultimos ${DAYS} dias`);
const polls = await db.execute(sql`
  SELECT p.bot_id,
    sum(coalesce(p.polls_since_prev,1)) AS polls,
    count(*) FILTER (WHERE p.earliest_date IS NOT NULL) AS detecciones
  FROM poll_logs p JOIN bots b ON b.id = p.bot_id
  WHERE b.locale='es-pe' ${ONLY} AND p.created_at > ${SINCE} GROUP BY p.bot_id
`);
const resch = await db.execute(sql`
  SELECT r.bot_id, count(*) AS intentos, count(*) FILTER (WHERE r.success) AS exitos
  FROM reschedule_logs r JOIN bots b ON b.id = r.bot_id
  WHERE b.locale='es-pe' ${ONLY} AND r.created_at > ${SINCE} GROUP BY r.bot_id
`);
const rmap = new Map((resch.rows as any[]).map((r) => [Number(r.bot_id), r]));
console.log(`${padr('bot', 5)}${pad('polls', 9)}${pad('detecciones', 13)}${pad('intentos', 10)}${pad('exitos', 8)}${pad('conversion', 12)}`);
let tp = 0, td = 0, ti = 0, te = 0;
for (const p of polls.rows as any[]) {
  const r = rmap.get(Number(p.bot_id));
  const det = Number(p.detecciones), int = Number(r?.intentos ?? 0), ex = Number(r?.exitos ?? 0);
  tp += Number(p.polls); td += det; ti += int; te += ex;
  const conv = det ? `${((ex / det) * 100).toFixed(1)}%` : '-';
  console.log(`${padr(p.bot_id, 5)}${pad(p.polls, 9)}${pad(det, 13)}${pad(int, 10)}${pad(ex, 8)}${pad(conv, 12)}`);
}
console.log(`${padr('TOTAL', 5)}${pad(tp, 9)}${pad(td, 13)}${pad(ti, 10)}${pad(te, 8)}${pad(td ? `${((te/td)*100).toFixed(1)}%` : '-', 12)}`);

// ── 3. Donde muere ─────────────────────────────────────────────────────
h(`3. POR QUE FALLAN los intentos`);
const why = await db.execute(sql`
  SELECT coalesce(nullif(split_part(r.error, ':', 2), ''), r.fail_step, '(sin motivo)') AS motivo, count(*) AS n
  FROM reschedule_logs r JOIN bots b ON b.id = r.bot_id
  WHERE b.locale='es-pe' ${ONLY} AND r.success = false AND r.created_at > ${SINCE}
  GROUP BY motivo ORDER BY n DESC LIMIT 12
`);
const totalFail = (why.rows as any[]).reduce((a, r) => a + Number(r.n), 0);
for (const r of why.rows as any[]) {
  const pct = totalFail ? ((Number(r.n) / totalFail) * 100).toFixed(0) : '0';
  console.log(`  ${pad(r.n, 5)}x  ${pad(pct + '%', 5)}  ${r.motivo}`);
}
console.log(`\n  no_times          days.json mostro el dia, times.json no dio horas. Llegamos tarde.`);
console.log(`  verification_failed  el POST dijo que si, el portal no lo guardo.`);
console.log(`  post_error        el POST fallo en red.`);

// ── 4. Latencia ────────────────────────────────────────────────────────
h('4. LATENCIA · el factor que decide si alcanzamos el cupo');
const lat = await db.execute(sql`
  SELECT (p.earliest_date IS NOT NULL) AS con_fecha,
         count(*) AS n,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY p.response_time_ms)::int AS p50,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY p.response_time_ms)::int AS p90,
         max(p.response_time_ms) AS peor
  FROM poll_logs p JOIN bots b ON b.id = p.bot_id
  WHERE b.locale='es-pe' ${ONLY} AND p.created_at > ${SINCE} AND p.response_time_ms IS NOT NULL
  GROUP BY con_fecha
`);
console.log(`${padr('caso', 16)}${pad('n', 8)}${pad('p50 ms', 10)}${pad('p90 ms', 10)}${pad('peor ms', 10)}`);
for (const r of lat.rows as any[]) {
  console.log(`${padr(r.con_fecha ? 'con fecha' : 'sin fecha', 16)}${pad(r.n, 8)}${pad(r.p50, 10)}${pad(r.p90, 10)}${pad(r.peor, 10)}`);
}

// ── 5. Cuando aparecen ─────────────────────────────────────────────────
h('5. CUANDO aparecen las fechas · hora UTC-5 (Bogota/Lima)');
const hours = await db.execute(sql`
  SELECT extract(hour FROM p.created_at - interval '5 hours')::int AS hora, count(*) AS n
  FROM poll_logs p JOIN bots b ON b.id = p.bot_id
  WHERE b.locale='es-pe' ${ONLY} AND p.earliest_date IS NOT NULL AND p.created_at > ${SINCE}
  GROUP BY hora ORDER BY hora
`);
if (!hours.rows.length) console.log('  sin detecciones en el periodo.');
const maxH = Math.max(1, ...(hours.rows as any[]).map((r) => Number(r.n)));
for (const r of hours.rows as any[]) {
  const bar = '█'.repeat(Math.max(1, Math.round((Number(r.n) / maxH) * 40)));
  console.log(`  ${pad(r.hora, 2)}:00  ${pad(r.n, 4)}  ${bar}`);
}

// ── 6. Que fechas se vieron ────────────────────────────────────────────
h('6. FECHAS vistas y si servian');
const seen = await db.execute(sql`
  SELECT p.bot_id, p.created_at, p.earliest_date, p.raw_dates_count, p.top_dates,
         p.response_time_ms, b.current_consular_date, b.target_date_before
  FROM poll_logs p JOIN bots b ON b.id = p.bot_id
  WHERE b.locale='es-pe' ${ONLY} AND p.earliest_date IS NOT NULL AND p.created_at > ${SINCE}
  ORDER BY p.created_at DESC LIMIT 25
`);
for (const r of seen.rows as any[]) {
  const sirve = r.earliest_date < r.current_consular_date;
  const meta = r.target_date_before ? (r.earliest_date < r.target_date_before ? ' + META' : '') : '';
  console.log(
    `  bot ${padr(r.bot_id, 4)} ${String(r.created_at).slice(0, 19)}  ${r.earliest_date}` +
    `  ${pad(r.raw_dates_count, 2)} dias  ${pad(r.response_time_ms + 'ms', 8)}` +
    `  ${sirve ? 'ADELANTA' : 'no sirve'}${meta}`,
  );
}

// ── 7. Salud ahora ─────────────────────────────────────────────────────
h('7. SALUD · ultimas 6 horas');
const health = await db.execute(sql`
  SELECT p.bot_id, p.status, count(*) AS n, max(p.created_at) AS ultimo
  FROM poll_logs p JOIN bots b ON b.id = p.bot_id
  WHERE b.locale='es-pe' ${ONLY} AND p.created_at > now() - interval '6 hours'
  GROUP BY p.bot_id, p.status ORDER BY p.bot_id, n DESC
`);
if (!health.rows.length) console.log('  ningun poll en 6 horas. La flota es-pe esta quieta.');
for (const r of health.rows as any[]) {
  console.log(`  bot ${padr(r.bot_id, 4)} ${padr(r.status, 16)} ${pad(r.n, 5)} filas   ultimo ${String(r.ultimo).slice(0, 19)}`);
}
const errs = await db.execute(sql`
  SELECT p.bot_id, p.error, count(*) AS n
  FROM poll_logs p JOIN bots b ON b.id = p.bot_id
  WHERE b.locale='es-pe' ${ONLY} AND p.error IS NOT NULL AND p.created_at > now() - interval '6 hours'
  GROUP BY p.bot_id, p.error ORDER BY n DESC LIMIT 8
`);
if (errs.rows.length) {
  console.log('\n  errores:');
  for (const r of errs.rows as any[]) console.log(`   bot ${padr(r.bot_id, 4)} ${pad(r.n, 4)}x  ${String(r.error).slice(0, 90)}`);
}

process.exit(0);

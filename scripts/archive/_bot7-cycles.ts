import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';

const db = drizzle(neon(process.env.DATABASE_URL!));

// ── 1. Minuto a minuto: ok vs tcp en el período del sniper ──
// Usamos SQL puro para no traer rows individuales
const minuteData = await db.execute(sql`
  SELECT
    date_trunc('minute', created_at AT TIME ZONE 'America/Lima') AS minute_lima,
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE status = 'tcp_blocked') AS tcp,
    COUNT(*) FILTER (WHERE status IN ('ok','filtered_out')) AS ok_polls
  FROM poll_logs
  WHERE bot_id = 7
    AND created_at >= '2026-04-09 18:00:00+00'  -- Apr 9 13h Lima en adelante
  GROUP BY 1
  ORDER BY 1
`);

// ── 2. Runs consecutivos (ok vs tcp) usando LAG ──
const runsData = await db.execute(sql`
  WITH ordered AS (
    SELECT
      created_at AT TIME ZONE 'America/Lima' AS ts_lima,
      CASE WHEN status = 'tcp_blocked' THEN 'tcp' ELSE 'ok' END AS kind,
      LAG(CASE WHEN status = 'tcp_blocked' THEN 'tcp' ELSE 'ok' END)
        OVER (ORDER BY created_at) AS prev_kind
    FROM poll_logs
    WHERE bot_id = 7
      AND created_at >= '2026-04-09 18:00:00+00'
      AND status IN ('ok','filtered_out','tcp_blocked','error')
  ),
  run_ids AS (
    SELECT ts_lima, kind,
      SUM(CASE WHEN kind IS DISTINCT FROM prev_kind THEN 1 ELSE 0 END)
        OVER (ORDER BY ts_lima) AS run_id
    FROM ordered
  ),
  runs AS (
    SELECT
      run_id,
      kind,
      COUNT(*) AS polls,
      MIN(ts_lima) AS start_t,
      MAX(ts_lima) AS end_t,
      ROUND(EXTRACT(EPOCH FROM (MAX(ts_lima) - MIN(ts_lima))) / 60.0, 1) AS dur_min
    FROM run_ids
    GROUP BY run_id, kind
  )
  SELECT *, LEAD(kind) OVER (ORDER BY run_id) AS next_kind,
            LEAD(dur_min) OVER (ORDER BY run_id) AS next_dur,
            LEAD(polls) OVER (ORDER BY run_id) AS next_polls,
            LAG(dur_min) OVER (ORDER BY run_id) AS prev_ok_dur,
            LAG(polls) OVER (ORDER BY run_id) AS prev_ok_polls
  FROM runs
  ORDER BY run_id
`);

const rows = runsData.rows as any[];

// Classify blocks: short (<15min), medium (15-60), long (>60)
const classify = (dur: number) => dur < 5 ? 'micro' : dur < 15 ? 'short' : dur < 60 ? 'medium' : 'LONG';

console.log('\n── Secuencia completa de runs (ok ↔ tcp) ──');
console.log('Start (Lima)  | kind | polls |dur_min| tipo      | → next_dur | next_polls');
console.log('--------------|------|-------|-------|-----------|------------|----------');

for (const r of rows) {
  const start = String(r.start_t).slice(0,16).replace('T',' ');
  const tipo = r.kind === 'tcp' ? classify(Number(r.dur_min)) : '';
  const nextInfo = r.next_kind
    ? `${r.next_dur}m`.padStart(10)
    : '         -';
  const nextP = r.next_polls ? String(r.next_polls).padStart(10) : '         -';
  const flag = r.kind === 'tcp' && Number(r.dur_min) >= 60 ? ' ◄ LARGO' :
               r.kind === 'tcp' && Number(r.dur_min) >= 15 ? ' ◄ medio' : '';
  console.log(`${start} | ${r.kind.padEnd(4)} | ${String(r.polls).padStart(5)} | ${String(r.dur_min).padStart(5)} | ${tipo.padEnd(9)} | ${nextInfo} | ${nextP}${flag}`);
}

// ── Stats separados por tipo ──
const tcpRuns = rows.filter(r => r.kind === 'tcp');
const okRuns = rows.filter(r => r.kind === 'ok');

const micro = tcpRuns.filter(r => Number(r.dur_min) < 5);
const short = tcpRuns.filter(r => Number(r.dur_min) >= 5 && Number(r.dur_min) < 15);
const medium = tcpRuns.filter(r => Number(r.dur_min) >= 15 && Number(r.dur_min) < 60);
const longB = tcpRuns.filter(r => Number(r.dur_min) >= 60);

console.log('\n── Clasificación de bloqueos ──');
console.log(`Micro  (<5min):   ${micro.length}  →  dur: ${micro.map(r=>r.dur_min).join(', ')}`);
console.log(`Short  (5-15min): ${short.length}  →  dur: ${short.map(r=>r.dur_min).join(', ')}`);
console.log(`Medium (15-60min):${medium.length} →  dur: ${medium.map(r=>r.dur_min).join(', ')}`);
console.log(`LONG   (>60min):  ${longB.length}  →  dur: ${longB.map(r=>r.dur_min).join(', ')}`);

console.log('\n── Ventanas OK entre bloqueos ──');
console.log(`n=${okRuns.length}  durs: ${okRuns.map(r=>r.dur_min+'m').join(', ')}`);
console.log(`polls: ${okRuns.map(r=>r.polls).join(', ')}`);

// ── Buscar patrón: qué precede a los bloques LARGOS ──
console.log('\n── ¿Qué hay antes de cada bloqueo LARGO? ──');
for (const lb of longB) {
  const idx = rows.indexOf(lb);
  const prev3 = rows.slice(Math.max(0, idx - 6), idx);
  console.log(`\nBLOQUEO LARGO: start=${String(lb.start_t).slice(0,16)} dur=${lb.dur_min}min polls=${lb.polls}`);
  console.log('  Contexto previo:');
  for (const p of prev3) {
    console.log(`    ${String(p.start_t).slice(0,16)} | ${p.kind} | ${p.polls} polls | ${p.dur_min}min`);
  }
}

// ── Minuto a minuto compacto para ver la transición ──
const mins = minuteData.rows as any[];
console.log('\n── Minuto a minuto: ratio tcp% (Apr 9 13h Lima → fin) ──');
console.log('Hora Lima     | polls/min | tcp% | patrón');
let lastPct = 0;
for (const m of mins) {
  const t = String(m.minute_lima).slice(0,16).replace('T',' ');
  const total = Number(m.total);
  const tcp = Number(m.tcp);
  const pct = total > 0 ? Math.round(tcp / total * 100) : 0;
  // Only print if something interesting: transition or every 10min
  const changed = Math.abs(pct - lastPct) > 20;
  const isHour = String(m.minute_lima).slice(14,16) === '00';
  if (changed || isHour || pct === 100 || pct === 0 && lastPct > 0) {
    const bar = pct === 0 ? '░░░░░' : pct < 30 ? '▓░░░░' : pct < 60 ? '▓▓▓░░' : pct < 90 ? '▓▓▓▓░' : '▓▓▓▓▓';
    console.log(`${t} | ${String(total).padStart(9)} | ${String(pct).padStart(3)}% | ${bar}`);
    lastPct = pct;
  }
}

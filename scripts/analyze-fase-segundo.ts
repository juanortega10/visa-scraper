/**
 * ¿En que segundo del minuto conviene pollear? Y ¿la ventana de es-co sirve?
 *
 * Reemplaza al reporte binario del A/B. Ver `src/services/experimento-estadistica.ts`
 * para el porque de cada regla; aqui solo se lee la base y se imprime.
 *
 * Dos preguntas, una misma muestra:
 *
 *   1. LA CURVA     tasa de cupos cercanos por segundo del minuto, suavizada.
 *   2. EL VEREDICTO dentro de la ventana contra fuera, con bootstrap por BLOQUE.
 *
 * El segundo de aterrizaje se reconstruye como `created_at - response_time_ms`, o sea el
 * instante en que arranco el fetch. `response_time_ms` esta presente en el 100% de las
 * filas de los bots del experimento (medido 2026-09-01).
 *
 *   npx tsx --env-file=.env scripts/analyze-fase-segundo.ts
 *   npx tsx --env-file=.env scripts/analyze-fase-segundo.ts --horas 72 --ancho 8
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import {
  curvaPorSegundo, mejorVentana, analizar,
  type FilaSegundo, type BloqueExperimento,
} from '../src/services/experimento-estadistica.js';
import { VENTANA_EXPERIMENTO } from '../src/services/experimento-fase.js';

const arg = (n: string, d: number) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const HORAS = arg('horas', 48);
const ANCHO = arg('ancho', 10);

const CERC = `(SELECT count(*) FROM jsonb_array_elements_text(COALESCE(p.date_changes->'appeared','[]'::jsonb)) v
   WHERE v.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND v.value::date < (now()+interval '6 months')::date)`;

const filas = (await db.execute<any>(sql`
  SELECT p.bot_id,
         floor(extract(second FROM (p.created_at - COALESCE(p.response_time_ms, 0) * interval '1 millisecond')))::int AS seg,
         extract(epoch FROM date_trunc('minute', p.created_at)) * 1000 AS minuto_ms,
         extract(epoch FROM date_trunc('hour', p.created_at)) * 1000 AS hora_ms,
         p.polls_since_prev AS polls,
         extract(epoch FROM (p.created_at - lag(p.created_at) OVER (PARTITION BY p.bot_id ORDER BY p.created_at))) AS hueco,
         ${sql.raw(CERC)} AS eventos
  FROM poll_logs p JOIN bots b ON b.id = p.bot_id
  WHERE b.phase_experiment = true
    AND p.created_at > now() - make_interval(hours => ${HORAS})
    AND p.response_time_ms IS NOT NULL
`)).rows;

if (filas.length === 0) { console.log('\nsin filas\n'); process.exit(0); }

// ── 1. La curva ─────────────────────────────────────────────────────────────
const porSeg: FilaSegundo[] = filas.map((f: any) => ({
  segundo: Number(f.seg), polls: Number(f.polls ?? 1), eventos: Number(f.eventos ?? 0),
}));
const curva = curvaPorSegundo(porSeg);
const totPolls = curva.reduce((a, c) => a + c.polls, 0);
const totEv = curva.reduce((a, c) => a + c.eventos, 0);
const media = (1000 * totEv) / Math.max(1, totPolls);

console.log(`\nCURVA POR SEGUNDO · ${HORAS} h · ${totPolls.toLocaleString('es-CO')} polls · ${totEv} eventos · media ${media.toFixed(1)} por mil\n`);
const maxSuave = Math.max(...curva.map((c) => c.suave), 1e-9);
for (let s = 0; s < 60; s++) {
  const c = curva[s]!;
  const barra = '#'.repeat(Math.round(28 * c.suave / maxSuave));
  const vs = c.suave / Math.max(1e-9, media);
  console.log(
    `s${String(s).padStart(2, '0')} ${String(c.polls).padStart(5)} polls ${String(c.eventos).padStart(4)} ev ` +
    `${c.suave.toFixed(1).padStart(6)} suave ${vs.toFixed(2).padStart(5)}x  ${barra}`,
  );
}

const mejor = mejorVentana(curva, ANCHO);
console.log(`\nmejor ventana de ${ANCHO} s: ${mejor ? `s${mejor.startSec}-${(mejor.endSec + 59) % 60} con ${mejor.porMil} por mil (${(mejor.porMil/media).toFixed(2)}x la media)` : 'sin muestra suficiente'}`);
const cfg = VENTANA_EXPERIMENTO['es-co'];
if (cfg) console.log(`ventana configurada hoy: s${cfg.startSec}-${cfg.endSec - 1}`);

// ── 2. El veredicto, con la ventana configurada ─────────────────────────────
// El brazo sale del segundo en que REALMENTE aterrizo el poll, y el bloque es el
// bot-hora. La fase se sorteo antes de conocer el resultado, entonces la comparacion
// sigue siendo aleatorizada.
function dentro(seg: number, w: { startSec: number; endSec: number }) {
  return w.endSec > w.startSec
    ? seg >= w.startSec && seg < w.endSec
    : seg >= w.startSec || seg < w.endSec;   // ventana que cruza el minuto
}
function bloquesDe(w: { startSec: number; endSec: number }): BloqueExperimento[] {
  const mapa = new Map<string, BloqueExperimento>();
  for (const f of filas as any[]) {
    const al = dentro(Number(f.seg), w);
    const k = `${f.bot_id}|${f.hora_ms}|${al}`;
    const b = mapa.get(k) ?? { botId: Number(f.bot_id), horaMs: Number(f.hora_ms), polls: 0, eventos: 0, alineado: al };
    b.polls += Number(f.polls ?? 1);
    b.eventos += Number(f.eventos ?? 0);
    mapa.set(k, b);
  }
  return [...mapa.values()];
}

for (const [etiqueta, w] of [
  ['ventana configurada', cfg],
  ['mejor ventana medida', mejor ? { startSec: mejor.startSec, endSec: mejor.endSec } : undefined],
] as Array<[string, { startSec: number; endSec: number } | undefined]>) {
  if (!w) continue;
  const a = analizar(bloquesDe(w));
  console.log(`\n${etiqueta.toUpperCase()} · s${w.startSec}-${(w.endSec + 59) % 60}`);
  console.log(`  dentro  ${String(a.alineado.eventos).padStart(4)} ev / ${String(a.alineado.polls).padStart(6)} polls = ${a.alineado.porMil} por mil  (${a.alineado.bloques} bloques)`);
  console.log(`  fuera   ${String(a.control.eventos).padStart(4)} ev / ${String(a.control.polls).padStart(6)} polls = ${a.control.porMil} por mil  (${a.control.bloques} bloques)`);
  console.log(`  razon ${a.razon}  IC95 [${a.ic95[0]}, ${a.ic95[1]}]  phi ${a.sobredispersion}`);
  console.log(`  eventos necesarios por brazo: ${a.eventosNecesarios}  ->  VEREDICTO: ${a.veredicto}`);

  // EL HUECO VA SIEMPRE AL LADO DE LA RAZON. `appeared` compara contra el poll anterior,
  // entonces un grupo con huecos mas largos ve mas fechas nuevas por poll sin que la
  // fase tenga nada que ver. El 2026-09-01, con el mecanismo VIEJO que esperaba para
  // entrar a la ventana, los polls de dentro traian hueco p50 de 177 s contra 85 s de
  // los de fuera: la razon de 2,8x estaba contaminada. La rejilla deja el hueco
  // constante, y desde entonces los dos numeros de abajo tienen que parecerse.
  const hue = { dentro: [] as number[], fuera: [] as number[] };
  for (const f of filas as any[]) {
    const h = Number(f.hueco);
    if (!Number.isFinite(h) || h <= 0 || h > 600) continue;
    (dentro(Number(f.seg), w) ? hue.dentro : hue.fuera).push(h);
  }
  const p50 = (xs: number[]) => { const y = [...xs].sort((a2, b2) => a2 - b2); return y.length ? y[Math.floor(y.length/2)]! : NaN; };
  const hd = p50(hue.dentro), hf = p50(hue.fuera);
  const sesgo = Number.isFinite(hd) && Number.isFinite(hf) ? hd / hf : NaN;
  console.log(`  hueco antes del poll: dentro p50 ${hd.toFixed(0)} s · fuera p50 ${hf.toFixed(0)} s · cociente ${sesgo.toFixed(2)}`);
  if (sesgo > 1.25 || sesgo < 0.8) {
    console.log('  AVISO: los huecos NO son comparables. La razon de arriba esta contaminada.');
    console.log('  Con la rejilla el hueco es constante; esta muestra trae datos del mecanismo viejo.');
  }
}
console.log('');
process.exit(0);

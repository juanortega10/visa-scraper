/**
 * Aplica la fase de mejor practica a la flota de un locale.
 *
 * QUE HACE. Prende `phase_aligned` en todos los bots del locale, para que sus polls caigan
 * en el borde de liberacion (`src/services/mejores-practicas.ts`). El numero de peticiones
 * por minuto NO cambia: solo cambia en que segundo caen.
 *
 * Y DEJA UN CENTINELA. Un bot se queda con `phase_experiment`, o sea con la rejilla de fase
 * sorteada que barre los 60 segundos. Sin el, la flota entera queda ciega a un cambio de
 * hora del portal: la rafaga seguiria contando cupos, pero tarde y sin que nada lo diga.
 * El centinela es el bot con la cita MAS LEJANA de los que mas pollean, o sea el que menos
 * pierde por no ir alineado.
 *
 * Dry-run por defecto.
 *
 *   npx tsx --env-file=.env scripts/aplicar-mejores-practicas.ts
 *   npx tsx --env-file=.env scripts/aplicar-mejores-practicas.ts --commit
 *   npx tsx --env-file=.env scripts/aplicar-mejores-practicas.ts --locale es-co --commit
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import {
  RAFAGA_LIBERACION, planRafaga, pollsPorMinuto, peorLatenciaSec,
} from '../src/services/mejores-practicas.js';
import { DEFAULT_POLL_INTERVAL_S } from '../src/services/scheduling.js';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const LOCALE = arg('locale') ?? 'es-co';
const COMMIT = process.argv.includes('--commit');

const borde = RAFAGA_LIBERACION[LOCALE];
if (!borde) {
  console.log(`\nNo hay borde de liberacion medido para ${LOCALE}. Sin medicion no se alinea nada.\n`);
  process.exit(1);
}

const bots = (await db.execute<Record<string, unknown>>(sql`
  SELECT id, status, phase_aligned, phase_experiment,
         poll_interval_seconds, target_polls_per_min,
         current_consular_date::text AS cita,
         COALESCE((SELECT SUM(p.polls_since_prev) FROM poll_logs p
                   WHERE p.bot_id = b.id AND p.created_at > now() - interval '24 hours'), 0) AS polls24h
  FROM bots b WHERE b.locale = ${LOCALE} AND b.status IN ('active','error')
  ORDER BY b.id
`)).rows;

if (bots.length === 0) { console.log(`\nsin bots activos en ${LOCALE}\n`); process.exit(0); }

// El centinela: entre los que mas pollean (mitad de arriba), el de la cita mas lejana.
// Mas polls = mejor cobertura de los 60 segundos. Cita lejana = el que menos pierde.
const porPolls = [...bots].sort((a, b) => Number(b.polls24h) - Number(a.polls24h));
const candidatos = porPolls.slice(0, Math.max(1, Math.ceil(porPolls.length / 2)));
const centinela = candidatos.sort((a, b) => String(b.cita ?? '').localeCompare(String(a.cita ?? '')))[0]!;

const intervalo = DEFAULT_POLL_INTERVAL_S;
const n = pollsPorMinuto(intervalo);
const plan = planRafaga({ ...borde, n });

console.log(`\nMEJORES PRACTICAS DE FASE · ${LOCALE} · ${bots.length} bots${COMMIT ? '' : '  (DRY-RUN)'}`);
console.log(`\n  borde de liberacion  s${borde.inicioSec}-${borde.inicioSec + borde.anchoSec}`);
console.log(`  peticiones/minuto    ${n}  (intervalo ${intervalo} s · SIN cambio de carga)`);
console.log(`  plan de la rafaga    ${plan.map((s) => `s${s}`).join(', ')}`);
console.log(`  peor latencia        ${peorLatenciaSec(plan, borde.inicioSec, borde.anchoSec)} s   (rejilla uniforme: 19 s)`);
console.log(`\n  bot   polls 24h   cita         ahora                 queda`);
console.log('  ' + '-'.repeat(74));
for (const b of bots) {
  const esCentinela = b.id === centinela.id;
  const ahora = b.phase_experiment ? 'centinela' : b.phase_aligned ? 'alineado' : 'sin alinear';
  console.log(
    `  ${String(b.id).padEnd(6)}${String(b.polls24h).padStart(9)}   ${String(b.cita ?? '').padEnd(13)}` +
    `${ahora.padEnd(22)}${esCentinela ? 'CENTINELA (rejilla, barre el minuto)' : 'rafaga en el borde'}`,
  );
}

if (!COMMIT) {
  console.log('\n  Dry-run. Agrega --commit para aplicar.\n');
  process.exit(0);
}

for (const b of bots) {
  const esCentinela = b.id === centinela.id;
  await db.execute(sql`
    UPDATE bots SET phase_aligned = ${!esCentinela}, phase_experiment = ${esCentinela}, updated_at = now()
    WHERE id = ${Number(b.id)}
  `);
}
console.log(`\n  aplicado: ${bots.length - 1} en rafaga · bot ${centinela.id} de centinela\n`);
process.exit(0);

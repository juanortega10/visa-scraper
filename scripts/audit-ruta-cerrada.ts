/**
 * Rutas de schedule cerradas. Ver `src/services/ruta-cerrada.ts`.
 *
 * Sale con codigo 1 si hay hallazgos, para servir de compuerta en un cron.
 *
 *   npx tsx --env-file=.env scripts/audit-ruta-cerrada.ts
 *   npx tsx --env-file=.env scripts/audit-ruta-cerrada.ts --avisar
 */
import { detectarRutasCerradas, textoRutaCerrada } from '../src/services/ruta-cerrada.js';
import { leerFilasBloqueo, leerFilasSniper, HORAS_VENTANA } from '../src/trigger/audit-ruta-cerrada.js';
import { sendTelegram } from '../src/services/notifications.js';

const [dePoll, deSniper] = await Promise.all([leerFilasBloqueo(), leerFilasSniper()]);
const filas = [...dePoll, ...deSniper];
const rutas = detectarRutasCerradas(filas, Date.now());
console.log(`\nfuentes: ${dePoll.length} filas de poll_logs · ${deSniper.length} de sniper_scans`);

console.log(`\nRUTAS CERRADAS · ${filas.length} filas de las ultimas ${HORAS_VENTANA} h · ${rutas.length} hallazgos\n`);
if (rutas.length === 0) {
  console.log('  ninguna\n');
} else {
  console.log('  schedule     locale   abierto     bots                 polls  severidad');
  console.log('  ' + '-'.repeat(76));
  for (const r of rutas) {
    console.log(
      `  ${r.scheduleId.padEnd(13)}${r.locale.padEnd(9)}` +
      `${(r.minutos >= 120 ? (r.minutos / 60).toFixed(1) + ' h' : r.minutos + ' min').padStart(9)}  ` +
      `${r.bots.join(', ').padEnd(21)}${String(r.polls).padStart(5)}  ${r.severidad}`,
    );
  }
  console.log('\n  El dominio responde y la ruta no: nginx 444 sobre esa URL.');
  console.log('  Cambiar de IP o de proxy NO sirve.\n');
}

if (process.argv.includes('--avisar') && rutas.length > 0) {
  console.log(`  telegram: ${await sendTelegram(textoRutaCerrada(rutas)) ? 'enviado' : 'no enviado'}`);
}
process.exit(rutas.length > 0 ? 1 : 0);

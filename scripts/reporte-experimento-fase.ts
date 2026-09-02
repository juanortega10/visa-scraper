/**
 * El mismo reporte diario de fase, desde la CLI.
 * Ver `src/services/experimento-estadistica.ts` y `src/trigger/reporte-experimento-fase.ts`.
 *
 *   npx tsx --env-file=.env scripts/reporte-experimento-fase.ts
 *   npx tsx --env-file=.env scripts/reporte-experimento-fase.ts --dias 3 --avisar
 */
import { textoTelegramFase } from '../src/services/experimento-estadistica.js';
import { leerFilasFase, armarReporte, DIAS_REPORTE } from '../src/trigger/reporte-experimento-fase.js';
import { sendTelegram } from '../src/services/notifications.js';

const i = process.argv.indexOf('--dias');
const DIAS = i >= 0 ? Number(process.argv[i + 1]) : DIAS_REPORTE;

const filas = await leerFilasFase(DIAS);
const rep = armarReporte(filas, DIAS);
console.log(`\n${filas.length} filas de poll_logs de bots con phase_experiment\n`);
if (!rep) {
  console.log('sin filas o sin ventana configurada\n');
  process.exit(0);
}
console.log(textoTelegramFase(rep).replace(/\*/g, ''));
if (process.argv.includes('--avisar')) {
  console.log(`\ntelegram: ${await sendTelegram(textoTelegramFase(rep)) ? 'enviado' : 'no enviado'}`);
}
process.exit(0);

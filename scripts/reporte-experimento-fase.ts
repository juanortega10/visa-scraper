/**
 * El mismo reporte del A/B de fase, desde la CLI. Ver `src/services/experimento-fase.ts`.
 *
 *   npx tsx --env-file=.env scripts/reporte-experimento-fase.ts
 *   npx tsx --env-file=.env scripts/reporte-experimento-fase.ts --dias 7 --avisar
 */
import { resumirExperimento, textoTelegramExperimento } from '../src/services/experimento-fase.js';
import { leerFilasExperimento, DIAS_REPORTE } from '../src/trigger/reporte-experimento-fase.js';
import { sendTelegram } from '../src/services/notifications.js';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const DIAS = Number(arg('dias') ?? DIAS_REPORTE);

const filas = await leerFilasExperimento(DIAS);
const r = resumirExperimento(filas);
console.log(`\n${filas.length} filas de poll_logs de bots con phase_experiment\n`);
console.log(textoTelegramExperimento(r, DIAS).replace(/\*/g, ''));
if (process.argv.includes('--avisar')) {
  console.log(`\ntelegram: ${await sendTelegram(textoTelegramExperimento(r, DIAS)) ? 'enviado' : 'no enviado'}`);
}
process.exit(0);

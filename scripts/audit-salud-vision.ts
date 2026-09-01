/**
 * ¿Se puede leer una imagen ahora mismo? Ver `src/services/salud-vision.ts`.
 *
 * Sale con codigo 1 si hay alerta, para servir de compuerta en un cron.
 *
 *   npx tsx --env-file=.env scripts/audit-salud-vision.ts
 *   npx tsx --env-file=.env scripts/audit-salud-vision.ts --avisar   # manda el Telegram
 */
import { evaluarVision, textoVision } from '../src/services/salud-vision.js';
import { leerEstadoVision } from '../src/trigger/audit-salud-vision.js';
import { sendTelegram } from '../src/services/notifications.js';

const estado = await leerEstadoVision();
const v = evaluarVision(estado);

console.log(`\nSALUD DE LA LECTURA DE IMAGENES · ${v.arriba} de ${estado.proveedores.length} proveedores arriba\n`);
for (const p of estado.proveedores) {
  console.log(`  ${p.ok ? 'OK   ' : 'CAIDO'} ${p.nombre.padEnd(18)} ${p.detalle.slice(0, 90)}`);
}
if (estado.proveedores.length === 0) console.log('  (la sonda no devolvio ningun proveedor configurado)');
console.log(`\n  pendientes: ${estado.pendientes.total} · ${estado.pendientes.conUrl} reintentables · el mas viejo ${estado.pendientes.masViejoHoras} h`);
console.log(`\n  veredicto: ${v.severidad} · ${v.motivo}\n`);

if (process.argv.includes('--avisar') && v.alerta) {
  console.log(`  telegram: ${await sendTelegram(textoVision(v, estado)) ? 'enviado' : 'no enviado'}`);
}
process.exit(v.alerta ? 1 : 0);

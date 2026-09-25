/**
 * Pruebas de los recordatorios de la llamada con Erika, contra la base real y con envíos
 * reales a los destinos de prueba.
 *
 *   # 1. Crea una cita falsa comprimida: los 4 tipos salen en los próximos ~5 minutos.
 *   npx tsx scripts/recordatorios-prueba.ts crear
 *
 *   # 2a. Sin RPi: envía ya, desde este Mac, lo que esté vencido (prueba el contenido).
 *   RECORDATORIOS_MODO=prueba npx tsx scripts/recordatorios-prueba.ts directo <booking_id>
 *
 *   # 2b. Con la RPi en modo prueba: no hagas nada, el barredor lo envía a su hora.
 *
 *   # 3. Resultado: estado, hora planeada, hora real y atraso por fila.
 *   npx tsx scripts/recordatorios-prueba.ts reporte <booking_id>
 *
 *   # Limpieza de las filas de prueba.
 *   npx tsx scripts/recordatorios-prueba.ts borrar
 *
 * Las filas llevan `es_prueba = true` y booking_id `prueba-...`: no tienen cita en
 * calcom_bookings y el barredor no las toca al sincronizar.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { enviarUno } from '../src/services/recordatorios/core.js';
import { enviosReales } from '../src/trigger/recordatorios-llamada.js';

const EMAIL = process.env.PRUEBA_EMAIL || 'juanalbertoortega456@gmail.com';
const PHONE = process.env.PRUEBA_PHONE || '573216119791';
const MEET = 'https://meet.google.com/prueba-recordatorio';

const [accion, arg] = process.argv.slice(2);

async function crear() {
  const bookingId = `prueba-${Date.now()}`;
  const ahora = Date.now();
  const startsAt = new Date(ahora + 10 * 60_000);
  // Separados 60 s para ver cada uno llegar y medir el atraso de cada uno.
  const plan: [string, string, number][] = [
    ['confirmacion', 'whatsapp', 90], ['confirmacion', 'email', 90],
    ['t24h', 'whatsapp', 150], ['t24h', 'email', 150],
    ['t2h', 'whatsapp', 210],
    ['t10m', 'whatsapp', 270], ['t10m', 'email', 270],
  ];
  for (const [tipo, canal, seg] of plan) {
    await db.execute(sql`
      INSERT INTO call_reminders (booking_id, tipo, canal, send_at, starts_at, dest_email, dest_phone, nombre, meet_url, es_prueba)
      VALUES (${bookingId}, ${tipo}, ${canal}, ${new Date(ahora + seg * 1000).toISOString()}, ${startsAt.toISOString()},
              ${EMAIL}, ${PHONE}, 'Juan Prueba', ${MEET}, true)
    `);
  }
  console.log(`creada ${bookingId}: 7 envíos entre +90 s y +270 s, llamada a las ${startsAt.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' })}`);
  console.log(`destinos: ${EMAIL} · ${PHONE}`);
}

async function directo(bookingId: string) {
  const r = await db.execute<{ id: string; tipo: string; canal: string; send_at: string }>(sql`
    SELECT id, tipo, canal, send_at FROM call_reminders
    WHERE booking_id = ${bookingId} AND status = 'pendiente' ORDER BY send_at
  `);
  for (const f of r.rows) {
    const espera = new Date(f.send_at).getTime() - Date.now();
    if (espera > 0) {
      console.log(`  esperando ${Math.round(espera / 1000)} s para ${f.tipo}/${f.canal}`);
      await new Promise((ok) => setTimeout(ok, espera));
    }
    console.log(`  ${f.tipo}/${f.canal}:`, await enviarUno(Number(f.id), enviosReales));
  }
}

async function reporte(bookingId: string) {
  const r = await db.execute(sql`
    SELECT tipo, canal, status,
           to_char(send_at AT TIME ZONE 'America/Bogota', 'HH24:MI:SS') AS planeado,
           to_char(sent_at AT TIME ZONE 'America/Bogota', 'HH24:MI:SS.MS') AS enviado,
           lag_ms, via, entrega, left(entrega_error, 60) AS entrega_error, motivo
    FROM call_reminders WHERE booking_id = ${bookingId} ORDER BY send_at, canal
  `);
  console.table(r.rows);
  const lags = r.rows.filter((x) => x.lag_ms != null).map((x) => Number(x.lag_ms)).sort((a, b) => a - b);
  if (lags.length) {
    const p = (q: number) => lags[Math.min(lags.length - 1, Math.floor(q * lags.length))];
    console.log(`atraso ms: min ${lags[0]} · p50 ${p(0.5)} · p95 ${p(0.95)} · max ${lags[lags.length - 1]}`);
  }
}

async function borrar() {
  const r = await db.execute(sql`DELETE FROM call_reminders WHERE es_prueba`);
  console.log(`borradas ${r.rowCount} filas de prueba`);
}

if (accion === 'crear') await crear();
else if (accion === 'directo' && arg) await directo(arg);
else if (accion === 'reporte' && arg) await reporte(arg);
else if (accion === 'borrar') await borrar();
else console.log('uso: crear | directo <booking_id> | reporte <booking_id> | borrar');
process.exit(0);

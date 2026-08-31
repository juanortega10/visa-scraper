/**
 * Bots ACTIVOS cuya cita ya paso. No pueden reagendar, solo gastan peticiones.
 *
 * Ver `src/services/citas-vencidas.ts` para el porque y para la regla de severidad.
 * Aqui solo se lee la base y se imprime; la decision vive en la funcion pura, que es
 * la que tiene tests.
 *
 * Sale con codigo 1 si hay hallazgos, para servir de compuerta en un cron.
 *
 *   npx tsx --env-file=.env scripts/audit-citas-vencidas.ts
 *   npx tsx --env-file=.env scripts/audit-citas-vencidas.ts --avisar   # correo + telegram
 *   npx tsx --env-file=.env scripts/audit-citas-vencidas.ts --json
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import {
  evaluarCitaVencida, ordenarHallazgos, resumir, textoTelegram,
  type EntradaCitaVencida, type ResultadoCitaVencida,
} from '../src/services/citas-vencidas.js';
import { sendCitasVencidasEmail, sendTelegram } from '../src/services/notifications.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);

const filas = await db.execute(sql`
  SELECT b.id, b.locale, b.status, b.current_consular_date::text cita,
         ag.name agencia,
         COALESCE((SELECT SUM(p.polls_since_prev) FROM poll_logs p
                   WHERE p.bot_id = b.id AND p.created_at > now() - interval '24 hours'), 0) polls24h
  FROM bots b LEFT JOIN agencies ag ON ag.id = b.agency_id
  WHERE b.status IN ('active','error') AND b.current_consular_date IS NOT NULL
`);

const [{ total: pollsFlota }] = (await db.execute(sql`
  SELECT COALESCE(SUM(polls_since_prev), 0) total FROM poll_logs
  WHERE created_at > now() - interval '24 hours'
`)).rows as unknown as Array<{ total: string }>;

const hoy = new Date().toISOString().slice(0, 10);
const hallazgos: ResultadoCitaVencida[] = [];
for (const r of filas.rows as unknown as Array<Record<string, unknown>>) {
  const e: EntradaCitaVencida = {
    botId: Number(r.id), locale: String(r.locale ?? ''), status: String(r.status ?? ''),
    cita: (r.cita as string) ?? null, polls24h: Number(r.polls24h ?? 0),
    agencia: (r.agencia as string) ?? null,
  };
  const v = evaluarCitaVencida(e, hoy);
  if (v) hallazgos.push(v);
}

const orden = ordenarHallazgos(hallazgos);
const resumen = resumir(orden, Number(pollsFlota));

if (flag('json')) {
  console.log(JSON.stringify({ resumen, hallazgos: orden }, null, 1));
} else {
  console.log(`\nCITAS VENCIDAS · ${hoy} · ${resumen.total} bots`);
  if (resumen.total === 0) {
    console.log('\n  ninguno\n');
  } else {
    console.log(`${resumen.criticos} criticos · ${resumen.pollsDesperdiciados.toLocaleString('es-CO')} polls en 24 h · ${resumen.porcentajeDeFlota}% de la carga de la flota\n`);
    console.log('  bot   locale   cita         vencida  polls 24h  dueno      severidad  motivo');
    console.log('  ' + '-'.repeat(94));
    for (const f of orden) {
      console.log(
        `  ${String(f.botId).padEnd(6)}${f.locale.padEnd(9)}${(f.cita ?? '').padEnd(13)}` +
        `${(f.diasVencida + ' d').padStart(7)}  ${f.polls24h.toLocaleString('es-CO').padStart(9)}  ` +
        `${(f.agencia ?? 'directo').padEnd(11)}${f.severidad.padEnd(11)}${f.motivo}`,
      );
    }
    console.log('\n  Un bot con la cita en el pasado NO puede reagendar: necesita una fecha');
    console.log('  estrictamente anterior y no existe. Revisa el saldo antes de pausar.\n');
  }
}

if (flag('avisar') && orden.length > 0) {
  const to = process.env.ADMIN_NOTIFICATION_EMAIL ?? '';
  // Los dos canales van en paralelo y ninguno puede tumbar al otro: `sendTelegram`
  // nunca lanza, y el correo se envuelve para que un fallo de Resend no impida el aviso
  // por Telegram. Una alerta que depende de un solo canal se puede perder entera.
  const [correo, tg] = await Promise.allSettled([
    sendCitasVencidasEmail(to, orden.map((f) => ({
      botId: f.botId, locale: f.locale, cita: f.cita as string, diasVencida: f.diasVencida,
      polls24h: f.polls24h, severidad: f.severidad, motivo: f.motivo, agencia: f.agencia,
    })), resumen),
    sendTelegram(textoTelegram(orden, resumen)),
  ]);
  console.log(`  correo: ${correo.status === 'fulfilled' ? `enviado a ${to || '(sin destinatario)'}` : `FALLO ${String((correo as PromiseRejectedResult).reason).slice(0, 120)}`}`);
  console.log(`  telegram: ${tg.status === 'fulfilled' && tg.value ? 'enviado' : 'no enviado'}`);
}

process.exit(orden.length > 0 ? 1 : 0);

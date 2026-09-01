/**
 * Detector de cadenas dormidas — bots `active` que llevan horas sin pollear.
 *
 * El caso que lo motiva: el bot 281 estuvo 63 h sin un solo poll (2026-08-27 17:51
 * al 2026-08-30 09:06 Bogota) mientras figuraba `active` en el dashboard. Ninguna
 * capa lo reporto. El mismo patron golpeo a los bots 7, 223, 240, 283, 285 y 299 en
 * esos dos dias: la flota `dev` bajo de 12 bots a 7 y volvio sola solo tras un deploy.
 *
 * Por que las alarmas viejas no sirven aca:
 *   - el dashboard mira `bots.status` y `updated_at`, y los dos siguen frescos.
 *   - `audit-blind-bots.ts` busca bots que pollean sin ver fechas. Este bot no pollea.
 *   - el heartbeat de `poll-logging.ts` escribe cada 5 min mientras hay actividad. El
 *     silencio total no deja ninguna fila, entonces no hay nada que mirar.
 *
 * La invariante que revisa: un bot activo sin bloqueo no puede pasar de 35 min sin
 * pollear (`TOPE_SIN_BAN_MS`), y con bloqueo no puede pasar de 1,5 veces el backoff
 * que le corresponde. El umbral sale de `debeDespertar()`, la misma funcion que usa
 * el despertador de `poll-visa.ts`, mas un margen de 15 min. Si este script reporta
 * algo, el despertador fallo de verdad.
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/audit-cadenas-dormidas.ts
 *   npx tsx --env-file=.env scripts/audit-cadenas-dormidas.ts --env dev
 *   npx tsx --env-file=.env scripts/audit-cadenas-dormidas.ts --json
 *   npx tsx --env-file=.env scripts/audit-cadenas-dormidas.ts --despertar   # imprime los comandos
 *
 * Sale con codigo 1 si encuentra una cadena dormida. Sirve como compuerta de cron.
 */
import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
import { evaluarCadena, cadenasConProblema, cadenasEnBackoffLargo, cadenasGestionadasAparte, type EntradaCadena } from '../src/services/chain-health.js';
import type { RecentBlockRow } from '../src/services/scheduling.js';

const args = process.argv.slice(2);
const flag = (n: string, d: string): string => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const entornoPedido = flag('env', 'all');
const asJson = args.includes('--json');
const conComandos = args.includes('--despertar');

interface FilaBot extends Record<string, unknown> {
  id: number;
  locale: string;
  status: string;
  poll_environments: string[] | null;
  activated_at: string | null;
  ultimo_poll: string | null;
  ultimas: Array<{ status: string; blockCls: string | null; createdAt: string | null }> | null;
}

/**
 * Una sola consulta para toda la flota. El `lateral` trae las 5 filas mas nuevas de
 * `poll_logs` por bot; hacerlo con una consulta por bot tarda minutos con 240 bots.
 */
const filas = await db.execute<FilaBot>(sql`
  select b.id,
         b.locale,
         b.status,
         b.poll_environments,
         b.activated_at,
         u.ultimo_poll,
         u.ultimas
  from bots b
  left join lateral (
    select max(p.created_at) as ultimo_poll,
           jsonb_agg(jsonb_build_object(
             'status', p.status,
             'blockCls', p.connection_info->>'blockClassification',
             'createdAt', p.created_at
           ) order by p.id desc) as ultimas
    from (
      select id, status, connection_info, created_at
      from poll_logs where bot_id = b.id order by id desc limit 5
    ) p
  ) u on true
  where b.status in ('active', 'error')
`);

const ahora = Date.now();
const entradas: EntradaCadena[] = filas.rows.map((f) => ({
  botId: f.id,
  locale: f.locale,
  status: f.status,
  entornos: f.poll_environments ?? ['dev'],
  ultimoPoll: f.ultimo_poll ? new Date(`${f.ultimo_poll}Z`) : null,
  ultimas: (f.ultimas ?? []) as RecentBlockRow[],
  activatedAt: f.activated_at ? new Date(`${f.activated_at}Z`) : null,
}));

const alcance = entradas.filter((e) =>
  entornoPedido === 'all' ? true : e.entornos.includes(entornoPedido));

const resultados = alcance.map((e) => evaluarCadena(e, ahora));
const malas = cadenasConProblema(resultados);
const enBackoff = cadenasEnBackoffLargo(resultados);
const aparte = cadenasGestionadasAparte(resultados);

if (asJson) {
  console.log(JSON.stringify({ revisados: resultados.length, hallazgos: malas, backoffLargo: enBackoff, gestionadosAparte: aparte }, null, 2));
} else {
  console.log(`Cadenas revisadas: ${resultados.length} (entorno: ${entornoPedido})`);
  if (malas.length === 0) {
    console.log('Sin cadenas dormidas.');
  } else {
    console.log(`\nCADENAS DORMIDAS: ${malas.length}\n`);
    console.log('bot    locale  entorno      sin pollear   tolerancia   bloqueo');
    for (const m of malas) {
      const sinPoll = m.minSinPoll === null ? 'NUNCA' : `${m.minSinPoll} min`;
      const bloqueo = m.bansSeguidos > 0 ? `${m.blockCls} x${m.bansSeguidos}` : '-';
      console.log(
        `${String(m.botId).padEnd(6)} ${m.locale.padEnd(7)} ${m.entornos.join('+').padEnd(12)} ` +
        `${sinPoll.padEnd(13)} ${String(m.toleranciaMin + ' min').padEnd(12)} ${bloqueo}`,
      );
    }
    if (conComandos) {
      console.log('\nPara despertarlos:');
      for (const m of malas) {
        console.log(`  npx tsx --env-file=.env scripts/wake-bot.ts ${m.botId} --commit`);
      }
    }
  }
}

if (!asJson && enBackoff.length > 0) {
  // No piden accion: el backoff los justifica. Se listan porque un bot callado horas
  // no da servicio, y el veredicto `ok` lo tapaba. Ver BACKOFF_LARGO_MS.
  console.log(`\nEN BACKOFF LARGO (legitimo, sin accion): ${enBackoff.length}\n`);
  console.log('bot    locale  entorno      sin pollear   tolerancia   bloqueo');
  for (const m of enBackoff) {
    console.log(
      `${String(m.botId).padEnd(6)} ${m.locale.padEnd(7)} ${m.entornos.join('+').padEnd(12)} ` +
      `${String(m.minSinPoll + ' min').padEnd(13)} ${String(m.toleranciaMin + ' min').padEnd(12)} ` +
      `${m.blockCls} x${m.bansSeguidos}`,
    );
  }
}

if (!asJson && aparte.length > 0) {
  // Sin entornos no hay cron que los tome: otro proceso los maneja. Se listan para que
  // se vea que existen, y quedan fuera del conteo de problemas.
  console.log(`\nGESTIONADOS APARTE (otro proceso, sin accion): ${aparte.length}\n`);
  console.log('bot    locale  sin pollear');
  for (const m of aparte) {
    console.log(`${String(m.botId).padEnd(6)} ${m.locale.padEnd(7)} ${m.minSinPoll === null ? 'NUNCA' : m.minSinPoll + ' min'}`);
  }
}

process.exit(malas.length > 0 ? 1 : 0);

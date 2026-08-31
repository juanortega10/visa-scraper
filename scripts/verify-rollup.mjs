/**
 * Verificador del resumen por hora (`bot_hourly`).
 *
 * No comprueba que la tarea corra sin error. Comprueba que cada numero que deja
 * sea igual al que sale de contar la fuente con OTRA consulta, escrita aparte.
 * Si las dos consultas fueran la misma, el verificador no probaria nada.
 *
 * Recuenta TODAS las filas de la ventana, no una muestra. Un verificador que
 * revisa un bot por hora deja pasar el fallo que solo afecta a los demas, y ese
 * es justo el que nadie mira.
 *
 * Trae su propia prueba negativa: corrompe una fila a proposito y exige que el
 * verificador la marque en rojo. Un verificador que solo sabe decir que si no
 * sirve para decidir nada.
 *
 * Uso:
 *   node scripts/verify-rollup.mjs                # ultimas 6 horas
 *   node scripts/verify-rollup.mjs --horas 24
 *   node scripts/verify-rollup.mjs --sin-negativa # no toca datos
 */
import { readFileSync } from 'fs';
import { neon } from '@neondatabase/serverless';

function loadEnv(f) {
  const e = {};
  try {
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      const t = l.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 0) continue;
      e[t.slice(0, i)] = t.slice(i + 1).replace(/^"|"$/g, '');
    }
  } catch {}
  return e;
}

const env = { ...loadEnv('.env'), ...loadEnv('.env.local') };
const sql = neon(env.DATABASE_URL);
// La tarea compilada arma su propia conexion leyendo process.env, asi que la
// comprobacion de idempotencia necesita la variable puesta aca tambien.
process.env.DATABASE_URL ??= env.DATABASE_URL;

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const HORAS = arg('--horas', 6);
const CAMPOS = ['poll_rows', 'polls', 'blocked', 'errors'];

/** Recuento independiente, cruzado contra el resumen fila por fila. */
async function comparar(desde, hasta) {
  return await sql`
    WITH fuente AS (
      SELECT bot_id,
             date_trunc('hour', created_at)                      AS hour,
             count(*)::int                                       AS poll_rows,
             sum(coalesce(polls_since_prev, 1))::int             AS polls,
             count(*) FILTER (WHERE status = 'tcp_blocked')::int  AS blocked,
             count(*) FILTER (WHERE status = 'error')::int        AS errors
      FROM poll_logs
      WHERE created_at >= ${desde} AND created_at < ${hasta}
      GROUP BY 1, 2
    )
    SELECT coalesce(f.bot_id, r.bot_id) AS bot_id,
           coalesce(f.hour, r.hour)     AS hour,
           f.poll_rows AS f_poll_rows, r.poll_rows AS r_poll_rows,
           f.polls     AS f_polls,     r.polls     AS r_polls,
           f.blocked   AS f_blocked,   r.blocked   AS r_blocked,
           f.errors    AS f_errors,    r.errors    AS r_errors
    FROM fuente f
    FULL OUTER JOIN bot_hourly r ON r.bot_id = f.bot_id AND r.hour = f.hour
    WHERE coalesce(f.hour, r.hour) >= ${desde} AND coalesce(f.hour, r.hour) < ${hasta}
    ORDER BY 2 DESC, 1`;
}

async function main() {
  const ahora = Date.now();
  const hasta = new Date(Math.floor(ahora / 3_600_000) * 3_600_000);
  const desde = new Date(hasta.getTime() - HORAS * 3_600_000);
  console.log(`ventana: ${desde.toISOString()} .. ${hasta.toISOString()}\n`);

  const filas = await comparar(desde, hasta);
  if (filas.length === 0) {
    console.log('RESULTADO: FALLA. No hay nada que verificar en la ventana.');
    process.exit(1);
  }

  let fallos = 0;
  let comprobaciones = 0;
  const rotas = [];
  for (const f of filas) {
    for (const campo of CAMPOS) {
      const fuente = f[`f_${campo}`];
      const resumen = f[`r_${campo}`];
      // Una hora sin filas de poll no tiene por que existir en el resumen.
      if (fuente === null && (resumen === null || Number(resumen) === 0)) continue;
      comprobaciones++;
      if (Number(fuente ?? 0) !== Number(resumen ?? -1)) {
        fallos++;
        rotas.push(
          `bot ${f.bot_id} ${new Date(f.hour).toISOString().slice(0, 16)} ` +
          `${campo}: resumen=${resumen} fuente=${fuente}`,
        );
      }
    }
  }

  const horasCubiertas = new Set(filas.map((f) => new Date(f.hour).toISOString())).size;
  console.log(`filas comparadas (bot x hora): ${filas.length}`);
  console.log(`campos comprobados: ${comprobaciones}`);
  console.log(`horas con datos: ${horasCubiertas} de ${HORAS}`);
  if (rotas.length) {
    console.log('\nDESCUADRES:');
    rotas.slice(0, 15).forEach((r) => console.log('  ' + r));
    if (rotas.length > 15) console.log(`  ... y ${rotas.length - 15} mas`);
  }

  // ── Invariantes: no dependen de recontar, solo de que la fila sea coherente ─
  const [inv] = await sql`
    SELECT count(*) FILTER (WHERE wins > attempts)::int              AS wins_mayor_intentos,
           count(*) FILTER (WHERE blind_ms > 3600000)::int           AS ceguera_mayor_a_una_hora,
           count(*) FILTER (WHERE poll_rows > polls)::int            AS filas_mayor_polls,
           count(*) FILTER (WHERE blocked + errors > poll_rows)::int AS fallos_mayor_filas,
           count(*) FILTER (WHERE phantom_dates > attempts)::int     AS fantasmas_mayor_intentos
    FROM bot_hourly WHERE hour >= ${desde}`;
  console.log('\ninvariantes (todos deben dar 0):', JSON.stringify(inv));
  for (const [k, v] of Object.entries(inv)) {
    comprobaciones++;
    if (Number(v) !== 0) { fallos++; console.log(`  ROTO: ${k} = ${v}`); }
  }

  // ── Idempotencia: reprocesar una hora no puede cambiar el resultado ────────
  // El import puede fallar (este script es .mjs y la tarea vive en TypeScript).
  // Si falla se DICE, no se salta en silencio: una comprobacion que desaparece
  // sin avisar es indistinguible de una que pasa.
  let rollupHour = null;
  try {
    ({ rollupHour } = await import('../dist/src/trigger/rollup-hourly.js'));
  } catch (e) {
    console.log(`\nidempotencia: NO VERIFICADA (${String(e).split('\n')[0].slice(0, 70)})`);
    console.log('  correr "npm run build" en visa-scraper para incluir esta comprobacion.');
  }
  if (rollupHour) {
    const hora = new Date(hasta.getTime() - 3_600_000);
    const [a] = await sql`SELECT count(*)::int n, coalesce(sum(polls),0)::int p FROM bot_hourly WHERE hour = ${hora}`;
    await rollupHour(hora);
    const [b] = await sql`SELECT count(*)::int n, coalesce(sum(polls),0)::int p FROM bot_hourly WHERE hour = ${hora}`;
    comprobaciones++;
    const idem = a.n === b.n && a.p === b.p;
    if (!idem) fallos++;
    console.log(`\nidempotencia: reprocesar ${hora.toISOString()} deja ${b.n} filas y ${b.p} polls ` +
                `(antes ${a.n} y ${a.p}): ${idem ? 'ok' : 'XX'}`);
  }

  console.log('-'.repeat(66));
  console.log(`comprobaciones: ${comprobaciones} | fallos: ${fallos}`);

  if (process.argv.includes('--sin-negativa')) {
    console.log(fallos === 0 ? '\nRESULTADO: PASA (sin prueba negativa).' : '\nRESULTADO: FALLA.');
    process.exit(fallos === 0 ? 0 : 1);
  }

  // ── Prueba negativa: romper a proposito y exigir rojo ──────────────────────
  const [victima] = await sql`
    SELECT bot_id, hour, poll_rows FROM bot_hourly
    WHERE hour >= ${desde} AND poll_rows > 0 ORDER BY poll_rows DESC LIMIT 1`;
  if (!victima) {
    console.log('\nRESULTADO: FALLA. Sin fila con la que probar el verificador.');
    process.exit(1);
  }
  const original = Number(victima.poll_rows);
  await sql`UPDATE bot_hourly SET poll_rows = ${original + 999}
            WHERE bot_id = ${victima.bot_id} AND hour = ${victima.hour}`;
  const conRuido = await comparar(desde, hasta);
  const detectado = conRuido.some(
    (f) => f.bot_id === victima.bot_id &&
           new Date(f.hour).getTime() === new Date(victima.hour).getTime() &&
           Number(f.r_poll_rows) !== Number(f.f_poll_rows ?? 0),
  );
  await sql`UPDATE bot_hourly SET poll_rows = ${original}
            WHERE bot_id = ${victima.bot_id} AND hour = ${victima.hour}`;
  const [restaurada] = await sql`SELECT poll_rows FROM bot_hourly
                                 WHERE bot_id = ${victima.bot_id} AND hour = ${victima.hour}`;
  const restaurado = Number(restaurada.poll_rows) === original;

  console.log(`\nprueba negativa: bot ${victima.bot_id}, poll_rows ${original} -> ${original + 999}`);
  console.log(`  el verificador lo detecta: ${detectado ? 'SI' : 'NO'}`);
  console.log(`  fila restaurada a ${restaurada.poll_rows}: ${restaurado ? 'ok' : 'XX'}`);

  if (!restaurado) {
    console.log('\nRESULTADO: FALLA. La prueba negativa dejo la fila corrompida.');
    process.exit(1);
  }
  if (!detectado) {
    console.log('\nRESULTADO: FALLA. El verificador no distingue una fila corrompida de una buena.');
    process.exit(1);
  }
  if (fallos > 0) {
    console.log('\nRESULTADO: FALLA. El resumen no coincide con la fuente.');
    process.exit(1);
  }
  console.log('\nRESULTADO: PASA. El resumen coincide con la fuente en cada fila, ' +
              'y el verificador se pone en rojo cuando debe.');
}

await main();

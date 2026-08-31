/**
 * Monitor del sistema de medicion (31 ago 2026).
 *
 * Vigila que lo que se acaba de instrumentar siga funcionando, y que el ahorro
 * no se deshaga solo. Cada senal esta atada a un fallo que ya paso hoy:
 *
 *   1. COBERTURA   `blind_ms` llegaba NULL en 6 de los 8 puntos que escriben
 *                  poll_logs, justo los de error y bloqueo.
 *   2. COSTO       `auth_logs` volvia a crecer si alguien reintroduce la
 *                  telemetria por poll. Llego a 434 MB por eso.
 *   3. RESUMEN     `bot_hourly` deja de llenarse si el cron no corre. Hoy el
 *                  cron es PRODUCTION-only y el worker cloud no esta desplegado.
 *   4. CUADRE      El resumen tiene que seguir coincidiendo con la fuente.
 *
 * Uso:  node scripts/monitor-medicion.mjs            (una pasada, sale 1 si hay alerta)
 *       node scripts/monitor-medicion.mjs --watch    (cada 15 min)
 */
import { readFileSync, appendFileSync } from 'fs';
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
const LOG = process.env.MONITOR_LOG || 'scripts/.monitor-medicion.log';

const emit = (l) => { console.log(l); try { appendFileSync(LOG, l + '\n'); } catch {} };

async function pasada() {
  const alertas = [];

  // 1. Cobertura de blind_ms en el worker del RPi, que es el 97% del trafico.
  //    El worker cloud queda fuera a proposito: corre otra version.
  const [cob] = await sql`
    SELECT count(*)::int filas, count(blind_ms)::int con_blind
    FROM poll_logs
    WHERE created_at > now() - interval '15 minutes' AND coalesce(chain_id, 'dev') = 'dev'`;
  const pct = cob.filas > 0 ? Math.round((100 * cob.con_blind) / cob.filas) : null;
  // El primer poll de cada cadena no tiene anterior con que comparar, entonces
  // el 100% no es alcanzable. Por debajo de 60% hay una ruta sin instrumentar.
  // Umbral en 50%: el primer poll de cada corrida no tiene anterior con que
  // comparar, y ademas hay filas del worker cloud sin chain_id marcado.
  if (cob.filas >= 10 && pct !== null && pct < 50) {
    alertas.push(`COBERTURA blind_ms en ${pct}% (${cob.con_blind}/${cob.filas}) en el RPi`);
  }

  // 2. auth_logs no puede volver a recibir telemetria por poll.
  const [au] = await sql`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE action IN ('token_fetch_failed', 'inline_relogin'))::int telemetria,
           count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int ultima_hora,
           pg_size_pretty(pg_total_relation_size('auth_logs')) tam
    FROM auth_logs`;
  // Mientras el worker cloud no se despliegue, el escribe telemetria con el
  // codigo viejo. Se separa para no confundir "falta un deploy" con "alguien
  // reintrodujo el ruido en el codigo".
  const [nube] = await sql`
    SELECT count(DISTINCT a.bot_id)::int bots FROM auth_logs a
    WHERE a.action IN ('token_fetch_failed', 'inline_relogin')
      AND a.bot_id IN (SELECT bot_id FROM poll_logs
                       WHERE chain_id = 'cloud' AND created_at > now() - interval '1 hour')`;
  if (au.telemetria > 0) {
    alertas.push(nube.bots > 0
      ? `COSTO auth_logs recibio ${au.telemetria} filas de telemetria, de ${nube.bots} bot(s) del worker cloud sin desplegar`
      : `COSTO auth_logs recibio ${au.telemetria} filas de telemetria y NO son del cloud: alguien la reintrodujo`);
  }
  if (au.ultima_hora > 200) alertas.push(`COSTO auth_logs crecio ${au.ultima_hora} filas en una hora`);

  // 3. El resumen por hora tiene que avanzar. Si la ultima hora resumida se
  //    aleja, el cron no esta corriendo.
  const [bh] = await sql`
    SELECT count(*)::int filas, max(hour) ultima,
           round(extract(epoch FROM now() - max(hour)) / 3600)::int horas_atras
    FROM bot_hourly`;
  if (bh.filas === 0) alertas.push('RESUMEN bot_hourly esta vacia');
  else if (bh.horas_atras > 3) alertas.push(`RESUMEN bot_hourly atrasada ${bh.horas_atras} h (cron sin correr)`);

  // 4. Cuadre e invariantes del resumen.
  const [inv] = await sql`
    SELECT count(*) FILTER (WHERE wins > attempts)::int              a,
           count(*) FILTER (WHERE blind_ms > 3600000)::int           b,
           count(*) FILTER (WHERE poll_rows > polls)::int            c,
           count(*) FILTER (WHERE blocked + errors > poll_rows)::int d,
           count(*) FILTER (WHERE phantom_dates > attempts)::int     e
    FROM bot_hourly WHERE hour > now() - interval '24 hours'`;
  const rotos = Object.entries(inv).filter(([, v]) => Number(v) > 0);
  if (rotos.length) alertas.push(`CUADRE invariantes rotos: ${rotos.map(([k, v]) => `${k}=${v}`).join(' ')}`);

  // 5. Las medidas de la carrera. No alertan: son el marcador que se quiere ver.
  const [carrera] = await sql`
    SELECT count(*)::int intentos,
           count(ms_to_post)::int con_ms,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms_to_post))::int p50,
           count(*) FILTER (WHERE times_seen = 0)::int fantasmas
    FROM reschedule_logs WHERE created_at > now() - interval '24 hours'`;

  const sello = alertas.length === 0 ? 'OK  ' : 'ALERTA';
  emit(
    `[${new Date().toISOString()}] ${sello} | blind_ms ${pct ?? '-'}% (${cob.filas} filas) | ` +
    `auth_logs ${au.total} filas ${au.tam} | bot_hourly ${bh.filas} filas, -${bh.horas_atras ?? '-'}h | ` +
    `carrera: ${carrera.intentos} intentos, ${carrera.con_ms} con ms_to_post, p50=${carrera.p50 ?? '-'}ms, ` +
    `${carrera.fantasmas} fantasmas`,
  );
  for (const a of alertas) emit(`[${new Date().toISOString()}]        ${a}`);
  return alertas.length;
}

if (!process.argv.includes('--watch')) {
  process.exit((await pasada()) > 0 ? 1 : 0);
}

emit(`[${new Date().toISOString()}] === monitor de medicion arranca, cada 15 min ===`);
for (;;) {
  try { await pasada(); } catch (e) {
    emit(`[${new Date().toISOString()}] ERROR del monitor: ${e instanceof Error ? e.message : String(e)}`);
  }
  await new Promise((r) => setTimeout(r, 15 * 60 * 1000));
}

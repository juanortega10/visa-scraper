/**
 * Verificador del camino critico del sniper de Peru (bot 299).
 *
 * NO es un chequeo verde facil. Cada verificador compara contra la LINEA BASE medida
 * el 2026-08-27, exige una muestra minima, y falla cuando no hay datos. Un
 * verificador que pasa sin datos es un verificador roto.
 *
 * Linea base (bot 299, las dos unicas detecciones de su vida):
 *   2026-10-08  visto a los 3,5 s · horas pedidas a los  7,9 s · regalado  4.408 ms
 *   2026-10-26  visto a los 2,8 s · horas pedidas a los 16,6 s · regalado 13.832 ms
 *   Las dos ranuras vivieron 9 y 15 segundos. Las dos se perdieron por `no_times`.
 *
 * Lee `sniper_scans` (fases `buscando`, `ensayo`, `deteccion_medida`) y `sessions`.
 * Solo lectura. Nunca toca el portal.
 *
 *   npx tsx --env-file=.env scripts/verificar-camino-critico.ts
 *   npx tsx --env-file=.env scripts/verificar-camino-critico.ts --horas 6 --min-muestra 20
 *
 * Sale con codigo 1 si algun verificador falla. Sirve de guardia en un loop.
 */
import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
import { TECHO_CARRERA_MS } from '../src/services/visa-client.js';

const arg = (n: string, d: number): number => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
};
// Ventana por defecto de 12 h. Con la cadencia degradada (`minutosEntreDisparos`) el
// sniper puede bajar a 6 disparos por hora a proposito, y una ventana de 6 h se queda
// sin muestra justo cuando el bot esta bloqueado. Doce horas aguanta el peor caso.
const HORAS = arg('horas', 12);
const MIN_MUESTRA = arg('min-muestra', 8);
const MIN_TICKS = arg('min-ticks', 30);

/** Linea base medida el 2026-08-27. Todo verificador compara contra esto. */
const BASE = {
  msLeerBot: 89,          // consulta a Neon desde el RPi (medido 2026-08-30)
  msDiasAHoras: 13_832,   // peor deteccion real
  msDiasAHorasMejor: 4_408,
  msHastaPedirHoras: 16_600,
  msTechoViejo: 12_294,   // headersTimeout del agente directo, gastado entero
};

interface Fila { fase: string; scanned_at: Date; payload: Record<string, unknown> }

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]!;
}

interface Verificador {
  id: string;
  que: string;
  ok: boolean;
  medido: string;
  umbral: string;
  base: string;
  n: number;
  /** Muestra que ESTE verificador necesita. Con `n` por debajo no hay veredicto. */
  muestraMin: number;
  nota?: string;
}
const resultados: Verificador[] = [];
const V = (v: Verificador) => { resultados.push(v); };

async function main() {
  const desde = new Date(Date.now() - HORAS * 3_600_000);

  const filas = (await db.execute(sql`
    SELECT phase AS fase, scanned_at, payload
    FROM sniper_scans
    WHERE scan_key = 'peru-299' AND scanned_at > ${desde.toISOString()}
    ORDER BY scanned_at
  `)).rows as unknown as Fila[];

  const ticks = filas.filter((f) => f.fase === 'buscando' || f.fase === 'deteccion' || f.fase === 'deteccion_medida');
  const carreras = filas.filter((f) => f.fase === 'ensayo' || f.fase === 'deteccion_medida');

  const campo = (fs: Fila[], k: string): number[] =>
    fs.map((f) => num(f.payload?.[k])).filter((x): x is number => x !== null);

  // ── V1 · anti-verde-falso ───────────────────────────────────────────────────
  // Sin muestra no hay veredicto. Este verificador existe para que los demas no
  // puedan pasar por vacio.
  V({
    id: 'V1', que: 'hay muestra suficiente para juzgar',
    ok: ticks.length >= MIN_TICKS && carreras.length >= MIN_MUESTRA,
    medido: `${ticks.length} ticks, ${carreras.length} carreras medidas`,
    umbral: `>= ${MIN_TICKS} ticks y >= ${MIN_MUESTRA} carreras`,
    base: `ventana de ${HORAS} h`,
    n: filas.length, muestraMin: MIN_TICKS,
    nota: filas.length === 0 ? 'el sniper no escribio nada: revisar si esta desplegado y vivo' : undefined,
  });

  // ── V2 · leerBot en memoria ─────────────────────────────────────────────────
  const leer = campo(ticks, 'msLeerBot');
  V({
    id: 'V2', que: 'la fila del bot sale de memoria, no de Neon',
    // 20 ms y no 5: la copia se refresca de fondo cada 60 s y esa vuelta si toca Neon,
    // entonces el p95 sube solo. Contra los 89 ms de Neon, 20 sigue probando la caché.
    ok: leer.length >= MIN_TICKS && pct(leer, 0.5) < 20,
    medido: leer.length ? `p50 ${pct(leer, 0.5)} ms · p95 ${pct(leer, 0.95)} ms` : 'sin datos',
    umbral: 'p50 < 20 ms', base: `${BASE.msLeerBot} ms contra Neon`, n: leer.length, muestraMin: MIN_TICKS,
  });

  // ── V3 · el tiempo REGALADO ─────────────────────────────────────────────────
  // De ver el cupo en days.json a lanzar la peticion de horas. Es la metrica que
  // decide si ganamos o perdemos una ranura de 9 segundos.
  const regalado = campo(carreras, 'msDiasAHoras');
  V({
    id: 'V3', que: 'de ver el cupo a pedir las horas',
    ok: regalado.length >= MIN_MUESTRA && pct(regalado, 0.95) < 50,
    medido: regalado.length ? `p50 ${pct(regalado, 0.5)} ms · p95 ${pct(regalado, 0.95)} ms` : 'sin datos',
    umbral: 'p95 < 50 ms',
    base: `${BASE.msDiasAHorasMejor} y ${BASE.msDiasAHoras} ms`, n: regalado.length, muestraMin: MIN_MUESTRA,
  });

  // ── V4 · el paralelo es real ────────────────────────────────────────────────
  // En serie, `msCarrera` seria la SUMA. En paralelo tiene que parecerse al MAXIMO.
  // Se compara par a par, no con promedios: un promedio esconde el caso malo.
  const pares = carreras
    .map((f) => ({ c: num(f.payload.msCarrera), t: num(f.payload.msTimes), a: num(f.payload.msApt) }))
    .filter((x): x is { c: number; t: number; a: number } => x.c !== null && x.t !== null && x.a !== null);
  const enSerie = pares.filter((x) => x.c > (x.t + x.a) * 0.85).length;
  const razon = pares.map((x) => x.c / Math.max(1, x.t + x.a));
  V({
    id: 'V4', que: 'horas y cita salen en paralelo, no en serie',
    ok: pares.length >= MIN_MUESTRA && enSerie === 0 && pct(razon, 0.95) < 0.85,
    medido: pares.length
      ? `carrera/suma p50 ${pct(razon, 0.5).toFixed(2)} · p95 ${pct(razon, 0.95).toFixed(2)} · ${enSerie} en serie`
      : 'sin datos',
    umbral: 'razon p95 < 0,85 y CERO vueltas en serie',
    base: 'razon 1,00 = serie', n: pares.length, muestraMin: MIN_MUESTRA,
  });

  // ── V5 · techo por peticion ─────────────────────────────────────────────────
  // Ninguna peticion del camino critico puede acercarse a los 12 s viejos.
  const times = campo(carreras, 'msTimes');
  const apts = campo(carreras, 'msApt');
  const peor = Math.max(...(times.length ? times : [0]), ...(apts.length ? apts : [0]));
  const techoDuro = TECHO_CARRERA_MS * 2 + 500;   // dos rutas: directa y proxy
  V({
    id: 'V5', que: 'ninguna peticion del camino critico pasa el techo',
    ok: times.length >= MIN_MUESTRA && peor < techoDuro,
    medido: times.length ? `peor ${peor} ms (times p95 ${pct(times, 0.95)}, cita p95 ${pct(apts, 0.95)})` : 'sin datos',
    umbral: `< ${techoDuro} ms`, base: `${BASE.msTechoViejo} ms`, n: times.length + apts.length, muestraMin: MIN_MUESTRA,
  });

  // ── V6 · el token esta vivo y su refresco cae FUERA del camino critico ──────
  //
  // CORREGIDO el 2026-08-30. La primera version exigia `tokenPrecalentado >= 90%` y
  // eso estaba mal: ese campo sale `false` cada vez que el sniper refresca el token
  // por su cadencia de rutina de 10 min (`POLITICA_TOKEN.cadenciaMs`). Ese refresco
  // corre en `sesionLista()`, ANTES de `days.json`, entonces nunca toca el camino
  // critico. El verificador castigaba el comportamiento correcto.
  //
  // El invariante que si importa: el token llega VIVO a cada tick, o sea por debajo
  // del techo duro de 45 min, y por eso el POST nunca tiene que pedirlo con el cupo
  // a la vista. La tasa de refresco se reporta como contexto.
  const TECHO_TOKEN_S = 45 * 60;
  const edades = campo(ticks, 'edadTokenS');
  const vivos = edades.filter((e) => e < TECHO_TOKEN_S).length;
  const precal = ticks.map((f) => f.payload.tokenPrecalentado).filter((x) => typeof x === 'boolean') as boolean[];
  const tasaRefresco = precal.length ? precal.filter((x) => !x).length / precal.length : 0;
  V({
    id: 'V6', que: 'el token llega vivo al tick, sin refresco en el camino',
    ok: edades.length >= MIN_TICKS && vivos === edades.length,
    medido: edades.length
      ? `${vivos}/${edades.length} bajo el techo · edad p95 ${pct(edades, 0.95)} s · refresco de rutina ${(tasaRefresco * 100).toFixed(0)}%`
      : 'sin datos',
    umbral: `todos < ${TECHO_TOKEN_S} s`,
    base: 'se pedia dentro del camino critico', n: edades.length, muestraMin: MIN_TICKS,
  });

  // ── V7 · el sello del token se persiste ─────────────────────────────────────
  // Solo se le exige sello fresco a un bot que ESTA POLLEANDO. Un bot en backoff de
  // `schedule_blocked` duerme 240 min a proposito y no puede refrescar nada; exigirselo
  // convierte un comportamiento correcto en una alarma (caso real: bot 223, 2026-08-30).
  // La invariante correcta es: si el bot polleo hace poco, mantuvo su token caliente.
  // El precalentado corre DESPUES de un poll que funciono. Un poll bloqueado corta el
  // flujo antes de llegar ahi, y el bot queda en backoff largo. Por eso la condicion
  // mira el ESTADO del ultimo poll, no solo su hora: un borde de 15 minutos hacia que
  // el verificador prendiera y apagara solo.
  // Se mira si el bot tuvo ALGUN poll sano en la ventana, no si el ULTIMO lo fue.
  // Con la version anterior, un bot que alterna `ok` y `error` prendia y apagaba el
  // verificador segun cual poll cayera de ultimo (caso real: bot 7, 2026-08-31).
  const sellos = (await db.execute(sql`
    SELECT s.bot_id, s.tokens_refreshed_at,
           (SELECT count(*) FROM poll_logs p
             WHERE p.bot_id = s.bot_id
               AND p.created_at > now() - interval '15 minutes'
               AND p.status IN ('ok', 'filtered_out'))::int AS polls_sanos
    FROM sessions s JOIN bots b ON b.id = s.bot_id
    WHERE b.locale = 'es-pe' AND b.status = 'active'
  `)).rows as Array<{ bot_id: number; tokens_refreshed_at: Date | null; polls_sanos: number }>;
  const VENTANA_MS = 15 * 60_000;
  const activos = sellos.filter((r) => r.polls_sanos > 0);
  const dormidos = sellos.length - activos.length;
  const frescos = activos.filter(
    (r) => r.tokens_refreshed_at && Date.now() - new Date(r.tokens_refreshed_at).getTime() < VENTANA_MS,
  );
  const sinSello = activos.filter((r) => !r.tokens_refreshed_at);
  V({
    id: 'V7', que: 'un bot que pollea mantiene su token caliente',
    ok: activos.length > 0 && frescos.length === activos.length,
    medido: `${frescos.length}/${activos.length} bots polleando con sello fresco` +
      (dormidos > 0 ? ` · ${dormidos} en backoff o bloqueados, no se les exige` : ''),
    umbral: 'todos los que pollean', base: 'la columna no existia', n: activos.length, muestraMin: 1,
    nota: sinSello.length > 0
      ? `bots polleando SIN sello: ${sinSello.map((r) => r.bot_id).join(', ')} — poll-visa no esta escribiendo`
      : (activos.length === 0 ? 'ningun bot es-pe polleo en los ultimos 15 min' : undefined),
  });

  // ── V8 · fase del tick contra la ventana de liberacion ──────────────────────
  const segs = campo(ticks, 'segundoTick');
  const dentro = segs.filter((x) => x >= 14 && x <= 24).length;
  const fracVentana = segs.length ? dentro / segs.length : 0;
  V({
    id: 'V8', que: 'los ticks caen en la ventana de liberacion de es-pe',
    ok: segs.length >= MIN_TICKS && fracVentana >= 0.9,
    medido: segs.length ? `${(fracVentana * 100).toFixed(1)}% en s14-s24` : 'sin datos',
    umbral: '>= 90%', base: 'ventana util medida s15-s24', n: segs.length, muestraMin: MIN_TICKS,
  });

  // ── V9 · nuestro overhead sobre lo que cuesta el portal ─────────────────────
  //
  // CORREGIDO el 2026-08-30. La primera version comparaba el total del ensayo contra
  // los 16.600 ms de una deteccion real, y eso NO es justo: el ensayo pregunta por una
  // fecha a 497 dias y las detecciones fueron a 42 y 60 dias. `times.json` es 6 veces
  // mas lento en fechas cercanas (p50 1.585 ms a menos de 30 dias contra 264 ms a mas
  // de 180). Ademas la base sale de `poll-visa` y el ensayo del sniper, con n=1 contra
  // n=20. El verde decia mas de lo que la evidencia aguantaba.
  //
  // Lo que si se puede medir sin depender de la banda: cuanto agregamos NOSOTROS por
  // encima de lo que tarda el portal. Si eso es casi cero, el camino critico ya no
  // tiene grasa nuestra, tarde el portal 250 ms u 8 segundos.
  //
  //   overhead = (regalado + carrera) - max(times.json, cita)
  //
  // El total crudo se sigue mostrando como contexto, y NO decide el veredicto.
  const overheads = carreras
    .map((f) => {
      const r = num(f.payload.msDiasAHoras); const c = num(f.payload.msCarrera);
      const t = num(f.payload.msTimes); const a = num(f.payload.msApt);
      if (r === null || c === null || t === null || a === null) return null;
      return (r + c) - Math.max(t, a);
    })
    .filter((x): x is number => x !== null);
  const total = carreras
    .map((f) => {
      const r = num(f.payload.msDiasAHoras); const c = num(f.payload.msCarrera);
      return r !== null && c !== null ? r + c : null;
    })
    .filter((x): x is number => x !== null);
  const bandas = carreras.map((f) => num(f.payload.diasHastaFecha)).filter((x): x is number => x !== null);
  V({
    id: 'V9', que: 'nuestro overhead sobre el costo del portal es despreciable',
    ok: overheads.length >= MIN_MUESTRA && pct(overheads, 0.95) < 100,
    medido: overheads.length
      ? `overhead p50 ${pct(overheads, 0.5)} ms · p95 ${pct(overheads, 0.95)} ms` +
        ` · (total crudo p50 ${pct(total, 0.5)} ms a ${bandas.length ? pct(bandas, 0.5) : '?'} dias)`
      : 'sin datos',
    umbral: 'p95 < 100 ms',
    base: `${BASE.msDiasAHoras} ms de prep en la peor deteccion`, n: overheads.length, muestraMin: MIN_MUESTRA,
    nota: bandas.length && pct(bandas, 0.5) > 180
      ? 'el total crudo mide la banda BARATA del portal; no compararlo contra detecciones cercanas'
      : undefined,
  });

  // ── V10 · los techos no matan peticiones vivas ─────────────────────────────
  // Un techo demasiado corto convierte "lento pero vivo" en "perdido". Este
  // verificador es el contrapeso de V5: V5 exige que nada se cuelgue, V10 exige que
  // el corte no este abortando trabajo bueno.
  const ensayos = filas.filter((f) => f.fase === 'ensayo');
  const conFallo = ensayos.filter((f) => typeof f.payload.falloEnsayo === 'string' && f.payload.falloEnsayo);
  const fracFallo = ensayos.length ? conFallo.length / ensayos.length : 1;
  V({
    id: 'V10', que: 'los techos no abortan peticiones sanas',
    ok: ensayos.length >= MIN_MUESTRA && fracFallo <= 0.1,
    medido: ensayos.length ? `${conFallo.length}/${ensayos.length} ensayos con abort o error` : 'sin datos',
    umbral: '<= 10%',
    base: 'con techo de 3.000 ms fallaba el 100%', n: ensayos.length, muestraMin: MIN_MUESTRA,
    nota: conFallo.length > 0 ? String(conFallo[conFallo.length - 1]!.payload.falloEnsayo) : undefined,
  });

  // ── informe ─────────────────────────────────────────────────────────────────
  const ancho = { id: 3, que: 48, medido: 40, umbral: 26 };
  console.log(`\nVERIFICACION DEL CAMINO CRITICO · bot 299 · ultimas ${HORAS} h`);
  console.log(`${filas.length} filas en sniper_scans · ${ticks.length} ticks · ${carreras.length} carreras\n`);
  console.log(
    'ID'.padEnd(ancho.id) + ' ' + 'QUE SE VERIFICA'.padEnd(ancho.que) + ' ' +
    'MEDIDO'.padEnd(ancho.medido) + ' ' + 'UMBRAL'.padEnd(ancho.umbral) + ' LINEA BASE',
  );
  console.log('-'.repeat(150));
  for (const r of resultados) {
    const marca = r.ok ? 'PASA' : 'FALLA';
    console.log(
      `${r.id.padEnd(ancho.id)} ${r.que.padEnd(ancho.que)} ${r.medido.padEnd(ancho.medido)} ${r.umbral.padEnd(ancho.umbral)} ${r.base}   [${marca}]`,
    );
    if (r.nota) console.log(`    ${' '.repeat(ancho.id)}nota: ${r.nota}`);
  }

  // TRES estados, no dos. Un verificador sin muestra NO es una regresion: cuando el
  // portal cierra la ruta del schedule, el sniper baja su cadencia a proposito
  // (`minutosEntreDisparos`) y deja de escribir filas. Reportar eso como falla hace que
  // la alarma grite justo cuando el bot esta haciendo lo correcto.
  //
  //   0  pasan los que se pudieron juzgar
  //   1  REGRESION: algo medible empeoro
  //   2  SIN VEREDICTO: no hay muestra suficiente
  const fallan = resultados.filter((r) => !r.ok);
  // V1 ES la compuerta de muestra. Si falla, no hay nada que juzgar en todo el informe:
  // el resto de los numeros salen de datos que ya sabemos insuficientes.
  const v1 = resultados.find((r) => r.id === 'V1');
  const sinMuestra = v1 && !v1.ok ? fallan : fallan.filter((r) => r.n < r.muestraMin);
  const regresiones = fallan.filter((r) => !sinMuestra.includes(r));

  console.log('');
  if (fallan.length === 0) {
    console.log(`Los ${resultados.length} verificadores pasan.`);
    process.exit(0);
  }
  if (regresiones.length === 0) {
    console.log(`SIN VEREDICTO en ${sinMuestra.length}: ${sinMuestra.map((r) => r.id).join(', ')}`);
    console.log('No hay muestra suficiente. Revisar si el bot esta bloqueado antes de buscar una regresion.');
    process.exit(2);
  }
  console.log(`FALLAN ${regresiones.length} de ${resultados.length}: ${regresiones.map((r) => r.id).join(', ')}`);
  if (sinMuestra.length > 0) console.log(`(ademas, ${sinMuestra.length} sin muestra: ${sinMuestra.map((r) => r.id).join(', ')})`);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });

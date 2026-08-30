/**
 * ARREGLO DE ORDEN · 2026-09-16 · familia Alvarez / Perez.
 *
 * Estado al crearlo (2026-08-26 02:55Z): los DOS grupos ya estan el 2026-09-16.
 *   NINOS  (bot 140)  10:00  ·  CAS 2026-09-04 13:30
 *   PADRES (bot 141)  10:30  ·  CAS 2026-09-05 09:15
 *
 * Falta una sola cosa: los padres deben ir ANTES o A LA MISMA HORA que los ninos.
 * Hoy van 30 min despues. Hay dos formas de arreglarlo:
 *
 *   A · MOVER PADRES a una hora <= la de los ninos.  Es la via segura: solo va
 *       hacia atras, cumple la regla critica sin excepciones.
 *   B · MOVER NINOS a una hora >= la de los padres.  Los mueve mas tarde el mismo
 *       dia. Autorizado por el dueno para este caso.
 *
 * Siempre se prefiere A. B entra solo si A no tiene candidatos.
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/fix-order-victoria.ts                  # dry-run
 *   npx tsx --env-file=.env scripts/fix-order-victoria.ts --loop --commit  # real
 *   npx tsx --env-file=.env scripts/fix-order-victoria.ts --solo-padres    # desactiva B
 */
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { bots, rescheduleLogs } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { loginWithFallback } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import { notifyUser } from '../src/services/notifications.js';

const DAY = '2026-09-16';
const PARENTS_BOT = 141;
const CHILDREN_BOT = 140;
const GAP_MAX_MIN = 60;
const COMMIT = process.argv.includes('--commit');
const LOOP = process.argv.includes('--loop');
/** Desactiva la via B. Solo intenta adelantar a los padres. */
const ONLY_PARENTS = process.argv.includes('--solo-padres');
const CAS_TICK_SECOND = 14;
const FULL_EVERY_TICKS = 5;
const CLIENT_TTL_MS = 40 * 60_000;
const DEADLINE = '2026-09-15';

const log = (...p: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}Z]`, ...p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

async function open(botId: number) {
  const [row] = await db.select().from(bots).where(eq(bots.id, botId));
  const r = row!;
  const { result: login } = await loginWithFallback({
    email: decrypt(r.visaEmail as string), password: decrypt(r.visaPassword as string),
    scheduleId: String(r.scheduleId), applicantIds: (r.applicantIds ?? []) as string[], locale: 'es-co',
  });
  const client = new VisaClient(
    { cookie: login.cookie, csrfToken: login.csrfToken ?? '', authenticityToken: login.authenticityToken ?? '' },
    { scheduleId: String(r.scheduleId), applicantIds: (r.applicantIds ?? []) as string[],
      consularFacilityId: String(r.consularFacilityId ?? '25'), ascFacilityId: String(r.ascFacilityId ?? '26'),
      proxyProvider: r.proxyProvider, postProvider: r.proxyProvider,
      proxyUrls: r.proxyUrls as string[] | null, locale: 'es-co', userId: String(r.userId) },
  );
  return { row: r, client };
}

async function currentAppt(client: VisaClient) {
  const a = await client.getCurrentAppointment();
  return a ? { d: a.consularDate, t: a.consularTime, cd: a.casDate, ct: a.casTime } : null;
}

let cache: { P: Awaited<ReturnType<typeof open>>; C: Awaited<ReturnType<typeof open>>; at: number } | null = null;

async function clients(force = false) {
  if (force || !cache || Date.now() - cache.at > CLIENT_TTL_MS) {
    const [P, C] = await Promise.all([open(PARENTS_BOT), open(CHILDREN_BOT)]);
    await Promise.all([P.client.refreshTokens(), C.client.refreshTokens()]);
    cache = { P, C, at: Date.now() };
  }
  return cache;
}

/** Quien se mueve, a que hora, y por que. */
interface Move { who: 'PADRES' | 'NINOS'; botId: number; from: string; to: string; gapMin: number }

/**
 * Elige el movimiento. Prefiere adelantar a los padres (via A). La via B solo
 * entra si A no ofrece nada.
 */
function pickMove(pNow: string, cNow: string, pTimes: string[], cTimes: string[]): Move | null {
  // Via A: padres a una hora <= la de los ninos, y estrictamente antes de la suya.
  const a = pTimes
    .filter((t) => toMin(t) <= toMin(cNow) && toMin(t) < toMin(pNow))
    .filter((t) => toMin(cNow) - toMin(t) <= GAP_MAX_MIN)
    .sort((x, y) => (toMin(cNow) - toMin(y)) - (toMin(cNow) - toMin(x)));   // gap mas chico primero
  if (a[0]) return { who: 'PADRES', botId: PARENTS_BOT, from: pNow, to: a[0], gapMin: toMin(cNow) - toMin(a[0]) };
  if (ONLY_PARENTS) return null;

  // Via B: ninos a una hora >= la de los padres, y estrictamente despues de la suya.
  const b = cTimes
    .filter((t) => toMin(t) >= toMin(pNow) && toMin(t) > toMin(cNow))
    .filter((t) => toMin(t) - toMin(pNow) <= GAP_MAX_MIN)
    .sort((x, y) => (toMin(x) - toMin(pNow)) - (toMin(y) - toMin(pNow)));
  if (b[0]) return { who: 'NINOS', botId: CHILDREN_BOT, from: cNow, to: b[0], gapMin: toMin(b[0]) - toMin(pNow) };
  return null;
}

/** Ultimo estado bueno de una verificacion completa. Lo usa la ruta rapida. */
let live: { move: Move; pNow: string; cNow: string; at: number } | null = null;

async function casProbe(): Promise<string[]> {
  if (!live) return [];
  const { P, C } = await clients();
  const cl = live.move.who === 'PADRES' ? P.client : C.client;
  const days = await cl.getCasDays(DAY, live.move.to);
  return (days as Array<{ date: string }>).map((d) => d.date).filter((d) => d <= DAY).sort();
}

function sleepToTick(): Promise<void> {
  const now = new Date();
  const target = new Date(now);
  target.setUTCSeconds(CAS_TICK_SECOND, 0);
  if (target.getTime() <= now.getTime()) target.setUTCMinutes(target.getUTCMinutes() + 1);
  return sleep(target.getTime() - now.getTime());
}

/** Ejecuta un movimiento y verifica contra el portal. Devuelve true si quedo. */
async function commitMove(move: Move, casDate: string, casTime: string): Promise<boolean> {
  const { P, C } = await clients();
  const g = move.who === 'PADRES' ? P : C;

  log(`  [${move.who}] POST → ${DAY} ${move.to} | CAS ${casDate} ${casTime}`);
  let claimed = false;
  try { claimed = await g.client.reschedule(DAY, move.to, casDate, casTime); }
  catch (e) { log(`  [${move.who}] POST error: ${(e as Error).message}`); }

  await sleep(2500);
  const after = await currentAppt(g.client);
  const ok = after?.d === DAY && after?.t === move.to;
  log(`  [${move.who}] ahora: ${after?.d} ${after?.t} | CAS ${after?.cd} ${after?.ct} → ${ok ? 'OK' : 'NO COINCIDE'}`);

  await db.insert(rescheduleLogs).values({
    botId: move.botId,
    oldConsularDate: DAY, oldConsularTime: move.from,
    newConsularDate: ok ? DAY : null, newConsularTime: ok ? move.to : null,
    newCasDate: ok ? casDate : null, newCasTime: ok ? casTime : null,
    success: ok, provider: g.row.proxyProvider,
    failStep: ok ? null : 'order_verify',
    error: ok ? null : `[fix_order] claimed=${claimed} target=${DAY} ${move.to} actual=${after?.d} ${after?.t}`,
    detail: { source: 'fix-order-victoria', via: move.who === 'PADRES' ? 'A' : 'B', claimed },
  });

  if (ok && after) {
    await db.update(bots).set({
      currentConsularDate: after.d, currentConsularTime: after.t,
      currentCasDate: after.cd, currentCasTime: after.ct,
      rescheduleCount: (g.row.rescheduleCount ?? 0) + 1,
    }).where(eq(bots.id, move.botId));
    cache = null;   // los datos de la fila quedaron viejos
  } else {
    cache = null;   // el POST fallido pudo ensuciar los tokens
  }
  return ok;
}

/** Ruta rapida: la sonda ya vio CAS. Pide la hora y postea. */
async function fastFire(casDate: string): Promise<boolean> {
  if (!live || Date.now() - live.at > 10 * 60_000) { log('  [rapido] plan viejo. Cae a la ruta larga.'); return false; }
  const { move, pNow, cNow } = live;

  // Guardas duras.
  if (move.who === 'PADRES' && !(toMin(move.to) < toMin(pNow))) { log('  [rapido] ABORTA: no adelanta a los padres.'); return false; }
  if (move.who === 'PADRES' && !(toMin(move.to) <= toMin(cNow))) { log('  [rapido] ABORTA: dejaria a los padres despues de los ninos.'); return false; }
  if (move.who === 'NINOS' && !(toMin(move.to) >= toMin(pNow))) { log('  [rapido] ABORTA: dejaria a los ninos antes de los padres.'); return false; }
  if (move.who === 'NINOS' && !(toMin(move.to) > toMin(cNow))) { log('  [rapido] ABORTA: no cambia la hora de los ninos.'); return false; }

  const { P, C } = await clients();
  const cl = move.who === 'PADRES' ? P.client : C.client;
  const times = ((await cl.getCasTimes(casDate, DAY, move.to)).available_times ?? []) as string[];
  if (!times[0]) { log(`  [rapido] la CAS ${casDate} se fue antes de la hora.`); return false; }

  if (!COMMIT) { log(`  [rapido] DRY-RUN. Movería ${move.who} ${move.from} → ${move.to} con CAS ${casDate} ${times[0]}.`); return false; }
  return commitMove(move, casDate, times[0]);
}

/** Verificacion completa. Devuelve true si ya no hay nada mas que hacer. */
async function attempt(): Promise<boolean> {
  const { P, C } = await clients();
  const [pNow, cNow] = await Promise.all([currentAppt(P.client), currentAppt(C.client)]);
  log(`  PADRES: ${pNow?.d} ${pNow?.t} | CAS ${pNow?.cd} ${pNow?.ct}`);
  log(`  NINOS:  ${cNow?.d} ${cNow?.t} | CAS ${cNow?.cd} ${cNow?.ct}`);

  if (!pNow || !cNow) { log('  no se pudo leer una de las citas.'); return false; }
  if (pNow.d !== DAY || cNow.d !== DAY) {
    log(`  ALTO: alguno ya no esta en ${DAY} (padres ${pNow.d}, ninos ${cNow.d}). No se toca nada.`);
    return false;
  }
  if (toMin(pNow.t) <= toMin(cNow.t)) {
    log(`  LISTO: padres ${pNow.t}, ninos ${cNow.t}. El orden ya esta bien.`);
    await notifyUser(P.row as never, 'sniper_done', {
      padres_consular: `${DAY} ${pNow.t}`, padres_cas: `${pNow.cd} ${pNow.ct}`,
      ninos_consular: `${DAY} ${cNow.t}`, ninos_cas: `${cNow.cd} ${cNow.ct}`,
      separacion_min: toMin(cNow.t) - toMin(pNow.t),
    });
    return true;
  }

  const [pTimes, cTimes] = await Promise.all([
    P.client.getConsularTimes(DAY).then((r) => (r.available_times ?? []) as string[]),
    C.client.getConsularTimes(DAY).then((r) => (r.available_times ?? []) as string[]),
  ]);
  log(`  vivo → padres [${pTimes.join(', ') || '-'}] · ninos [${cTimes.join(', ') || '-'}]`);

  const move = pickMove(pNow.t, cNow.t, pTimes, cTimes);
  if (!move) {
    log(`  todavia no: ninguna hora arregla el orden (padres ${pNow.t} despues de ninos ${cNow.t}).`);
    live = null;
    return false;
  }
  const via = move.who === 'PADRES' ? 'A (adelanta padres)' : 'B (atrasa ninos)';
  log(`  plan → via ${via}: ${move.who} ${move.from} → ${move.to}, gap ${move.gapMin} min`);
  live = { move, pNow: pNow.t, cNow: cNow.t, at: Date.now() };

  const cl = move.who === 'PADRES' ? P.client : C.client;
  const casDays = ((await cl.getCasDays(DAY, move.to)) as Array<{ date: string }>)
    .map((d) => d.date).filter((d) => d <= DAY).sort();
  if (!casDays.length) { log(`  todavia no: muro CAS para ${move.who}.`); return false; }
  const casTimes = ((await cl.getCasTimes(casDays[0]!, DAY, move.to)).available_times ?? []) as string[];
  if (!casTimes[0]) { log(`  todavia no: CAS ${casDays[0]} sin horas.`); return false; }
  log(`  CAS ${move.who}: ${casDays[0]} ${casTimes[0]}`);

  if (!COMMIT) { log(`  DRY-RUN. Movería ${move.who} ${move.from} → ${move.to}.`); return false; }
  return commitMove(move, casDays[0]!, casTimes[0]!);
}

async function main() {
  log('═══ ARREGLO DE ORDEN · 2026-09-16 ═══');
  log('  los dos grupos ya estan en el dia. Falta que los padres vayan primero.');
  log(`  via A: adelantar padres a <= la hora de los ninos. Preferida.`);
  log(`  via B: atrasar ninos a >= la hora de los padres. ${ONLY_PARENTS ? 'DESACTIVADA' : 'Activa'}.`);
  log(`  modo: ${COMMIT ? '*** COMMIT (REAL) ***' : 'DRY-RUN'} | ${LOOP ? 'vigila en bucle' : 'un solo intento'}`);
  log(`  sonda CAS: 1 peticion cada minuto, en el segundo ${CAS_TICK_SECOND} UTC.`);

  let tick = 0, full = 0, errors = 0;
  for (;;) {
    await sleepToTick();
    tick += 1;

    let hit: string | null = null;
    try {
      const cas = await casProbe();
      if (cas.length) {
        log(`  [cas] ${live?.move.who} → ${cas.join(', ')}`);
        hit = cas[0]!;
      }
      if (hit) {
        log('  [cas] hay CAS. Ruta rapida.');
        if (await fastFire(hit)) break;
      }
    } catch (e) {
      cache = null;
      log(`  [cas] sonda fallo: ${(e as Error).message}`);
    }

    if (LOOP && !hit && tick !== 1 && tick % FULL_EVERY_TICKS !== 0) continue;

    full += 1;
    log(`─── intento ${full} ─── ${hit ? '(disparado por la sonda CAS)' : `(rutina, tick ${tick})`}`);
    try {
      if (await attempt()) break;
      errors = 0;
    } catch (e) {
      errors += 1;
      cache = null;
      log(`  ERROR (${errors}): ${(e as Error).message}`);
      if (errors >= 5) { log('  5 errores seguidos. Pausa de 30 min.'); await sleep(30 * 60_000); errors = 0; }
    }
    if (!LOOP) break;
    if (new Date().toISOString().slice(0, 10) > DEADLINE) { log(`  DEADLINE ${DEADLINE} superado. Fin.`); break; }
  }
  process.exit(0);
}

main().catch((e) => { log('FATAL:', (e as Error).stack ?? (e as Error).message); process.exit(1); });

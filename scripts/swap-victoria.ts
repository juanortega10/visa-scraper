/**
 * INTERCAMBIO puntual · 2026-09-16 · familia Alvarez / Perez.
 *
 * Situacion: los ninos (bot 140) quedaron el 2026-09-16 10:00. Los padres (bot 141) siguen
 * el 2027-02-24. El dia ofrece 10:15 y 10:30 para los DOS grupos.
 *
 * Plan, en este orden a proposito:
 *   Paso 1 · PADRES  2027-02-24 08:00 → 2026-09-16 10:15   (ganancia grande, 5 meses)
 *   Paso 2 · NINOS   2026-09-16 10:00 → 2026-09-16 10:30   (arregla el orden)
 *
 * Por que los padres primero: son los que estan en 2027. Si el paso 2 falla, quedan los dos
 * en septiembre con el orden invertido (ninos 10:00, padres 10:15), que es mejor que hoy.
 * Si fuera al reves y fallara el paso 2, los padres se quedarian en 2027.
 *
 * El paso 2 mueve a los ninos a una hora MAS TARDE del MISMO dia. Es intencional y sirve
 * solo para dejar a los padres antes. Autorizado por el dueno.
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/swap-victoria.ts            # dry-run
 *   npx tsx --env-file=.env scripts/swap-victoria.ts --commit   # real
 */
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { bots, rescheduleLogs } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { loginWithFallback } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import { notifyUser } from '../src/services/notifications.js';

const DAY = '2026-09-16';
/** Techo de separacion entre la cita de los padres y la de los ninos. */
const GAP_MAX_MIN = 60;
/** Sonda de referencia. Solo se usa para preguntar CAS, no para agendar. */
const PROBE_TIME = '10:30';
const COMMIT = process.argv.includes('--commit');
const LOOP = process.argv.includes('--loop');
/** Ensayo de la ruta rapida: la fuerza una vez con fechas CAS de mentira. */
const TEST_FAST = process.argv.includes('--test-fast');
/** 5 min. La cuenta viene de un bloqueo por polling sostenido; no se baja de aqui. */
const INTERVAL_MS = 5 * 60_000;
const CAS_TICK_SECOND = 14;      // el portal libera en rafaga 1x/min, borde en el segundo 14-15 UTC
const FULL_EVERY_TICKS = 5;      // verificacion completa cada 5 ticks = cada 5 min, como antes
const CLIENT_TTL_MS = 40 * 60_000;   // la sesion dura ~1h28m; renovamos antes
const DEADLINE = '2026-09-15';   // el dia antes de la cita; despues no tiene sentido

const log = (...p: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}Z]`, ...p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function pickCas(client: VisaClient, time: string) {
  const days = await client.getCasDays(DAY, time);
  if (days.length === 0) return null;
  const dates = days.map((d) => d.date).filter((d) => d <= DAY).sort().reverse();
  for (const date of dates.slice(0, 3)) {
    const times = (await client.getCasTimes(date, DAY, time)).available_times ?? [];
    if (times.length > 0) return { date, time: times[0]! };
  }
  return null;
}


// ── Plan dinamico de horas ────────────────────────────────────────────────
// Las horas del portal desaparecen. Elegimos el par de la lista viva en cada
// vuelta, en vez de fijar una hora en una constante.

interface Plan { pTime: string; cTime: string; gapMin: number }

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Mejor par (padres, ninos) del dia: padres estrictamente antes, gap dentro del
 * techo. Ordena por gap y luego por la hora mas temprana para los padres.
 */
function pickPlan(pTimes: string[], cTimes: string[]): Plan | null {
  const out: Plan[] = [];
  for (const pTime of pTimes) {
    for (const cTime of cTimes) {
      const gapMin = toMin(cTime) - toMin(pTime);
      if (gapMin > 0 && gapMin <= GAP_MAX_MIN) out.push({ pTime, cTime, gapMin });
    }
  }
  out.sort((a, b) => a.gapMin - b.gapMin || toMin(a.pTime) - toMin(b.pTime));
  return out[0] ?? null;
}

/** Ultimo estado bueno leido por una verificacion completa. Lo usa la ruta rapida. */
let live: { plan: Plan; pDate: string; cDate: string; at: number } | null = null;

// ── Sonda CAS ligera ──────────────────────────────────────────────────────
// Una peticion por grupo, una vez por minuto. Reusa la sesion para no
// disparar un login cada minuto.
let cache: { P: Awaited<ReturnType<typeof open>>; C: Awaited<ReturnType<typeof open>>; at: number } | null = null;

async function clients(force = false) {
  if (force || !cache || Date.now() - cache.at > CLIENT_TTL_MS) {
    const [P, C] = await Promise.all([open(141), open(140)]);
    // Los tokens se preparan aqui, no en el disparo. El POST necesita
    // authenticity_token y pedirlo en caliente cuesta ~2 s que no tenemos.
    await Promise.all([P.client.refreshTokens(), C.client.refreshTokens()]);
    cache = { P, C, at: Date.now() };
  }
  return cache;
}

/** Devuelve las fechas CAS <= DAY que ve cada grupo. Sin efectos secundarios. */
async function casProbe(): Promise<{ padres: string[]; ninos: string[] }> {
  const { P, C } = await clients();
  const [p, c] = await Promise.all([
    P.client.getCasDays(DAY, live?.plan.pTime ?? PROBE_TIME),
    C.client.getCasDays(DAY, live?.plan.cTime ?? PROBE_TIME),
  ]);
  const keep = (rows: Array<{ date: string }>) => rows.map((r) => r.date).filter((d) => d <= DAY).sort();
  return { padres: keep(p as Array<{ date: string }>), ninos: keep(c as Array<{ date: string }>) };
}

/** Duerme hasta el proximo segundo `CAS_TICK_SECOND` del reloj UTC. */
function sleepToTick(): Promise<void> {
  const now = new Date();
  const target = new Date(now);
  target.setUTCSeconds(CAS_TICK_SECOND, 0);
  if (target.getTime() <= now.getTime()) target.setUTCMinutes(target.getUTCMinutes() + 1);
  return sleep(target.getTime() - now.getTime());
}


/**
 * Ruta rapida. La sonda ya vio CAS en los dos grupos. Aqui solo pedimos la hora
 * CAS y posteamos. Sin login, sin releer citas, sin releer horas consulares.
 * El cupo CAS del 2026-09-11 duro 22 s; la ruta larga gastaba 19 s.
 */
async function fastFire(casP: string, casC: string): Promise<boolean> {
  if (!live) { log('  [rapido] sin plan fresco. Cae a la ruta larga.'); return false; }
  if (Date.now() - live.at > 10 * 60_000) { log('  [rapido] plan viejo. Cae a la ruta larga.'); return false; }

  const { plan, pDate, cDate } = live;
  // Guardas duras. La regla critica manda: nunca a una fecha igual o posterior.
  if (!(pDate > DAY)) { log(`  [rapido] ABORTA: padres en ${pDate}, no es posterior a ${DAY}.`); return false; }
  if (cDate !== DAY) { log(`  [rapido] ABORTA: ninos en ${cDate}, ya no en ${DAY}.`); return false; }
  if (toMin(plan.pTime) >= toMin(plan.cTime)) { log('  [rapido] ABORTA: el orden del plan no sirve.'); return false; }

  const { P, C } = await clients();
  const [pt, ct] = await Promise.all([
    P.client.getCasTimes(casP, DAY, plan.pTime),
    C.client.getCasTimes(casC, DAY, plan.cTime),
  ]);
  const pTime = (pt.available_times ?? [])[0];
  const cTime = (ct.available_times ?? [])[0];
  if (!pTime || !cTime) { log(`  [rapido] la CAS se fue antes de la hora (padres ${casP}=${pTime ?? '-'}, ninos ${casC}=${cTime ?? '-'}).`); return false; }

  if (!COMMIT) { log(`  [rapido] DRY-RUN. Postearia padres ${DAY} ${plan.pTime} CAS ${casP} ${pTime} y ninos ${DAY} ${plan.cTime} CAS ${casC} ${cTime}.`); return false; }

  log(`  [rapido] POST padres → ${DAY} ${plan.pTime} | CAS ${casP} ${pTime}`);
  let pClaimed = false;
  try { pClaimed = await P.client.reschedule(DAY, plan.pTime, casP, pTime); }
  catch (e) { log(`  [rapido] POST padres error: ${(e as Error).message}`); }

  let cClaimed = false;
  if (pClaimed) {
    log(`  [rapido] POST ninos → ${DAY} ${plan.cTime} | CAS ${casC} ${cTime}`);
    try { cClaimed = await C.client.reschedule(DAY, plan.cTime, casC, cTime); }
    catch (e) { log(`  [rapido] POST ninos error: ${(e as Error).message}`); }
  } else {
    log('  [rapido] el portal no confirmo a los padres. No se toca a los ninos.');
  }

  await sleep(2500);
  const [pAfter, cAfter] = await Promise.all([currentAppt(P.client), currentAppt(C.client)]);
  const pOk = pAfter?.d === DAY && pAfter?.t === plan.pTime;
  const cOk = cAfter?.d === DAY && cAfter?.t === plan.cTime;
  log(`  [rapido] PADRES ahora: ${pAfter?.d} ${pAfter?.t} → ${pOk ? 'OK' : 'NO COINCIDE'}`);
  log(`  [rapido] NINOS  ahora: ${cAfter?.d} ${cAfter?.t} → ${cOk ? 'OK' : 'NO COINCIDE'}`);

  for (const [g, after, ok, claimed, target, casDate, casTime, oldDate] of [
    [P, pAfter, pOk, pClaimed, plan.pTime, casP, pTime, pDate],
    [C, cAfter, cOk, cClaimed, plan.cTime, casC, cTime, cDate],
  ] as const) {
    await db.insert(rescheduleLogs).values({
      botId: g.row.id,
      oldConsularDate: oldDate, oldConsularTime: null,
      newConsularDate: ok ? DAY : null, newConsularTime: ok ? target : null,
      newCasDate: ok ? casDate : null, newCasTime: ok ? casTime : null,
      success: ok, provider: g.row.proxyProvider,
      failStep: ok ? null : 'fast_verify',
      error: ok ? null : `[swap_rapido] claimed=${claimed} target=${DAY} ${target} actual=${after?.d} ${after?.t}`,
      detail: { source: 'swap-victoria/rapido', claimed },
    });
    if (ok && after) {
      await db.update(bots).set({
        currentConsularDate: after.d, currentConsularTime: after.t,
        currentCasDate: after.cd, currentCasTime: after.ct,
        rescheduleCount: (g.row.rescheduleCount ?? 0) + 1,
      }).where(eq(bots.id, g.row.id));
    }
  }

  if (pOk && cOk) {
    log('  [rapido] RESULTADO: las dos citas quedaron el mismo dia, padres primero.');
    await notifyUser(P.row as never, 'sniper_done', {
      padres_consular: `${DAY} ${plan.pTime}`, padres_cas: `${casP} ${pTime}`,
      ninos_consular: `${DAY} ${plan.cTime}`, ninos_cas: `${casC} ${cTime}`,
      separacion_min: plan.gapMin,
    });
    return true;
  }
  if (pOk && !cOk) {
    log('  [rapido] RESULTADO PARCIAL: padres en septiembre. Los ninos siguen donde estaban.');
    await notifyUser(C.row as never, 'sniper_split', {
      grupo_movido: 'PADRES', quedo_en: `${DAY} ${plan.pTime}`,
      grupo_pendiente: 'NINOS', nota: `Los ninos siguen en ${cAfter?.d} ${cAfter?.t}.`,
    });
    return true;
  }
  log('  [rapido] no se movio nada. Sigue la vigilancia.');
  cache = null;   // el POST fallido pudo ensuciar los tokens
  return false;
}

/** Un intento completo. Devuelve `true` si ya no hay nada mas que hacer. */
async function attempt(): Promise<boolean> {
  const P = await open(141);
  const C = await open(140);

  const pNow = await currentAppt(P.client);
  const cNow = await currentAppt(C.client);
  log(`  PADRES hoy: ${pNow?.d} ${pNow?.t} | CAS ${pNow?.cd} ${pNow?.ct}`);
  log(`  NINOS  hoy: ${cNow?.d} ${cNow?.t} | CAS ${cNow?.cd} ${cNow?.ct}`);

  // ── Verificadores ──
  const fails: string[] = [];
  if (!pNow || !cNow) fails.push('no se pudo leer una de las citas');
  if (pNow && pNow.d <= DAY && pNow.d !== DAY) fails.push(`V5 padres ${pNow.d} ya es anterior o igual a ${DAY}`);
  if (cNow && cNow.d !== DAY) fails.push(`los ninos ya no estan en ${DAY} (estan en ${cNow.d}); el plan no aplica`);

  const pTimes = ((await P.client.getConsularTimes(DAY)).available_times ?? []) as string[];
  const cTimes = ((await C.client.getConsularTimes(DAY)).available_times ?? []) as string[];
  log(`  vivo → padres [${pTimes.join(', ')}] · ninos [${cTimes.join(', ')}]`);

  const plan = pickPlan(pTimes, cTimes);
  if (!plan) {
    fails.push(`sin par valido en ${DAY} (padres antes que ninos, gap <= ${GAP_MAX_MIN} min)`);
  } else {
    log(`  plan → padres ${plan.pTime} · ninos ${plan.cTime} (gap ${plan.gapMin} min)`);
    if (pNow && cNow) live = { plan, pDate: pNow.d, cDate: cNow.d, at: Date.now() };
  }
  if (fails.length > 0 || !plan) {
    log(`  todavia no: ${fails.join(' | ') || 'sin plan'}`);
    return false;
  }
  const PARENTS_TARGET = plan.pTime;
  const CHILDREN_TARGET = plan.cTime;

  const pCas = await pickCas(P.client, PARENTS_TARGET);
  const cCas = await pickCas(C.client, CHILDREN_TARGET);
  log(`  CAS padres: ${pCas ? `${pCas.date} ${pCas.time}` : 'NINGUNA'}`);
  log(`  CAS ninos:  ${cCas ? `${cCas.date} ${cCas.time}` : 'NINGUNA'}`);
  if (!pCas) fails.push('muro CAS para los padres');
  if (!cCas) fails.push('muro CAS para los ninos');

  if (fails.length > 0) {
    log(`  todavia no: ${fails.join(' | ')}`);
    return false;
  }
  log('  verificadores: OK');

  if (!COMMIT) {
    log('  DRY-RUN. Con --commit haria los 2 movimientos.');
    return true;
  }

  // ── Tokens de los dos ANTES de tocar nada ──
  await Promise.all([P.client.refreshTokens(), C.client.refreshTokens()]);
  log('  tokens listos');

  // ── Paso 1: PADRES ──
  log(`  [PADRES] POST → ${DAY} ${PARENTS_TARGET} | CAS ${pCas.date} ${pCas.time}`);
  let pClaimed = false;
  try { pClaimed = await P.client.reschedule(DAY, PARENTS_TARGET, pCas.date, pCas.time); }
  catch (e) { log(`  [PADRES] POST error: ${(e as Error).message}`); }

  // ── Paso 2: NINOS, pegado ──
  let cClaimed = false;
  if (pClaimed) {
    log(`  [NINOS] POST → ${DAY} ${CHILDREN_TARGET} | CAS ${cCas.date} ${cCas.time}`);
    try { cClaimed = await C.client.reschedule(DAY, CHILDREN_TARGET, cCas.date, cCas.time); }
    catch (e) { log(`  [NINOS] POST error: ${(e as Error).message}`); }
  } else {
    log('  [PADRES] el portal no confirmo. No se toca a los ninos.');
  }

  // ── Verificacion real ──
  await sleep(2500);
  const pAfter = await currentAppt(P.client);
  const cAfter = await currentAppt(C.client);
  const pOk = pAfter?.d === DAY && pAfter?.t === PARENTS_TARGET;
  const cOk = cAfter?.d === DAY && cAfter?.t === CHILDREN_TARGET;
  log(`  PADRES ahora: ${pAfter?.d} ${pAfter?.t} | CAS ${pAfter?.cd} ${pAfter?.ct} → ${pOk ? 'OK' : 'NO COINCIDE'}`);
  log(`  NINOS  ahora: ${cAfter?.d} ${cAfter?.t} | CAS ${cAfter?.cd} ${cAfter?.ct} → ${cOk ? 'OK' : 'NO COINCIDE'}`);

  for (const [g, before, after, ok, claimed, target, cas] of [
    [P, pNow, pAfter, pOk, pClaimed, PARENTS_TARGET, pCas],
    [C, cNow, cAfter, cOk, cClaimed, CHILDREN_TARGET, cCas],
  ] as const) {
    await db.insert(rescheduleLogs).values({
      botId: g.row.id,
      oldConsularDate: before!.d, oldConsularTime: before!.t,
      oldCasDate: before!.cd, oldCasTime: before!.ct,
      newConsularDate: ok ? DAY : null, newConsularTime: ok ? target : null,
      newCasDate: ok ? cas.date : null, newCasTime: ok ? cas.time : null,
      success: ok, provider: g.row.proxyProvider,
      failStep: ok ? null : 'swap_verify',
      error: ok ? null : `[swap] claimed=${claimed} target=${DAY} ${target} actual=${after?.d} ${after?.t}`,
      detail: { source: 'swap-victoria', claimed },
    });
    if (ok && after) {
      await db.update(bots).set({
        currentConsularDate: after.d, currentConsularTime: after.t,
        currentCasDate: after.cd, currentCasTime: after.ct,
        rescheduleCount: (g.row.rescheduleCount ?? 0) + 1,
      }).where(eq(bots.id, g.row.id));
    }
  }

  if (pOk && cOk) {
    log('  RESULTADO: las dos citas quedaron el mismo dia, padres 15 min antes.');
    await notifyUser(P.row as never, 'sniper_done', {
      padres_consular: `${DAY} ${PARENTS_TARGET}`, padres_cas: `${pCas.date} ${pCas.time}`,
      ninos_consular: `${DAY} ${CHILDREN_TARGET}`, ninos_cas: `${cCas.date} ${cCas.time}`,
      separacion_min: 15,
    });
  } else if (pOk && !cOk) {
    log('  RESULTADO PARCIAL: padres en septiembre. Los ninos siguen en su hora anterior.');
    await notifyUser(C.row as never, 'sniper_split', {
      grupo_movido: 'PADRES', quedo_en: `${DAY} ${PARENTS_TARGET}`,
      grupo_pendiente: 'NINOS', nota: `Los ninos siguen en ${cAfter?.d} ${cAfter?.t}. Orden invertido.`,
    });
  } else {
    log('  RESULTADO: no se movio nada. Las citas quedan como estaban.');
    return false;   // se reintenta en el proximo ciclo
  }
  return true;
}

async function main() {
  log('═══ INTERCAMBIO 2026-09-16 ═══');
  log(`  paso 1: PADRES → ${DAY}, la hora mas temprana que quede`);
  log(`  paso 2: NINOS  → ${DAY}, la siguiente hora, gap <= ${GAP_MAX_MIN} min`);
  log(`  modo: ${COMMIT ? '*** COMMIT (REAL) ***' : 'DRY-RUN'} | ${LOOP ? 'vigila en bucle' : 'un solo intento'}`);
  log(`  sonda CAS: 1 peticion por grupo cada minuto, en el segundo ${CAS_TICK_SECOND} UTC.`);
  log(`  verificacion completa: cuando la sonda ve CAS en los dos, o cada ${FULL_EVERY_TICKS} min.`);
  log('  bloqueador actual: muro CAS. Es estructural: septiembre 2026 no tiene cupos CAS.');

  let tick = 0, full = 0, errors = 0;
  for (;;) {
    await sleepToTick();
    tick += 1;

    // ── sonda CAS: 1 peticion por grupo, cada minuto ──
    let hit = false;
    try {
      const cas = TEST_FAST && tick === 2
        ? { padres: ['2026-09-11'], ninos: ['2026-09-11'] }
        : await casProbe();
      if (TEST_FAST && tick === 2) log('  [ensayo] simulo CAS 2026-09-11 en los dos grupos');
      hit = cas.padres.length > 0 && cas.ninos.length > 0;
      if (cas.padres.length || cas.ninos.length) {
        log(`  [cas] padres ${cas.padres.join(', ') || 'NINGUNA'} | ninos ${cas.ninos.join(', ') || 'NINGUNA'}`);
      }
      if (hit) {
        // Sin esperar nada mas. El cupo dura ~20 s.
        log('  [cas] CAS en los DOS grupos. Ruta rapida.');
        if (await fastFire(cas.padres[0]!, cas.ninos[0]!)) break;
      }
    } catch (e) {
      cache = null;   // sesion sospechosa: fuerza login en la proxima sonda
      log(`  [cas] sonda fallo: ${(e as Error).message}`);
    }

    // ── intento completo: cuando la sonda ve CAS en los DOS, o cada 5 ticks ──
    if (LOOP && !hit && tick !== 1 && tick % FULL_EVERY_TICKS !== 0) continue;

    full += 1;
    log(`─── intento ${full} ─── ${hit ? '(disparado por la sonda CAS)' : `(rutina, tick ${tick})`}`);
    try {
      if (await attempt()) break;
      errors = 0;
    } catch (e) {
      errors += 1;
      log(`  ERROR (${errors}): ${(e as Error).message}`);
      if (errors >= 5) { log('  5 errores seguidos. Pausa de 30 min.'); await sleep(30 * 60_000); errors = 0; }
    }
    if (!LOOP) break;
    if (new Date().toISOString().slice(0, 10) > DEADLINE) { log(`  DEADLINE ${DEADLINE} superado. Fin.`); break; }
  }
  process.exit(0);
}

main().catch((e) => { log('FATAL:', (e as Error).stack ?? (e as Error).message); process.exit(1); });

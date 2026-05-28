/**
 * Bot 77 — Sniper de fechas específicas
 *
 * Criterios:
 *   - CAS:      > 2026-04-15 (abril 16 en adelante) Y antes del consular
 *   - Consular: en abril 2026 (cualquier fecha de 2026-04-01 a 2026-04-30)
 *
 * Corre indefinidamente, 2 veces por minuto (cada 30s).
 * Refresca tokens cada 40 min para evitar expirar la sesión.
 *
 * ADVERTENCIA CRÍTICA: sin --commit es dry-run. Con --commit ejecuta el
 * reschedule real. Una vez agendado el nuevo slot, el actual se pierde.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/_bot77-sniper.ts           # dry-run
 *   npx tsx --env-file=.env scripts/_bot77-sniper.ts --commit  # REAL
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '../src/services/encryption.js';
import { VisaClient, SessionExpiredError } from '../src/services/visa-client.js';
import { loginWithFallback } from '../src/services/login.js';
import type { ProxyProvider } from '../src/services/proxy-fetch.js';

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_ID = 77;
const INTERVAL_MS = 30_000;              // 2 polls/min
const TOKEN_REFRESH_INTERVAL_MS = 40 * 60 * 1000;  // refrescar tokens c/40min

const CONSULAR_MONTH_START = '2026-04-01';
const CONSULAR_MONTH_END   = '2026-04-30';
const CAS_MIN_DATE         = '2026-04-15'; // CAS debe ser ESTRICTAMENTE mayor

const IS_COMMIT = process.argv.includes('--commit');

// ── Utils ─────────────────────────────────────────────────────────────────────
function ts(): string {
  // Timestamp en UTC-5 (Bogota)
  const now = new Date();
  const bog = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  return bog.toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg: string) {
  console.log(`[${ts()}] ${msg}`);
}

function sep(char = '─', n = 70) {
  console.log(char.repeat(n));
}

function inApril(date: string): boolean {
  return date >= CONSULAR_MONTH_START && date <= CONSULAR_MONTH_END;
}

function casIsValid(casDate: string, consularDate: string): boolean {
  return casDate > CAS_MIN_DATE && casDate < consularDate;
}

// ── Init ──────────────────────────────────────────────────────────────────────
sep('=');
console.log('  BOT 77 — SNIPER DE FECHAS ESPECÍFICAS');
sep('=');
console.log(`  Modo:      ${IS_COMMIT ? '⚠️  REAL (--commit)' : '🛡️  DRY-RUN (sin --commit)'}`);
console.log(`  Consular:  abril 2026 (${CONSULAR_MONTH_START} → ${CONSULAR_MONTH_END})`);
console.log(`  CAS:       > ${CAS_MIN_DATE} y antes del consular`);
console.log(`  Intervalo: ${INTERVAL_MS / 1000}s (${60000 / INTERVAL_MS} polls/min)`);
sep('=');
console.log();

const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!bot) { console.error(`Bot ${BOT_ID} no encontrado`); process.exit(1); }

const [session] = await db.select().from(sessions).where(eq(sessions.botId, BOT_ID));
if (!session) {
  console.error(`Sin sesión para bot ${BOT_ID}. Ejecuta: npm run login -- --bot-id=${BOT_ID}`);
  process.exit(1);
}

log(`Estado actual — Consular: ${bot.currentConsularDate} ${bot.currentConsularTime ?? ''}`);
log(`               CAS:       ${bot.currentCasDate} ${bot.currentCasTime ?? ''}`);
log(`               Proxy:     ${bot.proxyProvider}`);
console.log();

const cookie = decrypt(session.yatriCookie);
const client = new VisaClient(
  {
    cookie,
    csrfToken:           session.csrfToken        ?? '',
    authenticityToken:   session.authenticityToken ?? '',
  },
  {
    scheduleId:         bot.scheduleId,
    applicantIds:       bot.applicantIds,
    consularFacilityId: bot.consularFacilityId,
    ascFacilityId:      bot.ascFacilityId,
    proxyProvider:      (bot.proxyProvider ?? 'direct') as ProxyProvider,
    userId:             bot.userId,
    locale:             bot.locale,
  },
);

// ── Re-login automático ───────────────────────────────────────────────────────
async function relogin(): Promise<boolean> {
  log(`🔐 Sesión expirada — ejecutando re-login...`);
  try {
    const creds = {
      email:        decrypt(bot.visaEmail),
      password:     decrypt(bot.visaPassword),
      scheduleId:   bot.scheduleId,
      applicantIds: bot.applicantIds,
      locale:       bot.locale,
    };
    const { result, via } = await loginWithFallback(creds);
    log(`   ✓ Re-login via ${via}`);
    client.updateSession({
      cookie:             result.cookie,
      csrfToken:          result.csrfToken,
      authenticityToken:  result.authenticityToken ?? '',
    });
    // Persistir en DB para que otros procesos también tengan la sesión fresca
    await db.update(sessions).set({
      yatriCookie:        encrypt(result.cookie),
      csrfToken:          result.csrfToken,
      authenticityToken:  result.authenticityToken ?? '',
      updatedAt:          new Date(),
    }).where(eq(sessions.botId, BOT_ID));
    return true;
  } catch (e) {
    log(`   ✗ Re-login falló: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ── Loop ──────────────────────────────────────────────────────────────────────
let pollCount = 0;
let lastTokenRefreshMs = 0;

async function poll(): Promise<boolean /* true = agendado, salir */> {
  pollCount++;
  const iterStart = Date.now();

  // Refrescar tokens periódicamente
  const needsRefresh = (Date.now() - lastTokenRefreshMs) > TOKEN_REFRESH_INTERVAL_MS;
  if (lastTokenRefreshMs === 0 || needsRefresh) {
    log(`🔑 Refrescando tokens... (${lastTokenRefreshMs === 0 ? 'inicio' : 'c/40min'})`);
    try {
      await client.refreshTokens();
      lastTokenRefreshMs = Date.now();
      log(`   ✓ Tokens OK`);
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        const ok = await relogin();
        if (ok) { lastTokenRefreshMs = Date.now(); }
        else { log(`   ⚠️  Re-login falló. Reintentando en próximo ciclo.`); }
        return false;
      } else {
        // Error de red (fetch failed, webshare bloqueado) — continuar con tokens existentes,
        // reintentar refresh en 5 min en lugar de cada 30s
        log(`   ⚠️  Red caída (${e instanceof Error ? e.message : String(e)}) — usando tokens existentes, reintento refresh en 5min`);
        lastTokenRefreshMs = Date.now() - TOKEN_REFRESH_INTERVAL_MS + 5 * 60 * 1000;
        // no return false — seguir intentando el poll
      }
    }
  }

  // ── Paso 1: días consulares ───────────────────────────────────────────────
  let consularDays: Array<{ date: string; business_day: boolean }>;
  try {
    consularDays = await client.getConsularDays();
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      log(`#${pollCount} | Sesión expirada en getConsularDays — re-login automático`);
      const ok = await relogin();
      if (ok) lastTokenRefreshMs = Date.now();
    } else {
      log(`#${pollCount} | ERROR getConsularDays: ${e instanceof Error ? e.message : String(e)}`);
    }
    return false;
  }

  const aprilDays = consularDays.filter(d => inApril(d.date));
  const fetchMs = Date.now() - iterStart;

  if (aprilDays.length === 0) {
    log(`#${pollCount} | ${fetchMs}ms | Total días: ${consularDays.length} | ❌ Sin días en abril`);
    if (consularDays.length > 0) {
      log(`   Próximos disponibles: ${consularDays.slice(0, 5).map(d => d.date).join(', ')}`);
    }
    return false;
  }

  log(`#${pollCount} | ${fetchMs}ms | Total días: ${consularDays.length} | ✅ Abril: ${aprilDays.length} días → ${aprilDays.map(d => d.date).join(', ')}`);

  // ── Paso 2: para cada día de abril, buscar combo válido ──────────────────
  for (const consularDay of aprilDays) {
    const cDate = consularDay.date;

    // Obtener horarios consulares
    let consularTimes: string[];
    try {
      const td = await client.getConsularTimes(cDate);
      consularTimes = td.available_times;
    } catch (e) {
      log(`   [${cDate}] ERROR getConsularTimes: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (consularTimes.length === 0) {
      log(`   [${cDate}] Sin horarios consulares`);
      continue;
    }

    log(`   [${cDate}] Horarios consulares: ${consularTimes.join(', ')}`);

    // Intentar con cada horario consular hasta encontrar CAS válido
    for (const cTime of consularTimes) {

      // Obtener días CAS
      let casDays: Array<{ date: string; business_day: boolean }>;
      try {
        casDays = await client.getCasDays(cDate, cTime);
      } catch (e) {
        log(`   [${cDate} ${cTime}] ERROR getCasDays: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      // Filtrar CAS: > 15 abril Y antes del consular
      const validCasDays = casDays.filter(d => casIsValid(d.date, cDate));

      log(`   [${cDate} ${cTime}] CAS total: ${casDays.length} | válidos (>${CAS_MIN_DATE} y <${cDate}): ${validCasDays.length}${validCasDays.length > 0 ? ' → ' + validCasDays.map(d => d.date).join(', ') : ''}`);

      if (validCasDays.length === 0) continue;

      // Obtener horarios CAS para el primer día válido
      const casDate = validCasDays[0]!.date;
      let casTimes: string[];
      try {
        const ctd = await client.getCasTimes(casDate, cDate, cTime);
        casTimes = ctd.available_times;
      } catch (e) {
        log(`   [CAS ${casDate}] ERROR getCasTimes: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      if (casTimes.length === 0) {
        log(`   [CAS ${casDate}] Sin horarios CAS disponibles`);
        continue;
      }

      const casTime = casTimes[0]!;

      // ──── COMBO VÁLIDO ENCONTRADO ────
      sep('█');
      console.log('  🎯 COMBO VÁLIDO ENCONTRADO');
      sep('█');
      console.log(`  Consular: ${cDate} ${cTime}`);
      console.log(`  CAS:      ${casDate} ${casTime}`);
      console.log();
      console.log(`  Estado actual:`);
      console.log(`    Consular: ${bot.currentConsularDate} ${bot.currentConsularTime ?? ''}`);
      console.log(`    CAS:      ${bot.currentCasDate} ${bot.currentCasTime ?? ''}`);
      sep('█');

      if (!IS_COMMIT) {
        log(`🛡️  DRY-RUN — no se ejecuta. Agrega --commit para agendar.`);
        return false; // Continúa buscando en próximas iteraciones
      }

      // ── Ejecutar reschedule ────────────────────────────────────────────────
      log(`⚡ Ejecutando reschedule...`);
      try {
        const ok = await client.reschedule(cDate, cTime, casDate, casTime);
        if (ok) {
          sep('█');
          console.log('  ✅ ¡AGENDADO EXITOSAMENTE!');
          sep('█');
          console.log(`  Consular: ${cDate} ${cTime}`);
          console.log(`  CAS:      ${casDate} ${casTime}`);
          sep('█');
          log(`Total polls: ${pollCount}`);
          return true; // Salir del loop
        } else {
          log(`❌ Reschedule retornó false. Slot posiblemente tomado. Continuando...`);
        }
      } catch (e) {
        log(`❌ ERROR en reschedule: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return false;
}

// ── Main loop ─────────────────────────────────────────────────────────────────
while (true) {
  const iterStart = Date.now();

  let done = false;
  try {
    done = await poll();
  } catch (e) {
    log(`ERROR inesperado: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (done) {
    process.exit(0);
  }

  // Esperar hasta la próxima iteración (start-to-start)
  const elapsed = Date.now() - iterStart;
  const sleepMs = Math.max(0, INTERVAL_MS - elapsed);
  if (sleepMs > 0) {
    await new Promise(r => setTimeout(r, sleepMs));
  }
}

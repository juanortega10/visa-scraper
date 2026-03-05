# Visa Bot

API multi-tenant para monitorear y reagendar citas de visa B1/B2 en embajadas de EEUU via `ais.usvisa-info.com`.

> **El código es la fuente de verdad.** Este doc solo cubre reglas, gotchas y referencias a dónde vive cada comportamiento. No duplica lógica que puede leerse directamente del código.

## Preferencias del usuario

- **Reportar horas en UTC-5 (Bogota)**, no UTC.
- **Bot 6: `proxyProvider: 'direct'`** — sin Bright Data. No asumir sin verificar con `GET /api/bots/6`.

## REGLA CRITICA: Reschedule

**NUNCA mover una cita a fecha igual o posterior a la actual.** El slot original se pierde permanentemente.
- Scripts: bloquear `--commit` si la fecha propuesta no es estrictamente anterior.
- Claude Code: verificar siempre antes de ejecutar `--commit` o `client.reschedule()`.
- El bot en producción tiene protección (`isAtLeastNDaysEarlier` en `poll-visa.ts` y `reschedule-logic.ts`). Scripts manuales NO la tienen.

## REGLA CRITICA: Scripts deben respetar limitaciones del bot

Antes de cualquier script que interactúe con visa: `GET /api/bots/:id` para leer estado actual.

1. **`maxReschedules`**: verificar `rescheduleCount < maxReschedules` antes del POST.
2. **`targetDateBefore`**: solo fechas estrictamente anteriores.
3. **Fecha propuesta < `currentConsularDate`**: siempre.
4. **`excluded_dates`**: respetar rangos.
5. **Peru (`es-pe`)**: límite de 2 reprogramaciones, **bloqueo irreversible**. NO usar `--commit` en pruebas.
6. **Dry-run por defecto**: sin `--commit` explícito, mostrar qué pasaría sin ejecutar.

## Testing

- Vitest: `npm test` | `npm run test:watch`
- **REGLA**: correr `npm test` después de cualquier cambio en tasks/servicios/API. Arreglar antes de continuar.
- Tests en `src/services/__tests__/` y `src/api/bots-me.test.ts`.

## Reglas Trigger.dev MCP

- **NUNCA `wait_for_run_to_complete`** — bloquea indefinidamente si el run queda en DEQUEUED.
- **Patrón correcto**: `trigger_task` → `sleep 5s` → `get_run_details` → si DEQUEUED/QUEUED >15s → reportar stuck.

## Stack

Node.js ESM/TS | Hono API | Trigger.dev v4 | Neon PostgreSQL + Drizzle | AES-256-GCM
Login: pure fetch (~970ms skipTokens, ~1.7s full). Polling: Node fetch via direct/brightdata/firecrawl.

## Ejecución

```bash
npm run dev && npm run trigger:dev          # API + worker local
npm run deploy:rpi                          # Sync + restart RPi
npm run deploy:rpi:full                     # + npm install (si cambió package.json)
npm run login -- --bot-id=6                # Login manual
npm run test-reschedule -- --bot-id=5      # Dry-run reschedule
npm run test-reschedule -- --bot-id=5 --commit  # REAL reschedule
npm run db:push && npm run db:studio       # DB
```

## Arquitectura — referencias al código

**Flujo principal**: `poll-cron.ts` → `poll-visa.ts` (fetch → reschedule inline → self-trigger).
**Login**: `login.ts:pureFetchLogin()`. Recovery: `performLogin()` inline → `login-visa` task (last resort).
**Reschedule**: `reschedule-logic.ts:executeReschedule()` — compartido por poll-visa y reschedule-visa.
**Rate/schedule**: `scheduling.ts` — `LOCALE_POLL_INTERVALS`, `getPollingDelay()`, `getCurrentPhase()`, drop schedule por locale.
**Proxies**: `proxy-fetch.ts` — ProxyPoolManager (webshare circuit breaker + recency penalty 8s), direct, brightdata, firecrawl.

### Rate — puntos no obvios (fuente: `poll-visa.ts`)

- **1 poll/run** (l.933): `if (cronTriggered) break` — todos los runs normales son cron-triggered. Batch loop de 90s solo para legacy chains.
- **Sub-minute chaining** (l.381): `subMinutePolling = getNormalInterval(locale) < 60` → fuerza `shouldChain=true` aunque sea cronTriggered. es-pe (9s) siempre encadena.
- **Delay de self-trigger** (l.1185, 1207-1210): el `else` final usa `delay = normalDelay` = `getPollingDelay(bot.locale, healthyIps)`. Si ves un valor hardcoded en ese `else`, es un bug (antes de v20260303.9 era `'2s'`).
- **TCP backoff direct** (l.1197-1204): `sustainedTcpBlockCount` 0-2→normalDelay, 3-4→10m, 5+→30m. Count = últimos 5 `poll_logs` en DB incluyendo el bloque actual (l.1093-1100).
- **shouldChain** (l.1171-1176): `!cronTriggered || subMinutePolling || superCritical || burst || hadTransientError || botJustErrored`.

### Cron + chain híbrido

- Normal: cron cada 2min (cloud min par, dev min impar). `cronTriggered: true` → 1 poll → exit → cron retoma.
- Sub-minute / burst / super-critical: self-trigger con delay de `scheduling.ts`.
- `pollEnvironments`: `['dev']`=RPi only, `['prod']`=cloud only, `['dev','prod']`=dual.
- Cron-only sin chain: `npx tsx --env-file=.env scripts/set-bot-active.ts <botId>`.
- Drop schedule y fases horarias: ver `scheduling.ts:DROP_SCHEDULES` y `getCurrentPhase()`.

## Estructura del proyecto

```
src/trigger/   poll-visa.ts, poll-cron.ts, login-visa.ts, reschedule-visa.ts,
               prefetch-cas.ts, ensure-chain.ts, notify-user.ts, queues.ts
src/services/  visa-client.ts, login.ts, proxy-fetch.ts, reschedule-logic.ts,
               scheduling.ts, notifications.ts
src/api/       bots.ts, dashboard.ts, logs.ts, dev.ts
src/db/        schema.ts, client.ts, migrations/
scripts/       login, activate-bot, set-bot-status/provider/active, test-fetch,
               test-reschedule-e2e, deploy-rpi.sh, monitor.ts
```

## Tablas DB

| Tabla | Propósito |
|-------|-----------|
| `bots` | Config: creds (encrypted), schedule_id, locale, status, proxyProvider, userId, casCacheJson, targetDateBefore, maxReschedules/rescheduleCount, pollEnvironments. Columnas `isScout`/`isSubscriber` existen en schema pero son **legacy** — ya no se leen ni escriben (arquitectura scout/subscriber eliminada v20260303.14). |
| `sessions` | Cookie encriptada + tokens CSRF |
| `poll_logs` | Polls: earliest_date, status, responseTimeMs, dateChanges, topDates, connectionInfo |
| `reschedule_logs` | Old/new dates+times, success, dispatchLogId |
| `dispatch_logs` | Histórica — ya no se escribe. Existe para no perder datos de runs pasados. |
| `excluded_dates/times` | Rangos a saltar por bot |
| `cas_prefetch_logs` | Prefetch CAS |
| `auth_logs` | Auditoría: validate/discover/login_visa/dispatch/token_fetch_failed |

## API Endpoints

```
GET/PUT  /api/bots/:id                                  Status + config
POST     /api/bots/:id/activate|pause|resume
DELETE   /api/bots/:id
POST     /api/bots/validate-credentials
GET      /api/bots/:id/logs/polls[/summary|/cancellations|/:pollId]
GET      /api/bots/:id/logs/cas-prefetch|reschedules
GET      /api/bots/auth-logs | /api/health
POST     /api/dev/check-dates/:botId | /api/dev/login/:botId
```

`bots.casCacheJson` → API key `casCache` (con campos calculados `ageMin`, `availableDates`).
`poll_logs status`: `ok`, `filtered_out`, `soft_ban`, `session_expired`, `error`, `tcp_blocked`.

## Trigger.dev Tasks

| Task | Cuándo corre |
|------|-------------|
| `poll-cron-cloud` | `*/2` PROD — fallback cron |
| `poll-cron-local` | `1/2` DEV — fallback cron |
| `poll-visa` | Core: 1 poll/run (cron) o self-chain (sub-minute/burst) |
| `login-visa` | Last resort: login cloud + restart chain |
| `reschedule-visa` | Manual reschedule wrapper |
| `prefetch-cas` | `*/30` PROD — CAS cache en `bots.casCacheJson` |
| `ensure-chain` | Martes 8:50-8:59 Bogota — resucita chains muertas |
| `notify-user` | Email Resend + webhook HMAC |

## IDs clave

| Concepto | Valor |
|----------|-------|
| Bogota Consular | facility `25` |
| Bogota ASC | facility `26` |
| Lima Consular | facility `115` |
| Bot 6 | Colombia, direct, 20s interval |
| Bot 7 | Peru, schedule 72781813, 9s, webshare, maxReschedules=1 |
| Bot 12 | Colombia, 4 applicants, paused — necesita activación manual para tener poll chain |

IDs personales en `.env` (TEST_USER_ID, TEST_SCHEDULE_ID, TEST_APPLICANT_IDS). No commitear.

## Visa API

Base: `https://ais.usvisa-info.com/{locale}/niv`

| Endpoint | Método |
|----------|--------|
| `/schedule/{id}/appointment/days/{facility}.json` | GET — días disponibles |
| `/schedule/{id}/appointment/times/{facility}.json?date=YYYY-MM-DD` | GET — horarios |
| `/schedule/{id}/appointment/days/26.json?consulate_id=25&consulate_date=...&consulate_time=...` | GET — CAS |
| `/schedule/{id}/appointment` | POST — reagendar |

### Tokens y sesión — no obvio

- **csrf-token** (`<meta>`) ≠ **authenticity_token** (`<input>`) — valores **distintos**.
- GET JSON: Cookie + `X-CSRF-Token` + `X-Requested-With: XMLHttpRequest` + `Accept: application/json`.
- POST reschedule: `X-CSRF-Token` header + `authenticity_token` body (`application/x-www-form-urlencoded`).
- **Éxito**: `302 → /continue → /instructions` + HTML con "programado exitosamente".
- **Limit Reached**: `HTTP 200` sin Location header + HTML "Limit Reached" — validado server-side, sin bypass.
- **`followRedirectChain()` en visa-client.ts**: solo `/instructions` en redirect NO es suficiente — parsear HTML final (falsos positivos documentados cuando el slot ya fue tomado por otro).
- Cookie rota en cada response pero la original sigue válida. **DEBE quedar URL-encoded** — `decodeURIComponent` corrompe → 401.
- Hard TTL: ~1h 28min. Re-login preventivo a 44min. `refreshTokens()` solo si `userId` null.
- `authenticity_token` es session-bound (Rails). Si `performLogin()` retorna `hasTokens: false` → tokens = null en DB → fuerza `refreshTokens()` en siguiente ciclo. Sin esto: POST falla con 302 → sign_in aunque GETs funcionen.
- Cita actual: parse HTML de `/groups/{userId}` (classes `consular-appt`/`asc-appt`) — no existe JSON API.

### Disponibilidad per-schedule

Fechas dependen del `scheduleId` (# applicants). Cada bot fetchea sus propios days — no se pueden compartir entre bots con distinto `scheduleId`.

## Proxy y bloqueos

- **Login: SIEMPRE direct** (nunca vía Webshare — contamina la IP).
- **Webshare**: OK para experimentos cortos y Bot 7 (es-pe). **NO** para polling sostenido es-co → bloqueo de cuenta en ~20min.
- **Bright Data POST = 402** (solo GET). Webshare POST funciona.
- **Sin `BROWSER_HEADERS`** de `constants.ts` → body vacío (0 bytes) — no es soft ban, es protección anti-bot.
- **Soft ban**: HTTP 200 + `[]` vacío (server-side rate limit, ~5h).
- **TCP block**: `other side closed` — puede ser IP-level o account-level. Verificar con Chrome + otra cuenta desde la misma IP para distinguir. No reintentar agresivamente — escala el ban.
- Backoffs: ver `poll-visa.ts:1197-1204`. ProxyPoolManager: ver `proxy-fetch.ts`.

## Deployment

RPi (arm64): worker en dev mode (IP residencial). Cloud = PRODUCTION env de Trigger.dev.

```bash
npm run deploy:rpi          # después de cambios en src/ o scripts/
npm run deploy:rpi:full     # si cambió package.json
# Cloud (tasks con environments: ['PRODUCTION']):
# mcp__trigger__deploy con environment=prod
```

Monitoreo:
```bash
source .env && sshpass -p "$RPI_PASS" ssh rpi "journalctl -u visa-trigger --since '5 min ago' --no-pager | tail -30"
curl -s "https://visa.homiapp.xyz/api/bots/6" | jq '{status, activeRunId, currentConsularDate}'
```

Login via RPi bloqueado → triggear `login-visa` en **prod** vía MCP con `chainId: 'dev'` (usa IP cloud para login, reinicia chain dev).

## Gotchas

- **`npx tsx -e` no funciona** con TypeScript. Siempre escribir a archivo `.ts`.
- **jq: comillas simples siempre** — `jq '...'` nunca `jq "..."` (el `!` se rompe con `"`).
- **DB timestamps** sin timezone = UTC → `new Date("2026-...")` sin TZ = local (+5h en Bogota).
- **Trigger.dev dev mode**: `tr_dev_...` NO sirve para trigger — usar JWT via PAT.
- **Runs "Cancelled by user"**: delayed runs reemplazados por nueva versión/concurrencyKey — normal.
- **`assertOk()`**: 5xx = transitorio, otro non-200 = `SessionExpiredError`. HTML en JSON endpoint = proxy redirect.

# Visa Bot

API multi-tenant para monitorear y reagendar citas de visa B1/B2 en embajadas de EEUU via `ais.usvisa-info.com`. Soporta multiples locales/embajadas (Bogota, Canada, Armenia, Mexico, etc.) con fallback a `es-co`.

## Preferencias del usuario

- **Siempre reportar horas en UTC-5 (Bogota)**, no en UTC. Ejemplo: "11:28 Bogota" en vez de "16:28 UTC".
- **Bot 6 usa `proxyProvider: 'direct'`** — NO usa Bright Data. Todas las requests (GET y POST) van desde la IP del RPi directamente. No asumir Bright Data sin verificar.

## REGLA CRITICA: NUNCA reagendar a una fecha posterior

**NUNCA ejecutar un reschedule POST que mueva una cita a una fecha IGUAL o POSTERIOR a la actual.** Una cita existente es un recurso valioso — las fechas tempranas son extremadamente competidas y se agotan en <2 minutos. Si se mueve a una fecha posterior, el slot original se pierde permanentemente.

- **Scripts (`test-reschedule-e2e.ts`, scripts ad-hoc):** BLOQUEAR `--commit` si la fecha propuesta no es estrictamente anterior. No hay excepcion.
- **Claude Code:** NUNCA correr `client.reschedule()` o `--commit` manualmente sin verificar que la fecha propuesta es **anterior** a la actual. Si no hay mejora, NO ejecutar el POST.
- **El bot en produccion ya tiene esta proteccion** (`isAtLeastNDaysEarlier` en poll-visa y reschedule-logic), pero scripts manuales y Claude Code NO la tenian.

## REGLA CRITICA: Scripts DEBEN respetar TODAS las limitaciones del bot

**Cada vez que Claude Code escriba un script que interactue con el sistema de visa (login, fetch dates, reschedule, etc.), DEBE respetar TODAS las limitaciones configuradas del bot:**

1. **`maxReschedules`**: Verificar `rescheduleCount < maxReschedules` ANTES de cualquier POST. Si el bot tiene `maxReschedules: 1` y `rescheduleCount: 0`, solo queda 1 intento — NO desperdiciarlo.
2. **`targetDateBefore`**: Solo reagendar a fechas estrictamente anteriores a este valor. Ej: `targetDateBefore: '2026-04-01'` = solo marzo o antes.
3. **Fecha actual vs propuesta**: La fecha propuesta DEBE ser estrictamente anterior a `currentConsularDate`. SIEMPRE leer la cita actual de la API/DB antes de actuar.
4. **`excluded_dates`**: Respetar rangos de exclusion del bot.
5. **Peru (`es-pe`) es especialmente critico**: Limite de 2 reprogramaciones (bloqueo irreversible). Cada intento cuenta — NO hacer pruebas con `--commit` en Peru.
6. **Dry-run por defecto**: Todo script DEBE correr en modo dry-run a menos que el usuario explicitamente pida `--commit`. Mostrar claramente que pasaria sin ejecutar.
7. **Antes de escribir cualquier script**: Consultar `GET /api/bots/:id` para obtener estado actual (rescheduleCount, maxReschedules, currentConsularDate, targetDateBefore, status).

## Testing

- **Framework:** Vitest (`npm test` para correr, `npm run test:watch` para watch mode)
- **Tests:** `src/**/*.test.ts` — unit/integration tests con mocks de DB, Clerk, encryption
- **REGLA:** Despues de cualquier cambio en tasks, servicios, API, o middleware, **correr `npm test`** para verificar. Si un test falla, arreglarlo antes de continuar.
- **Test suites:** `src/services/__tests__/` (date-helpers, dispatch, subscriber-query, reschedule-cas-cache, html-parsers, visa-client), `src/api/bots-me.test.ts` (GET /me + clerk auth middleware)

## Reglas para Trigger.dev MCP

- **NUNCA usar `wait_for_run_to_complete`** — bloquea indefinidamente si el run se queda en "Dequeued". Congela a Claude Code.
- **Patron correcto**: `trigger_task` → `sleep 5` → `get_run_details(runId)` → si DEQUEUED/QUEUED >15s → reportar stuck. Si EXECUTING → re-check (max 3). Si COMPLETED → mostrar resultado.

## Stack

- **Runtime:** Node.js (ESM, TypeScript). **API:** Hono + `@hono/node-server`. **Background Jobs:** Trigger.dev v4 (cron + chain hybrid). **DB:** Neon PostgreSQL + Drizzle ORM. **Encryption:** AES-256-GCM.
- **Login:** Pure fetch-based (~970ms skipTokens, ~1.7s full), sin Playwright.
- **Polling:** Node.js `fetch` via 3 providers (direct | brightdata | firecrawl). **Reschedule POST:** Siempre `direct` — Bright Data devuelve HTTP 402 en POST.
- **Notificaciones:** Resend (email) + webhooks HMAC-signed.

## Ejecucion

```bash
npm run dev                              # API server
npm run trigger:dev                      # Trigger.dev worker
npm run login -- --bot-id=6              # Pure fetch login
npm run test-fetch -- --bot-id=5         # Test fetch providers
npm run test-reschedule -- --bot-id=5    # E2E reschedule (dry-run)
npm run test-reschedule -- --bot-id=5 --commit  # REAL reschedule
npm run db:push                          # DB push
npm run db:studio                        # DB GUI
npm run deploy:rpi                       # Deploy to RPi (sync + restart)
npm run deploy:rpi:full                  # Deploy + npm install + restart
```

## Arquitectura

```
Login (pure fetch — ~970ms sin tokens, ~1.7s con tokens):
  pureFetchLogin('iv') → GET sign_in → _yatri_session + CSRF → POST sign_in (AJAX, bypass hCaptcha)
  → (opcional) GET appointment page → csrf-token + authenticity_token → session en DB
  Fallback: IV → NIV. Sin Playwright.

Polling (Trigger.dev — cron + chain hybrid):
  poll-cron-cloud (even min, PROD) + poll-cron-local (odd min, DEV)
  → trigger poll-visa para cada bot scout activo segun pollEnvironments
  poll-visa: re-login preventivo >44min → fetch days → filtrar → reschedule inline → self-trigger/exit

Session recovery:
  401/302 → performLogin() inline (~1s) → self-trigger 3s. Fallo → login-visa (last resort).
  Creds invalidas → status=error, notifica. Manual: POST /api/bots/:id/activate
```

### Flujo de polling (poll-visa task)
1. Carga bot + session + exclusiones. **Re-login preventivo** si session >44min (non-fatal). **Pre-drop warmup**: martes 8:56–8:58 fuerza re-login si session >5min.
2. `refreshTokens()` **condicional**: solo si `userId` null o faltan tokens. `userId` se persiste tras primer refresh (~1s ahorrado).
3. **En paralelo**: `getConsularDays()` + `getCurrentAppointment()` (skippable con `SKIP_APPOINTMENT_SYNC=true`). Sync DB si difiere.
4. **Super-critical** (martes 8:58–9:08): loop continuo, 2s entre fetches. **Burst** (9:08–10:00): hasta 3 fetches/run. **Sniper**: espera al segundo exacto del drop.
5. Fecha mejor → **reschedule inline** via `executeReschedule()` (primer attempt usa days ya fetcheados). Persiste session. Self-trigger con delay budget-aware.
6. 5 errores consecutivos → status=error, notifica, para chain. Soporta `dryRun: true`.

### Flujo de reschedule (`executeReschedule()` en `reschedule-logic.ts`)
Llamado inline desde poll-visa (con `preFetchedDays`) o desde reschedule-visa task. Hasta 5 intentos.

1. Attempt 1: usa `preFetchedDays` (skip re-fetch). Attempts 2+: fetch fresh.
2. **Parallel CAS days**: lanza `getCasDays()` para TODOS los consular times en paralelo (~900ms total vs ~900ms×N secuencial).
3. **Multi-time reverse order**: horario tardio primero (menos competido). getCasTimes → POST. POST falla → continue (slot-specific).
4. Todos fallan → re-fetch days, siguiente fecha. `exhaustedDates` (permanente) vs `transientFailCount` (1 retry). Cache CAS fallo → `casCache.clear()` + retry API.
5. **Seleccion candidato (cluster dodge)**: Sin secured attempt 1: gap12 ≤ 3 → pick #3 (si gap13 ≤ 30) o #2. Attempt 2+: #1. Con secured: always #1 (safety net).
6. **Secure then improve**: primer POST exitoso no retorna — sigue mejorando. `securedResult` trackea mejor resultado. Session expira post-secured → retorna lo que tiene.
7. **Early redirect exit**: `/continue` en Location → true (~200ms). **Deferred verification**: fire-and-forget `getCurrentAppointment()`.
8. **CAS cache**: usa `casCacheJson` si <60min. Filtro temporal 1-12 dias antes consular. `slots===0` → skip. Cache fallo → clear + API.
9. CAS depende de distancia: >1 mes abundante, <2-3 semanas escaso/FULL. Timing: detect → POST = ~2.3-2.8s.

### Providers de fetch (proxy-fetch.ts)

| Provider | Latencia | Notas |
|----------|----------|-------|
| `direct` | ~500-767ms | Keep-alive 30s. Default para RPi/dev |
| `brightdata` | ~4940ms | IP residencial cloud. Solo GET (POST=402) |
| `firecrawl` | ~1084ms | Backup. No sirve para login (no expone Set-Cookie) |

Configurado por bot en `proxyProvider`. **Webshare**: 10 IPs datacenter, 1GB/mes free tier. OK para experimentos cortos y Bot 7 (es-pe). **NO usar para polling sostenido en es-co** — causa bloqueo de cuenta (no solo IP) tras ~20min. Creds: `nfxniwxh:2zobtqlpwn1o`.

## Scout + Subscriber Architecture

Fechas disponibles son por facility, no por schedule. Un scout pollea y despacha a subscribers.

### Roles (`isScout` + `isSubscriber` booleans)
- **`isScout=true`** → poll-visa + dispatch. **`isSubscriber=true`** → recibe dispatch (login + reschedule on-demand).
- Ambos true → pollea Y recibe. Default subscriber: solo creds en DB, sin poll, sin session.
- Max scouts por facility: `MAX_SCOUTS_PER_FACILITY` (default 1) en `constants.ts`.

### Dispatch flow (fire-and-forget desde poll-visa)
1. Scout detecta fechas → `dispatchToSubscribers()` fire-and-forget (no bloquea self-trigger)
2. Query subscribers activos, filtrar exclusiones, ordenar por mejora mayor
3. Per subscriber (secuencial): login (~1s) → sync appointment → recalcula bestDate → `executeReschedule()` (~2.5s)
4. Total: detect → POST = ~3.5s/subscriber. Flash de 2min permite ~15-20 subscribers.

### Tablas: `dispatch_logs` (resumen + `details` jsonb DispatchDetail[]), `reschedule_logs.dispatchLogId` (nullable FK).

### Archivos clave
- `src/services/dispatch.ts` — `dispatchToSubscribers()`
- `src/services/subscriber-query.ts` — `getSubscribersForFacility()`, `findBestDate()`

## Estructura del proyecto

```
src/
├── index.ts                        # Hono app + serve()
├── db/ (schema.ts, client.ts, migrations/)
├── api/
│   ├── bots.ts                     # CRUD + activate/pause/resume
│   ├── dashboard.ts                # Dashboard HTML (server-rendered)
│   ├── logs.ts                     # Poll/reschedule/CAS/dispatch logs + cancellations endpoint
│   └── dev.ts                      # Triggers manuales (dev)
├── services/
│   ├── visa-client.ts             # refreshTokens, getCurrentAppointment, getDays, getTimes, reschedule
│   ├── login.ts                   # pureFetchLogin, InvalidCredentialsError
│   ├── proxy-fetch.ts            # direct | brightdata | firecrawl
│   ├── encryption.ts             # AES-256-GCM
│   ├── reschedule-logic.ts       # executeReschedule() — shared by poll-visa + reschedule-visa
│   ├── dispatch.ts               # dispatchToSubscribers()
│   ├── subscriber-query.ts       # getSubscribersForFacility(), findBestDate()
│   ├── html-parsers.ts           # Parsers para HTML de visa site (appointments, groups page)
│   ├── notifications.ts          # Resend email + webhook
│   └── scheduling.ts             # Delay dinamico, drop schedule por locale, phase functions
├── trigger/
│   ├── queues.ts                  # 4 colas (polling=10, reschedule=3, login=2, notify=5)
│   ├── login-visa.ts             # Last resort cloud login + restart chain
│   ├── poll-cron.ts              # Cron triggers: cloud (even min, PROD) + local (odd min, DEV)
│   ├── poll-visa.ts              # Core polling + inline reschedule + dispatch (dryRun support)
│   ├── reschedule-visa.ts        # Manual reschedule wrapper
│   ├── prefetch-cas.ts           # CAS prefetch cron (cloud, */30)
│   ├── ensure-chain.ts           # Tuesday guardian (8:50-8:59 Bogota)
│   └── notify-user.ts            # Email + webhook
└── utils/ (date-helpers.ts, constants.ts)
scripts/
├── login.ts, activate-bot.ts, set-bot-status.ts, set-bot-provider.ts, set-bot-role.ts
├── set-bot-active.ts              # Set bot active sin chain (cron-only mode)
├── test-fetch.ts, test-reschedule-e2e.ts, cross-account-test.ts
├── deploy-rpi.sh, monitor.ts
```

## Tablas DB (Drizzle schema)

| Tabla | Proposito |
|-------|-----------|
| `bots` | Config: creds (encrypted), schedule_id, applicants, facility_ids, locale, fechas, status, proxyProvider, isScout/isSubscriber, userId, casCacheJson, targetDateBefore, maxReschedules/rescheduleCount, pollEnvironments |
| `excluded_dates` | Rangos de fechas a saltar (bot_id, start_date, end_date) |
| `excluded_times` | Rangos de horas a saltar (bot_id, date, time_start, time_end) |
| `sessions` | Cookie encriptada + tokens CSRF (bot_id, yatri_cookie, csrf, auth) |
| `poll_logs` | Polls (earliest_date, dates_count, response_time_ms, status, dateChanges, topDates) |
| `reschedule_logs` | Reschedules (old/new dates+times, success, dispatchLogId) |
| `cas_prefetch_logs` | Prefetch runs (total/full/low dates, duration, changes_json) |
| `dispatch_logs` | Dispatch events (subscribers evaluated/attempted/succeeded, details jsonb) |
| `auth_logs` | Auditoria: validate/discover/create_bot/dispatch/login_visa |

## API Endpoints

```
POST   /api/bots                       Crear bot
POST   /api/bots/validate-credentials  Validar creds (~1s)
GET    /api/bots/:id                   Status + cita actual
PUT    /api/bots/:id                   Update config
POST   /api/bots/:id/activate          Activate (→ login_required → login-visa → active)
POST   /api/bots/:id/pause             Pause (cancela run delayed)
POST   /api/bots/:id/resume            Resume (re-trigger poll-visa)
DELETE /api/bots/:id                   Stop + eliminar

GET    /api/bots/:id/logs/polls              Polls (paginado, omite allDates)
GET    /api/bots/:id/logs/polls/summary      30-min buckets + top 5 dates (24h)
GET    /api/bots/:id/logs/polls/cancellations  Appeared/disappeared events server-side (24h)
GET    /api/bots/:id/logs/polls/:pollId      Detalle poll (incluye allDates)
GET    /api/bots/:id/logs/cas-prefetch       CAS prefetch logs
GET    /api/bots/:id/logs/dispatches         Dispatch events (scouts)
GET    /api/bots/:id/logs/dispatches/received Dispatches recibidos (subscribers)
GET    /api/bots/:id/logs/reschedules        Reschedule logs
GET    /api/bots/auth-logs                   Auth audit log
GET    /api/health                           Health check
POST   /api/dev/check-dates/:botId           Manual poll trigger
POST   /api/dev/login/:botId                 Manual login trigger
```

**Nota:** DB column `bots.casCacheJson` → API response key `casCache` (con campos calculados: `ageMin`, `availableDates`).

## Trigger.dev Tasks

| Task | Descripcion |
|------|-------------|
| `login-visa` | Last resort: cloud login + restart poll chain |
| `poll-visa` | Core polling. `cronTriggered` flag: true=exit after, false=chain. concurrencyKey por bot |
| `poll-cron-cloud` | Cron `*/2 * * * *` PROD. Triggers poll-visa para bots con 'prod' en pollEnvironments |
| `poll-cron-local` | Cron `1/2 * * * *`. Triggers poll-visa para bots con 'dev' en pollEnvironments |
| `reschedule-visa` | Manual reschedule wrapper (dryRun) |
| `prefetch-cas` | Cron `*/30 * * * *` PROD. CAS discovery + cache. Inline re-login. Notifica si stale >30min |
| `ensure-chain` | Cron martes 8:50-8:59 Bogota. Verifica chains vivas, resucita si muerta |
| `probe-cloud/local` | Experimento (crons `*/2` PROD + `1/2` DEV). Flash date measurement |
| `notify-user` | Email (Resend) + webhook |

### Patron cron + chain hibrido
- **Normal (cron)**: poll-cron triggers con `cronTriggered: true` → run sale al terminar → cron re-triggerea.
- **Burst/super-critical (chain)**: poll-visa se auto-triggerea aunque sea cron-triggered. Ventana termina → vuelve a cron.
- **`shouldChain`**: `!cronTriggered || isInSuperCriticalWindow || isInBurstWindow || hadTransientError`
- **`pollEnvironments`** (jsonb): `['dev']` = solo RPi, `['dev','prod']` = dual-IP offset 1min, `['prod']` = solo cloud
- **IMPORTANTE**: `/activate` y `/resume` inician chains (`cronTriggered: false`). Para modo cron-only sin chain: `npx tsx --env-file=.env scripts/set-bot-active.ts <botId>` (set active + null activeRunId → cron picks up).

### Budget-aware schedule (locale-aware, ±5% jitter)
- Drop-4h→-10m: 10min. -10m→-2m: 30s. -2m→+8m: 1s (super-critical loop). +8m→+60m: 10s (burst). +60m→+2h: 5min. Resto: 2min.
- Drop: `es-co` martes 9am Bogota, `es-pe` miercoles 12pm Lima. Config en `scheduling.ts`.
- concurrencyKey: `poll-${botId}` (dev) / `poll-cloud-${botId}` (cloud). Orphan detection skips on cronTriggered.
- `cancelPreviousRun()`: skip si `activeRunId === ctx.run.id` (evita auto-cancel).

## IDs clave

| Concepto | Valor |
|----------|-------|
| Bogota Consular (facility) | `25` |
| Bogota ASC (facility) | `26` |
| Lima Consular (facility) | `115` |
| Bot 6 (scout, Colombia) | direct from cloud, 20s interval, dispatches to subscribers |
| Bot 7 (scout, Peru) | schedule 72781813, 1 applicant, webshare, cita 2027-07-30. maxReschedules=1, rescheduleCount=0 |
| Bot 12 (subscriber, Colombia) | 4 applicants, paused (account blocked 2026-02-20) |

IDs personales en `.env` (TEST_USER_ID, TEST_SCHEDULE_ID, TEST_APPLICANT_IDS). No commitear.

## Visa API

Base: `https://ais.usvisa-info.com/{locale}/niv` (default: `es-co`)

| Endpoint | Metodo |
|----------|--------|
| `/schedule/{id}/appointment/days/{facility}.json` | GET — dias disponibles |
| `/schedule/{id}/appointment/times/{facility}.json?date=YYYY-MM-DD` | GET — horarios |
| `/schedule/{id}/appointment/days/26.json?consulate_id=25&consulate_date=...&consulate_time=...` | GET — CAS days |
| `/schedule/{id}/appointment` | POST — reagendar |

### Tokens y headers
- **csrf-token** (`<meta>`) → header `X-CSRF-Token`. **authenticity_token** (`<input>`) → form body. **Son valores diferentes.**
- **GET JSON**: Cookie + X-CSRF-Token + X-Requested-With: XMLHttpRequest + Accept: application/json.
- **POST reschedule**: X-CSRF-Token header + authenticity_token body. `application/x-www-form-urlencoded`. Redirect: POST → 302 `/continue` → 302 `/instructions`.

### Session / Cookie behavior
- Cookie rota en cada response pero original sigue valida. **DEBE quedarse URL-encoded** (`decodeURIComponent` corrompe → 401).
- **Hard TTL: ~1h 28m** (no idle timeout). Re-login preventivo a 44min. `refreshTokens()` condicional: solo si `userId` null.
- Cita actual: parsea HTML de groups page (`/groups/{userId}`, classes `consular-appt`/`asc-appt`). No existe JSON API.

## Trigger.dev: dev mode gotchas
- `tr_dev_...` NO funciona para trigger — usar JWT: PAT → project JWT → trigger.
- Runs "Cancelled by user" = delayed runs reemplazados por nueva version/concurrencyKey. Normal.

## Multi-embajada (locale)
Campo `locale` por bot (default `es-co`). Controla base URL, textos form (Reprogramar/Reschedule), month names. Facility IDs son strings numericos. Locales: `es-co` (validado), `en-ca`, `en-am`, `es-mx` (pendientes).

## Reschedule Limits & Target Date

| Campo | Descripcion |
|-------|-------------|
| `targetDateBefore` | Hard cutoff fecha. Ej: `2026-04-01` = solo marzo o antes |
| `maxReschedules` | Limite max. `null` = ilimitado. Check en poll-visa y subscriber-query |
| `rescheduleCount` | Contador atomico (`SQL +1`) en cada POST exitoso |

- **Peru (es-pe)**: Limite 2 reprogramaciones (bloqueo irreversible). `maxReschedules: 2`, `targetDateBefore: '2026-04-01'`. Ser extremadamente conservador.
- **Colombia (es-co)**: Sin limite conocido. `maxReschedules: null`.

### Limite de reprogramaciones: validado server-side (2026-02-22, Peru)

El limite de reschedules se valida a nivel de **servidor (API)**, no solo en la UI. No hay bypass posible. Probado con schedule 67882141 (Shiara, cuenta de Liz) que agoto sus 2 reprogramaciones.

**Appointment page** (`GET /schedule/{id}/appointment`): retorna HTML con titulo `"Limit Reached"`, sin `<form>` ni `authenticity_token`. El servidor no renderiza el formulario.

**POST reschedule** con `authenticity_token` valido (obtenido de `applicants/{id}/edit`, unica pagina del schedule que tiene form): retorna **HTTP 200 directo** (no redirect), con la pagina "Limit Reached".

**Respuesta del servidor al POST:**
```
HTTP/1.1 200 OK  (no redirect, no Location header)
Title: "Limit Reached | Official U.S. Department of State Visa Appointment Service"
```
```html
<h1 class='text'>Limit Reached</h1>
<div class='callout secondary animated bounce-in'>
  <p>Operación prohibida. Usted ha alcanzado el número máximo permitido
  de cancelaciones/reprogramaciones de citas para este solicitante. Debe
  asistir a esta entrevista o corre el riesgo de perder la tarifa de
  solicitud de visado (MRV).</p>
</div>
```

**Diferencias vs POST reschedule normal:**

| Escenario | POST status | Location header | Respuesta |
|-----------|-------------|-----------------|-----------|
| Exito | 302 | `/continue` → `/instructions` | HTML con "programado exitosamente" |
| Fecha invalida (cross-schedule) | 302 | `/continue` → `/instructions` | HTML con "no pudo ser programada" |
| **Limite alcanzado** | **200** | **(ninguno)** | **HTML "Limit Reached"** |

**Deteccion programatica:** HTTP 200 + sin Location + body contiene `"Limit Reached"` o `"alcanzado el número máximo"`.

**Endpoints JSON no bloqueados:** `days.json` y `times.json` siguen respondiendo (200 OK con datos) incluso con limite alcanzado. Solo el POST y la appointment page estan bloqueados.

Scripts: `scripts/test-shiara-limit-bypass.ts`, `scripts/test-shiara-march2026.ts`, `scripts/find-shiara-auth-token.ts`.

## Disponibilidad consular es schedule-specific

Las fechas consular dependen del `scheduleId` (numero de applicants), NO son globales por facility. Bot 6 (2p) ve 101 days, Bot 12 (4p) ve 97 days. 4p ⊆ 2p siempre (0 violaciones en 381 slots). CAS days identicos entre ambos.

**Modelo paralelo**: cada time slot tiene W ventanillas en paralelo. Grupo N ocupa N ventanillas simultaneamente. Slot aparece solo si `restantes >= N`. ≥4 ventanillas/slot (lower bound).

**Implicacion dispatch**: `preFetchedDays` del scout NO aplica a subscribers con diferente numero de applicants — subscriber debe fetchear sus propios days. Scripts: `scripts/capacity-model.ts`, `scripts/compare-schedules.ts`.

### Filtrado per-schedule: TODOS los endpoints validan (2026-02-22, Peru)

Probado con Bot 7 (es-pe, schedule 72781813, cita 2027-07-30) vs cuenta de Liz (schedule 69454137, cita 2026-07-09). Ambos 1 applicant, facility 115 (Lima). Liz ve fechas marzo 2026 que Bot 7 no ve.

| Endpoint | Comportamiento con fecha invisible | Validacion |
|----------|-----------------------------------|------------|
| `days.json` | No retorna la fecha | **Per-schedule** |
| `times.json` | HTTP 200 pero `{"available_times":[null],"business_times":[]}` | **Per-schedule** (soft-reject) |
| `POST reschedule` | Redirect chain completa (302→/continue→/instructions) pero HTML dice **"Su cita no pudo ser programada. Por favor, haga una selección válida."** | **Per-schedule** |

**Hallazgos clave:**
- El POST reschedule con fecha/hora valida de OTRA cuenta retorna el **mismo redirect chain** que un éxito (302→/continue→/instructions). La diferencia está en el HTML final: error vs confirmación.
- **`followRedirectChain()` en visa-client.ts reporta falso positivo**: detecta `/instructions` en Location → retorna `true`, pero la página contiene mensaje de error. Solo verificar `/instructions` en redirect NO es suficiente — debe parsearse el HTML final.
- **Un POST rechazado NO consume intento de reprogramación.** La cita no se mueve.
- Cross-schedule reschedule **NO funciona** — no se puede bookear fechas visibles en otro schedule.
- La diferencia en fechas visibles entre schedules del mismo facility (mismo # applicants) puede deberse a la distancia de la cita actual u otro factor server-side desconocido.

**BUG potencial en `followRedirectChain()`**: actualmente retorna `true` si Location contiene `/instructions`, pero debería validar el HTML final para buscar mensajes de error como "no pudo ser programada". Scripts: `scripts/cross-account-reschedule-debug.ts`.

## False positive reschedule en propio schedule (2026-02-24, Peru)

Bot 7 intentó reagendar **su propio schedule** (72781813) a 2026-03-24 y obtuvo **false_positive_verification**: el POST completó el redirect chain (302→/continue→/instructions) pero `getCurrentAppointment()` confirmó que la cita NO se movió. Esto NO es cross-schedule — Bot 7 vio la fecha en su propio `days.json`, obtuvo times (10:00), y POSTeo con sus propios tokens.

**Timeline (2026-02-24, hora Bogota):**
- 15:10:43 — Poll detecta 2026-03-24 (appeared). `getConsularTimes` retorna 10:00. POST → redirect chain OK → `getCurrentAppointment()` = cita sin cambio → `false_positive_verification`. Logueado en `reschedule_logs` (success=false). `rescheduleCount` NO incrementado.
- 15:11:23 — Segundo poll ve 2026-03-24 otra vez. `getConsularTimes` → `no_times` (horarios agotados o `[null]`).
- 15:11:29 — Fecha desaparece de `days.json`. Flash total: ~46s visible, ~16s entre detección y desaparición efectiva.

**Diferencia con cross-schedule:** En cross-schedule, la fecha pertenece a OTRO schedule. Aquí, la fecha apareció en el propio `days.json` de Bot 7 — el servidor la mostró pero rechazó el POST silenciosamente (redirect exitosa, appointment sin cambio). Posible causa: race condition (alguien más la tomó entre GET days y POST), o restricción server-side desconocida para schedules con cita >12 meses en el futuro.

**Hallazgo clave:** `false_positive_verification` puede ocurrir en el propio schedule, no solo en cross-schedule. La verificación post-POST via `getCurrentAppointment()` es ESENCIAL — sin ella, el bot reportaría éxito falso. El intento fallido NO consumió el único reschedule disponible (`rescheduleCount` sigue en 0).

## CAS Prefetch & Availability

**Cron `prefetch-cas`** (*/30, PROD): samplea ~4to consular date <30d → `getCasDays()` → `getCasTimes()`. ~15-25 req/run. Persiste en `bots.casCacheJson`. Inline re-login. Notifica si stale >30min. Bots sin `ascFacilityId` son skippeados (Peru no requiere CAS).

**Patterns**: Weekday 27-43 slots (07:00-17:30), Saturday 17, Sunday 0. >1 mes: 100% cobertura. <2-3 semanas: escaso/FULL. CAS overlap ~89% a 1 dia gap, ~10% a 8 dias.

**En reschedule**: cache <60min, filtro temporal 1-12 dias antes consular, slots=0 → skip, cache fallo → clear + API.

## Notificaciones

- **`notificationEmail`**: admin — TODOS los eventos. **`ownerEmail`**: dueño — solo `reschedule_success`.
- Bot 6: ambos=juan. Bot 7 (Peru): notification=juan, owner=petter.

## poll_logs status values

`ok` (dates pass filters), `filtered_out` (dates exist but all excluded), `soft_ban`, `session_expired`, `error`, `tcp_blocked`.

Dashboard summary usa `topDates[0]` como fallback cuando `earliestDate` null.

## Cancellations endpoint (server-side)

`GET /bots/:id/logs/polls/cancellations?hours=24` — computa appeared/disappeared events server-side sobre TODOS los polls del window (no limitado por paginacion). Reconstruye dateChanges de topDates para polls historicos. Retorna `{events, tMin, tMax, bursts, totalEvents, uniqueDates, closeCount}`. Dashboard lo usa directamente (no client-side computation). ~1-2KB respuesta vs ~500KB de polls raw.

## Gotchas

- **`assertOk()`**: 5xx = transitorio, otro no-200 = `SessionExpiredError`. HTML en endpoint JSON = proxy redirect.
- **Drop martes 9:00 AM Bogota** — confirmado. Agotan en <60s. Cancelaciones 24/7 en bursts.
- **Soft ban**: Per-IP, no observado a 300 req/5h en 42.1h. Ban: arrays `[]`, 5-20h, reset medianoche EST. **IMPORTANTE**: HTTP 200 con body vacío (0 bytes) NO es soft ban — es que faltan `BROWSER_HEADERS` (`sec-ch-ua`, `sec-ch-ua-platform`, `Accept-Language`). Sin esos headers el servidor retorna body vacío como protección anti-bot. Scripts DEBEN usar `BROWSER_HEADERS` de `constants.ts`. **Diferencia tcp_blocked vs soft_ban**: tcp_blocked = conexión TCP cortada (proxy/red), soft_ban = HTTP 200 con `[]` vacío (server-side).
- **Bright Data**: POST=402. Solo GET. Proxy necesita `rejectUnauthorized: false`.
- **Race condition reschedule**: re-lee currentConsularDate de DB antes de POST. Stale → aborta.
- **`npx tsx -e` no funciona** con TypeScript inline. Siempre escribir a archivos `.ts`.
- **jq: SIEMPRE usar comillas simples** — `jq '...'` nunca `jq "..."`. Dentro de strings dobles de bash, `!` se escapa como `\!`, rompiendo expresiones como `!=`. Error típico: `jq: error: syntax error, unexpected INVALID_CHARACTER ... \!= null`. Fix: `jq '[.[] | select(.x != null)]'` con comillas simples.
- **DB timestamps** sin timezone = UTC. `new Date("...")` sin TZ = local → +5h en Bogota.
- **TCP block**: por IP, dura horas. Resuelto desde ~Feb 13.

## BUG: Stale authenticity_token tras re-login sin tokens (2026-02-16, FIXED)

**Síntoma**: POST reschedule falla con `SessionExpiredError` (302 → sign_in) pero **GETs funcionan**. `rescheduleResult: "session_expired"` en poll_logs con `failStep: "post_reschedule"`. Múltiples re-login intentos no arreglan el problema.

**Causa**: `authenticity_token` es **session-bound en Rails** (a diferencia de `csrf-token` que es interchangeable). Cuando `performLogin()` retorna `hasTokens: false` (appointment page inaccesible), el código guardaba cookie nuevo + tokens viejos. Los tokens viejos no funcionan con el cookie nuevo → POST rechazado.

**Trigger más probable**: Pre-emptive re-login desde cloud (appointment page bloqueada por Cloudflare/IP datacenter).

**Fix aplicado**:
1. `poll-visa.ts`: Si `hasTokens: false` → tokens = null en DB y memoria → fuerza `refreshTokens()` en siguiente ciclo
2. `reschedule-logic.ts`: `reloginIfPossible()` detecta `hasTokens: false` → hace `refreshTokens()` inline antes de reintentar POST
3. `login.ts`: Logging persistente (`auth_logs` action=`token_fetch_failed`) con diagnóstico detallado (HTTP status, Cloudflare detection, body preview)

**Diagnóstico si reaparece**:
1. `GET /api/bots/auth-logs` → buscar `action: "token_fetch_failed"` con timestamp cercano
2. `errorMessage` dirá: `fetch_error` (network), `http_NNN` (redirect/error), o `parse_failed` (Cloudflare/HTML roto)
3. Poll logs: `rescheduleResult: "session_expired"` con `failStep: "post_reschedule"` pero GETs OK = tokens stale
4. Fix manual: `npx tsx --env-file=.env scripts/check-bot12.ts` (login + refresh tokens en DB)

## Probe-dates experiment (FINAL, 42.1h, 2026-02-12→14)

2,505 probes (cloud+local offset 1min), resolucion mediana 60s. 943 flash dates, 114 bookables.

| Intervalo | Catch rate | Req/5h |
|-----------|-----------|--------|
| 1 min (dual-source) | 97% | 300 |
| 2 min (single) | 84% | 150 |
| 3 min | 65% | 100 |

- **Mediana flash = 2min** (43% ≤2min, 54% ≤3min). Fechas 15-120d: mediana 2min (muy competido).
- Salto critico: 3→2min (+19pp). 2→1min (+13pp, 10 bookables solo catchable con 1min).
- Cancelaciones 24/7, volumen uniforme. Mejor ventana: 02:00-03:00 Bogota (mediana 12-17min).
- **300 req/5h por 42.1h sin ban** — threshold comunitario de 50-60 es mito. Rate limit per-IP confirmado.
- **Experimento concluido y detenido.**

## Cross-account experiment (2026-02-15)

Sessions son schedule-bound y locale-bound (302 en cross). CSRF tokens son intercambiables (no session-bound). Cross-facility OK con propio schedule. **Conclusion**: cada cuenta necesita su propia sesion; scout no puede pollear para subscribers sin login individual.

## Cross-schedule reschedule experiment (2026-02-22, Peru)

**Hipotesis**: fechas visibles en `days.json` de una cuenta (Liz, schedule 69454137) podrian ser bookeables via POST desde otra cuenta (Bot 7, schedule 72781813) del mismo facility (115 Lima). Ambos 1 applicant.

**Resultado: FALLO.** El POST retorna redirect chain exitosa (302→/continue→/instructions) pero la pagina de instrucciones contiene: *"Su cita no pudo ser programada. Por favor, haga una selección válida."* La cita no se movio. No consumio intento de reprogramacion.

**Validacion per-schedule en 3 niveles:**
1. `days.json` — no muestra la fecha
2. `times.json` — retorna `{"available_times":[null]}` (200 OK pero sin times reales)
3. `POST` — redirect chain identica a exito pero HTML contiene mensaje de error

**Posible causa de diferencia de fechas**: Bot 7 (cita 2027-07-30) solo ve fechas desde 2027-03-22. Liz (cita 2026-07-09) ve desde 2026-03-23. Podria haber un filtro server-side basado en la distancia de la cita actual.

**Cuenta de Liz (shiara.arauzo@hotmail.com)**: 4 schedules (4 personas con 1 applicant cada uno). userId=48007580.

| Schedule | Applicant | Nombre | Estado | Cita |
|----------|-----------|--------|--------|------|
| 69454137 | 80769164 | Liz | Accesible, form OK | 2026-07-09 09:45 |
| 67882141 | 80769427 | Shiara Ruby Arauzo Dejo | **Limit Reached** (2 reschedules agotados) | 2027-05-21 08:15 |
| 71170667 | 80769310 | (desconocido) | 302 redirect | — |
| 71169982 | 80769552 | (desconocido) | 302 redirect | — |

## Ventana de fechas visibles per-schedule (2026-02-22, Peru)

Las fechas visibles en `days.json` difieren entre schedules del mismo facility, incluso con mismo numero de applicants. La causa exacta es desconocida. La teoria del MRV fee payment date fue **desmentida**: Liz (MRV pagado ~junio 2025) ve 57 fechas despues de junio 2026 (13 meses mas alla del MRV expiry).

| Cuenta | Earliest visible | Latest visible | Cita actual |
|--------|-----------------|----------------|-------------|
| Bot 7 | 2026-12-23 (variable) | 2027-07-29 | 2027-07-30 |
| Liz | 2026-03-23 | 2027-07-29 | 2026-07-09 |

- Ambos ven fechas **identicas** de dic 2026 en adelante. La diferencia son solo ~5 fechas en marzo 2026 que Liz ve pero Bot 7 no.
- Las fechas cambian dinamicamente entre corridas (Bot 7: 2027-03-22 → 2026-12-23 earliest).
- **Teorias descartadas**: MRV payment date (desmentido), numero de applicants (ambos tienen 1).
- **Teorias pendientes**: distancia de cita actual, reschedule count, timing/flash, factor server-side desconocido.
- **Implicacion dispatch**: scout puede ver fechas que subscriber no puede bookear (ventanas distintas). Cada subscriber DEBE fetchear sus propios days.
- Scripts: `scripts/verify-date-ranges.ts`, `scripts/compare-peru-accounts.ts`.

## Blocking experiments (2026-02-20, Webshare DC proxies)

12 experiments testing rate limits, endpoint sensitivity, headers, cross-IP sessions, recovery, subnet blocking, full-flow vs poll-only, authenticated rate ramp, multi-IP sustained, locale comparison, and POST via proxy against `ais.usvisa-info.com` using Webshare datacenter proxy IPs.

### Key findings

| Variable | Finding | Evidence |
|----------|---------|----------|
| Public endpoint (`sign_in`) | **Indestructible** at 20/min (230+ req, 0 blocks) | Exp 1 |
| Authenticated AJAX (`days.json`) | **20/min single IP, 0 blocks** (330/330 OK). Latency 1.7→3.0s at 20/min | Exp 9 (7 phases, 40min) |
| Cross-IP session sharing | **100% functional** — login direct, poll via proxy | Exp 4 (64/64 OK, 4 IPs) |
| Login via proxy | **Contaminates IP** — blocked at req #24 (transient) | Exp 8A |
| Headers | Don't matter — all variants work equally | Exp 3 |
| DC vs Residential | Both work — DC IPs not inherently blocked | Exp 6 (cloud 30/30 OK) |
| Subnet contamination | **No cross-IP contamination** — per-IP only | Exp 7 |
| Recovery time | Proxy instability recovers in ~12 min | Exp 5 |
| Multi-IP sustained (30/min) | Works — failures = proxy instability, 0 visa blocks. #9 100%, #5 96% | Exp 10 (600 req, 3 phases) |
| Peru vs Colombia endpoint | **Identical** — Peru errors were Webshare drops (0ms). Bot 7 = proxy issue | Exp 11 (same IP, sequential) |
| POST via Webshare | **Works** — HTTP 302 → /continue (1637ms). Unlike Bright Data (402) | Exp 12 (dry-run 2099 date) |

### Webshare IP reliability

| IP | Label | Status |
|----|-------|--------|
| 64.137.96.74:6641 | #9 Madrid | **100%** (120/120 in Exp 10) |
| 23.229.19.94:8689 | #5 LA | **96%** (115/120 in Exp 10) |
| 23.95.150.145:6114 | #1 Buffalo | 79% (95/120 in Exp 10) |
| 216.10.27.159:6837 | #4 Dallas | 69% (83/120 in Exp 10) |
| 142.111.67.146:5611 | #10 Tokyo | **Dead** (10%, 12/120 in Exp 10) |
| 45.38.107.97:6014 | #7 London | Intermittent |
| 198.23.239.134:6540 | #2 Buffalo | Unstable (fetch failed) |
| 31.59.20.176:6754 | #6 London | Unstable |
| 198.105.121.200:6462 | #8 City of London | Unstable |
| 107.172.163.27:6543 | #3 Bloomingdale | Permanently blocked |

### Optimal polling config

- **Login: ALWAYS direct** (residential/cloud IP). Never via Webshare proxy (contamina IP, Exp 8A).
- **Safe rate**: ≤20 req/min per IP on days.json (Exp 9, 330/330 OK). Conservative target: 3/min/IP.
- **Bot 6 (es-co scout)**: `direct` from cloud+RPi, 20s interval. Cloud = ~1s, RPi = variable.
- **Bot 7 (es-pe scout)**: `webshare` with 5 IPs, 20s interval, dual-env. 22% tcp_blocked = proxy instability.
- **Bot 12 (es-co subscriber)**: paused. Account blocked 2026-02-20 after webshare experiment.
- **Latency >5s on normally-fast IP = pre-block signal** — consider rotating away.
- **POST via Webshare works** (Exp 12) — backup option if direct POST fails.
- Webshare creds: `nfxniwxh:2zobtqlpwn1o` (10 DC IPs, 1GB/mo free tier).

### CRITICAL: Webshare causa bloqueo de cuenta en polling sostenido (2026-02-20)

Bot 12 se cambió a webshare (3 IPs) para polling. En ~20min la CUENTA se bloqueó:
- Todos los IPs (webshare + direct RPi + direct cloud) devuelven `SocketError: other side closed`
- Login desde cloud funciona pero appointment page falla
- El bloqueo es a nivel de CUENTA/sesión, no solo IP
- **Webshare OK para**: experimentos cortos, Bot 7 (es-pe) que tolera 22% fallos
- **Webshare NO para**: polling sostenido es-co — usar direct

## Variables de entorno

Ver `.env.example`. Claves: `DATABASE_URL`, `TRIGGER_SECRET_KEY`, `BRIGHT_DATA_PROXY_URL`, `FIRECRAWL_API_KEY`, `MASTER_ENCRYPTION_KEY` (64-char hex), `WEBHOOK_SECRET` (64-char hex), `RESEND_API_KEY`, `SKIP_APPOINTMENT_SYNC`.

## Deployment en Raspberry Pi

RPi 4/5 (arm64) con Debian Lite. Worker en **dev mode** para IP residencial (cloud = hCaptcha + soft ban).

### Servicios systemd
- `visa-api` (port 3000): API Hono. `visa-trigger`: Trigger.dev dev worker.
- `sudo systemctl status|restart visa-api visa-trigger`. Logs: `journalctl -u visa-api -f`.

### URLs publicas (Cloudflare Tunnel)
- API: `https://visa.YOUR_DOMAIN.xyz/api/health`. SSH: `ssh rpi` (via cloudflared proxy).

### Deploy
```bash
npm run deploy:rpi           # Sync + restart
npm run deploy:rpi:full      # + npm install
./scripts/deploy-rpi.sh --no-restart  # Solo sync
```
Variables: `RPI_HOST`, `RPI_USER`, `RPI_PASS`, `RPI_PATH` en `.env`.

### Reglas para Claude

**Deploy RPi:** Preguntar al usuario despues de cambios en `src/`, `scripts/`, configs. Usar `--full` si package.json cambio.

**Deploy Trigger.dev cloud:** Tasks con `environments: ['PRODUCTION']` (prefetch-cas, ensure-chain, poll-cron-cloud, probe-cloud) requieren:
```bash
# Via MCP: mcp__trigger__deploy con environment=prod
# Via CLI: npx trigger.dev deploy --env prod
```

**Monitoreo:**
```bash
source .env && sshpass -p "$RPI_PASS" ssh rpi "journalctl -u visa-trigger --since '5 min ago' --no-pager | tail -30"
curl -s "https://visa.homiapp.xyz/api/bots/6/logs/polls?limit=5" | jq
curl -s "https://visa.homiapp.xyz/api/bots/6" | jq '{status, activeRunId, currentConsularDate}'
```

**Trigger.dev MCP** para ver runs sin dashboard web. `npm run monitor` para dashboard ASCII.

## TCP Block Analysis (2026-02-27, 36h, bot 7)

10,866 polls. 184 tcp_blocked (1.7%). Dos incidentes identificados.

### Incidente cloud (Feb 26-27): hard ban de ~8.7h

- 08:00-16:40 Bogota: 2105 requests limpios (~250/hr, ~4.2/min)
- 16:41: primer bloqueo (webshare falla → fallback a direct → cloud IP 52.21.62.233 también bloqueada)
- Pattern: 4 blocks en cluster → recovery 24min → repite → escala. Cada reintento durante el bloqueo aumenta la penalidad.
- 18:46: hard ban por ~8.7h (hasta ~03:30 Bogota). Recovery después de que los reintentos pararon.
- **Causa raíz**: backoff previo era 3→5→7→9→15min — demasiado rápido, los retries escalaban el ban.
- **Fix aplicado**: primer tcp_blocked → **30min**, segundo → **45min**, tercero+ → **60min** (en `poll-visa.ts`)

### RPi (186.154.35.0): 8.8% global, 34% en Feb 27

- Episodes cortos (mediana = 1 poll), no hard ban. Recovery mediana ~24min.
- Feb 26: solo 0.7%. Feb 27: 34.3% iniciando 01:45 Bogota.
- Episódico (residencial/ISP rate limiting) vs cloud (acumulación diaria).

### ProxyPoolManager webshare (`proxy-fetch.ts`)

3-state circuit breaker (closed/half_open/open) + EWMA scoring + weighted random selection. Ver código para constantes.

**En práctica (Bot 7, 2026-02-27):** casi inactivo — cloud chain no tiene WEBSHARE_PROXY_URLS → usa direct siempre. RPi chain intenta webshare pero tcp_blocked casi siempre → fallback a direct → tcpBackoff 30-60min → el ciclo se repite. Solo 3 polls webshare en 24h. Sería útil si hubiera dispatch concurrente a múltiples subscribers.

**Fallback a direct:** automático por-request, no persiste en DB. Reiniciar worker limpia estado in-memory.

**Endpoint de monitoreo:** `GET /api/bots/:id/proxy-pool?hours=N` — lee `poll_logs.connectionInfo` (cross-process safe, no lee estado in-memory).

**Bot 7 IPs por chain:**
- Cloud (prod): `52.21.62.233` direct (sin WEBSHARE_PROXY_URLS en cloud env)
- RPi (dev): 4 webshare (W1 Buffalo, W4 Dallas, W5 Madrid, W7 London) + fallback `186.154.35.0` direct

### Bloqueos por IP (36h)
| IP | Chain | tcp_blocked | Total | % |
|----|-------|------------|-------|---|
| 186.154.35.0 (RPi) | dev | 79 | 898 | 8.8% |
| 52.21.62.233 (cloud direct) | cloud | 43 | 6412 | 0.7% |
| 216.10.27.159 (W4 Dallas) | dev | 24 | 834 | 2.9% |
| 64.137.96.74 (W5 Madrid) | dev | 15 | 907 | 1.7% |
| 23.95.150.145 (W1 Buffalo) | dev | 12 | 815 | 1.5% |
| 45.38.107.97 (W7 London) | dev | 11 | 861 | 1.3% |

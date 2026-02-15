# Visa Bot

API multi-tenant para monitorear y reagendar citas de visa B1/B2 en embajadas de EEUU via `ais.usvisa-info.com`. Soporta multiples locales/embajadas (Bogota, Canada, Armenia, Mexico, etc.) con fallback a `es-co`.

## Preferencias del usuario

- **Siempre reportar horas en UTC-5 (Bogota)**, no en UTC. Ejemplo: "11:28 Bogota" en vez de "16:28 UTC".
- **Bot 6 usa `proxyProvider: 'direct'`** — NO usa Bright Data. Todas las requests (GET y POST) van desde la IP del RPi directamente. No asumir Bright Data sin verificar.

## Testing

- **Framework:** Vitest (`npm test` para correr, `npm run test:watch` para watch mode)
- **Tests:** `src/**/*.test.ts` — unit/integration tests con mocks de DB, Clerk, encryption
- **REGLA:** Despues de cualquier cambio en tasks (`src/trigger/*.ts`), servicios (`src/services/*.ts`), API (`src/api/*.ts`), o middleware (`src/middleware/*.ts`), **correr `npm test`** para verificar que no se rompió nada. Si un test falla, arreglarlo antes de continuar.
- **Test suites:** `src/services/__tests__/` (date-helpers, dispatch, subscriber-query), `src/api/bots-me.test.ts` (GET /me + clerk auth middleware)

## Reglas para Trigger.dev MCP

- **NUNCA usar `wait_for_run_to_complete`** — bloquea indefinidamente si el run se queda en "Dequeued" (dev worker no lo procesa). Esto congela a Claude Code.
- **Patron correcto** despues de triggear un task:
  1. `trigger_task` → obtener `runId`
  2. Esperar 5s (`sleep 5` via Bash)
  3. `get_run_details(runId)` → verificar status
  4. Si `DEQUEUED` o `QUEUED` despues de 15s total → reportar al usuario que el run esta stuck y sugerir cancelar
  5. Si `EXECUTING` → esperar 5s mas y re-check (max 3 intentos)
  6. Si `COMPLETED` → mostrar resultado

## Stack

- **Runtime:** Node.js (ESM, TypeScript)
- **API:** Hono + `@hono/node-server`
- **Background Jobs:** Trigger.dev v4 (cron-triggered + self-rescheduling for burst windows)
- **Database:** Neon PostgreSQL + Drizzle ORM
- **Login:** Pure fetch-based (~970ms skipTokens, ~1.7s full), sin Playwright
- **Polling:** Node.js `fetch` via 3 providers (direct | brightdata | firecrawl)
- **Reschedule POST:** Siempre `direct` — Bright Data proxy devuelve HTTP 402 en POST a gov sites
- **Notificaciones:** Resend (email) + webhooks HMAC-signed
- **Encryption:** AES-256-GCM para credenciales y cookies en DB

## Ejecucion

```bash
# API server
npm run dev

# Trigger.dev worker (en otra terminal)
npm run trigger:dev

# Login (pure fetch, no browser needed)
npm run login                    # bot 1 por defecto
npm run login -- --bot-id=6      # bot especifico

# Test de providers de fetch (requiere sesion activa)
npm run test-fetch               # bot 1
npm run test-fetch -- --bot-id=5

# Test e2e de reschedule (dry-run por defecto)
npm run test-reschedule -- --bot-id=5
npm run test-reschedule -- --bot-id=5 --commit  # REAL reschedule

# Cross-account experiment (test cookie/token sharing between 2 accounts)
npx tsx scripts/cross-account-test.ts --bot-a=6 --bot-b=<ID>

# DB push (crear/actualizar tablas)
npm run db:push

# DB studio (GUI)
npm run db:studio

# Script legacy (single-user)
npm run legacy

# Deploy a Raspberry Pi
npm run deploy:rpi           # Sync + restart servicios
npm run deploy:rpi:full      # Sync + npm install + restart
```

## Arquitectura

```
Login (pure fetch — ~970ms sin tokens, ~1.7s con tokens):
  pureFetchLogin('iv') → GET sign_in page → _yatri_session cookie + CSRF
      → POST NIV sign_in (AJAX headers, bypass hCaptcha) → nueva cookie
      → (opcional) GET appointment page → csrf-token + authenticity_token
      → session en DB, bot → active
  Fallback chain: pureFetchLogin('iv') → pureFetchLogin('niv')
  Sin Playwright — 100% Node.js fetch

Polling (Trigger.dev — cron + chain hybrid):
  poll-cron-cloud (even min, PROD) + poll-cron-local (odd min, DEV)
      → trigger poll-visa para cada bot scout activo segun pollEnvironments
  poll-visa task (cron-triggered o self-rescheduling en burst)
      → re-login preventivo si session >44min (pureFetchLogin inline)
      → fetch consular days via proxy provider (default: direct)
      → filtrar exclusiones
      → si hay fecha mejor → reschedule inline via executeReschedule()
          → fetch times, CAS days/times → POST reschedule
          → notify-user task (email/webhook)
      → si cronTriggered + modo normal → exit (cron maneja siguiente tick)
      → si super-critical/burst/error → self-trigger (chain mode)

Session expired (401/302 durante poll):
  poll-visa detecta 401/302 → performLogin() inline (~1s)
      → session nueva en DB → self-trigger con 3s delay → poll reanuda
      → si inline login falla → login-visa task como last resort (cloud re-login)
      → si creds invalidas → status=error, notifica usuario
  Recuperacion manual: POST /api/bots/:id/activate

Re-login preventivo (chain viva):
  poll-visa al inicio de cada run revisa session.createdAt
      → si sesion > 44 min → performLogin() inline (~1s)
      → session nueva en DB, continua poll con sesion fresca
      → non-fatal si falla (sesion actual puede tener ~44min restantes)
```

### Flujo de polling (poll-visa task)
1. Carga bot + session + exclusiones de DB
2. **Re-login preventivo** si session >44min: `performLogin()` inline (~1s). Non-fatal si falla. **Pre-drop warmup**: martes 8:56–8:58 fuerza re-login si session >5min para garantizar sesion fresca en super-critical.
3. `VisaClient.refreshTokens()` — **condicional**: solo corre si `bot.userId` es null (primera vez) o faltan tokens CSRF. Una vez que `userId` se persiste en DB, se skipea (~1s ahorrado por poll). `getConsularDays()` mantiene la sesion activa por si sola. Si falla: non-fatal (continua con tokens existentes). Si `SessionExpiredError` → fatal.
3. **En paralelo** (zero latencia extra):
   - `VisaClient.getConsularDays()` → filtra fechas excluidas
   - `VisaClient.getCurrentAppointment()` → parsea cita actual de la web (groups page). **Skippable** con `SKIP_APPOINTMENT_SYNC=true` para ahorrar 1 request del budget de soft ban.
4. Si las fechas de la web difieren de la DB → sync DB (detecta cambios manuales)
5. **Super-critical mode** (martes 8:58–9:08): loop continuo de fetches dentro del run con 2s entre cada uno (~18 fetches en 45s). Elimina ~10s de dead time entre runs. **Burst mode** (9:08–10:00): hasta 3 fetches por run. **Sniper mode**: si un fetch cae entre 8:59:30-9:00:00, espera hasta las 9:00:00 exacto para alinear con el drop.
6. Si hay fecha al menos 1 dia anterior a la actual → **reschedule inline** via `executeReschedule()` (elimina ~9s de overhead de task scheduling). El primer attempt usa los days ya fetcheados (ahorra ~1s de re-fetch).
7. Persiste session actualizada (cookie rota en cada response)
8. Self-trigger con `delay` budget-aware y `concurrencyKey` por bot
9. 5 errores consecutivos → status=error, notifica, para chain
10. SessionExpiredError → **inline re-login** via `performLogin()` (~1s) → self-trigger con 3s delay. Si falla → `login-visa` task como last resort. Si creds invalidas → status=error, notifica.
11. Soporta `dryRun: true` — mock dates, real DB logs + notifications

### Flujo de reschedule (`executeReschedule()` en `reschedule-logic.ts`)
La logica de reschedule vive en `src/services/reschedule-logic.ts` y es llamada:
- **Inline desde poll-visa** (path critico, con `preFetchedDays` para skip re-fetch en attempt 1)
- **Desde reschedule-visa task** (wrapper delgado, para triggers manuales via API)

1. Attempt 1: usa `preFetchedDays` si existe (skip re-fetch). Attempts 2+: fetch fresh.
2. Intenta el mejor candidato: fetch consular times → **getCasDays en paralelo para TODOS los consular times** (`Promise.all`) → procesar resultados secuencialmente
3. **Parallel CAS days**: en vez de iterar consularTimes secuencialmente (~900ms × N), lanza todos los getCasDays en paralelo (~900ms total sin importar N). Con 4 times: ~900ms vs ~3600ms. Solo ocurre cuando hay fecha mejor (raro), asi que el burst de requests es aceptable.
4. **Multi-time (reverse order)**: procesa los resultados del parallel fetch en orden **inverso** (horario tardio primero — menos competido que 07:15/08:00). Para cada time con CAS disponible: getCasTimes → POST. Si POST falla → **continue** (probar siguiente horario consular, el rechazo puede ser slot-specific).
5. **Si todos los horarios fallan** (CAS vacio para todos, o POST rechazado en todos): **re-fetch days** y probar siguiente fecha candidata con datos frescos. Hasta 5 intentos con tracking inteligente:
   - `exhaustedDates`: fechas sin times, sin CAS, o POST rechazado en todos los horarios (con API fresca) → excluidas permanentemente
   - `transientFailCount`: errores de red o cache CAS stale → permiten 1 retry (max 2 intentos por fecha)
   - Cache CAS fallido → `casCache.clear()` + transient retry con API fresca
5b. **Seleccion de candidato (gap-based cluster dodge)**:
   - **Sin secured + attempt 1**: evalua gap entre #1 y #2 (`gap12`). Si `gap12 ≤ 3` (cluster): evalua gap13. Si `gap13 ≤ 30`: pick #3. Si `gap13 > 30` o solo 2 candidatos: pick #2. Strategy: `cluster_dodge`.
   - **Sin secured + attempt 2+**: pick #1 (best available). Strategy: `best_available`.
   - **Con secured**: pick #1 (aggressive upgrade). Safety net = resultado ya asegurado. Strategy: `aggressive_upgrade`.
   - Ejemplos: [Mar9, Mar10, Mar13] → gap12=1, gap13=4 ≤30 → pick Mar13. [Mar9, Jun1, Nov30] → gap12=84 >3 → pick Mar9. Post-secured: siempre #1.
5c. **"Secure then improve"**: despues del primer POST exitoso, NO retorna — sigue intentando mejorar:
   - `securedResult` trackea el mejor resultado hasta ahora
   - `effectiveCurrentDate` se actualiza al nuevo date, filtrando solo mejores
   - DB, logs y notificaciones se emiten en cada exito intermedio ("Jun → Mar 13", "Mar 13 → Mar 10")
   - Deferred verification solo para el resultado final
   - Si session expira post-secured: retorna lo que tiene (no throw)
   - `reschedule_logs.error` almacena `[strategy] attempt N, #idx/total` para debugging en dashboard
6. **Early redirect exit**: `followRedirectChain()` retorna `true` al ver `/continue` en el Location header — no necesita hacer GET a /continue ni esperar el segundo 302 a /instructions. Ahorra ~200ms.
7. **No llama `refreshTokens()`** — los tokens del DB (set en poll-visa) son validos. Las 4+ llamadas GET previas prueban que la sesion esta viva. Ahorra ~1s en path critico.
7. **Verificacion deferred**: despues de un POST exitoso (redirect chain → /instructions), actualiza DB y notifica **inmediatamente** (el redirect chain es evidencia fuerte de exito). La verificacion via `getCurrentAppointment()` corre como **fire-and-forget** — si detecta discrepancia, logea error. Ahorra ~700ms del critical path. El siguiente poll (~1.5min) tambien detectaria cualquier problema.
8. En cada intento se registra en `reschedule_logs`. Si hay exito: actualiza bot + session + notifica + verifica deferred.
9. **CAS disponibilidad depende de la distancia temporal**: fechas >1 mes tienen 27-43 slots (abundante). Fechas cercanas (<2-3 semanas) pueden tener 0-10 slots o estar FULL — CAS se llena antes que consular. Una cancelacion consular cercana puede no tener CAS disponible. `executeReschedule()` itera todos los horarios consulares para maximizar chances (CAS varia por hora consular).

### Timing: detect → POST = ~2.3-2.8s (v4)
Inline + preFetchedDays (skip re-fetch) + parallel CAS days (~900ms) + early redirect exit (~200ms) + deferred verification + keep-alive (~200ms/req).

### Providers de fetch (proxy-fetch.ts)

| Provider | Latencia | Uso | Notas |
|----------|----------|-----|-------|
| `direct` | ~767ms (1st) / ~500ms (keep-alive) | `trigger dev` (IP residencial local) | `undici.Agent` keep-alive 30s, reutiliza TCP+TLS |
| `brightdata` | ~4940ms | Produccion cloud | IP residencial, necesita `rejectUnauthorized: false` |
| `firecrawl` | ~1084ms | Backup | Wraps response en rawHtml, 525 credits gratis |

Configurado por bot en campo `proxyProvider` de tabla `bots`. Firecrawl NO sirve para login (no expone Set-Cookie).

### Webshare — proxy datacenter gratuito (pendiente integrar)

**Free tier forever**: 10 proxies datacenter, 1GB/mes bandwidth, HTTP/SOCKS5, sin tarjeta de crédito.
- Son **10 IPs estáticas** (no rotativas por request) — tú controlas la rotación (round-robin, random, etc.)
- Proxy estándar HTTPS tunnel (`CONNECT`) → **todos los headers pasan transparentes** (Cookie, X-CSRF-Token, etc.)
- Tu consumo: ~54 MB/mes por IP (21,600 req × 2.5KB) → **18x bajo el límite de 1GB**
- Integración: nuevo provider `'webshare'` en `proxy-fetch.ts` con `HttpsProxyAgent`
- **ScraperAPI, Scrapestack NO sirven**: son scraping APIs que no tunean headers/cookies transparentes
- Sitio: https://www.webshare.io/pricing

**Utilidad potencial:**
- Failover si RPi o cloud se bloquean por IP
- 3ra+ fuente de IP para distribuir rate limit (per-IP)
- Escalar a más subscribers sin aumentar req/IP
- Con 10 IPs Webshare + RPi + cloud = 12 IPs × 30 req/h = 1,800 req/5h teóricos

## Scout + Subscriber Architecture

### Concepto

Las fechas disponibles son por facility, no por schedule. Todos los usuarios de Bogota (facility 25) ven las mismas fechas. Un solo bot (scout) pollea y despacha a los demas (subscribers).

```
SCOUT (max 1 por facility)               SUBSCRIBERS (N por facility)
┌──────────────────────┐                 ┌──────────────┐
│ Bot 6 (operador)     │                 │ Bot 42 (Juan)│  creds en DB
│ isScout: true        │                 │ isSubscriber: true
│ Poll cada 2 min      │                 │ No polls     │  sin session activa
│ getConsularDays()    │                 └──────────────┘
│                      │──── dispatch ──→ ...
│ Detecta fechas       │   (inline,      ┌──────────────┐
│                      │    fire&forget)  │ Bot 43 (Ana) │
└──────────────────────┘                 └──────────────┘
```

### Roles (boolean tags: `isScout` + `isSubscriber`)

Un bot puede tener ambos tags (`isScout=true, isSubscriber=true` → pollea Y recibe dispatch).
Max scouts por facility: `MAX_SCOUTS_PER_FACILITY` (default 1) en `src/utils/constants.ts`.

- **`isScout=true`** → ejecuta poll-visa (detecta fechas), despacha a subscribers inline.
- **`isSubscriber=true`** → recibe dispatch del scout (login + reschedule on-demand).
- **`isScout=true, isSubscriber=true`** → pollea + recibe dispatch. Bot nuevo auto-asignado como scout tiene ambos.
- **`isScout=false, isSubscriber=true`** (default) → solo creds + config en DB. Sin poll chain, sin session activa.

### Dispatch flow (inline en poll-visa, fire-and-forget)

1. Scout detecta fechas disponibles
2. `dispatchToSubscribers()` fire-and-forget (no bloquea self-trigger del scout)
3. Query subscribers activos para el facility, filtrar exclusiones, ordenar por mejora (mayor primero)
4. Para cada subscriber (secuencial):
   a. `performLogin()` con sus creds (~1s)
   b. `executeReschedule()` con las fechas detectadas (~2.5s)
   c. Si exito → notifica, siguiente subscriber
   d. Si fallo → log, siguiente subscriber

### Latencia total: detect → POST = ~3.5s (vs 2.5s inline directo)
+1s de login per subscriber. Para flash de 2 min, permite atender ~15-20 subscribers secuencialmente.

### Tablas relacionadas

- **`dispatch_logs`** — resumen del dispatch event: subscribers evaluados/intentados/exitosos, vinculado al poll_logs.id
- **`dispatch_logs.details`** (jsonb, `DispatchDetail[]`) — detalle por subscriber: mejora en dias, prioridad, login/reschedule timing, resultado
- **`reschedule_logs.dispatchLogId`** (nullable FK) — vincula reschedule individual al dispatch event. `null` = inline (no dispatch).

### Subscriber lifecycle
```
created → POST /activate → active (pure subscriber: sin poll chain, scout+subscriber: login + poll chain)
                              → dispatch detecta fecha → login + reschedule → success → notifica
                              → (manual) POST /pause → paused → POST /activate → active
```

### API endpoints nuevos
- `GET /api/bots/:id/logs/dispatches` — historial de dispatch events (paginado)

### Archivos clave
- `src/services/dispatch.ts` — `dispatchToSubscribers()` (core del dispatch)
- `src/services/subscriber-query.ts` — `getSubscribersForFacility()`, `findBestDate()`
- `src/db/schema.ts` — `bots.isScout`, `bots.isSubscriber`, `dispatchLogs`, `DispatchDetail`

## Estructura del proyecto

```
src/
├── index.ts                        # Hono app + serve()
├── db/
│   ├── schema.ts                   # 6 tablas (Drizzle), isScout/isSubscriber booleans
│   ├── client.ts                   # Conexion Neon
│   └── migrations/                 # Auto-generadas
├── api/
│   ├── bots.ts                     # CRUD + activate/pause/resume
│   ├── logs.ts                     # Poll + reschedule logs
│   └── dev.ts                      # Triggers manuales (dev)
├── services/
│   ├── visa-client.ts             # Clase TS: refreshTokens, getCurrentAppointment, getDays, getTimes, reschedule
│   ├── login.ts                   # pureFetchLogin (sin Playwright), InvalidCredentialsError
│   ├── proxy-fetch.ts            # Abstraccion: direct | brightdata | firecrawl
│   ├── encryption.ts             # AES-256-GCM
│   ├── reschedule-logic.ts       # executeReschedule() — shared by poll-visa (inline) and reschedule-visa (task)
│   ├── dispatch.ts               # dispatchToSubscribers() — scout dispatches to subscribers
│   ├── subscriber-query.ts       # getSubscribersForFacility(), findBestDate()
│   ├── notifications.ts          # Resend email + webhook
│   └── scheduling.ts             # Delay dinamico, prioridad, drop schedule por locale, phase functions
├── trigger/
│   ├── queues.ts                  # 4 colas (polling=10, reschedule=3, login=2, notify=5)
│   ├── login-visa.ts             # Last resort: login via pureFetchLogin + restart poll chain
│   ├── poll-cron.ts              # Cron triggers: cloud (even min, PROD) + local (odd min, DEV)
│   ├── poll-visa.ts              # Core: cron-triggered + self-rescheduling en burst (soporta dryRun)
│   ├── reschedule-visa.ts        # Reschedule con 3 fallback dates (soporta dryRun)
│   ├── prefetch-cas.ts            # CAS prefetch: scan 21-day window, cache in DB
│   ├── ensure-chain.ts            # Tuesday guardian: ensure chains alive before drop
│   └── notify-user.ts            # Email + webhook dispatch
└── utils/
    ├── date-helpers.ts            # Filtros de exclusion, comparacion de fechas
    └── constants.ts               # URLs, facility IDs, user-agent, getBaseUrl(), getLocaleTexts()
scripts/
├── login.ts                       # Login local via pureFetchLogin → session en DB
├── activate-bot.ts                # Set bot to login_required → login-visa task lo detecta
├── test-fetch.ts                  # Probar 3 providers de fetch
├── test-reschedule-e2e.ts         # E2E test de reschedule (dry-run por defecto, --commit para real)
├── set-bot-status.ts              # Cambiar status de bot (--bot-id=N --status=X)
├── set-bot-provider.ts            # Cambiar proxy provider de bot
├── set-bot-role.ts                # Cambiar role de bot (scout/subscriber/scout+subscriber)
├── cross-account-test.ts          # Experimento: cookie/token sharing entre 2 cuentas
├── deploy-rpi.sh                  # Deploy a Raspberry Pi (sync + restart)
└── monitor.ts                     # Dashboard ASCII en tiempo real
trigger.config.ts                  # Trigger.dev config
drizzle.config.ts                  # Drizzle ORM config
index.mjs                          # Script original (referencia)
api-map.md                         # Documentacion completa de endpoints
```

## Tablas DB (Drizzle schema)

| Tabla | Proposito |
|-------|-----------|
| `bots` | Config por cliente: creds (encrypted), schedule_id, applicants, facility_ids, locale, fechas actuales, status, proxy_provider, isScout/isSubscriber (boolean tags), userId (cached from groups page), casCacheJson (CAS prefetch cache), targetDateBefore (hard date cutoff), maxReschedules/rescheduleCount (reschedule limit), pollEnvironments (jsonb: `['dev']`, `['dev','prod']`, `['prod']`) |
| `excluded_dates` | Rangos de fechas a saltar (bot_id, start_date, end_date) |
| `excluded_times` | Rangos de horas a saltar (bot_id, date, time_start, time_end) |
| `sessions` | Cookie encriptada + tokens CSRF (bot_id, yatri_cookie, csrf, auth) |
| `poll_logs` | Cada intento de poll (earliest_date, dates_count, response_time_ms, status) |
| `reschedule_logs` | Cada intento de reschedule (old/new dates+times, success) |
| `cas_prefetch_logs` | Cada corrida de prefetch-cas (total_dates, full_dates, low_dates, duration_ms, request_count, changes_json) |
| `dispatch_logs` | Cada dispatch event del scout: subscribers evaluados/intentados/exitosos, details jsonb con DispatchDetail[] |
| `auth_logs` | Auditoría de autenticación: email (encrypted), action (validate/discover/create_bot/dispatch/login_visa), result (ok/invalid/error), clerkUserId, IP, botId. Loguea validate-credentials, discover-account, create-bot (API), dispatch login (subscriber), login-visa task (last resort). NO loguea pre-emptive re-login ni prefetch-cas re-login (operacionales, alto volumen). |

## API Endpoints

```
POST   /api/bots                       Crear bot (auto login_required)
POST   /api/bots/validate-credentials  Validar creds via pureFetchLogin (~1s)
GET    /api/bots/:id                   Status + cita actual
PUT    /api/bots/:id                   Update config (exclusiones, webhook, proxy)
POST   /api/bots/:id/activate          Set login_required (desde created, error, o login_required)
POST   /api/bots/:id/pause             Cancelar run delayed, status=paused
POST   /api/bots/:id/resume            Re-trigger poll-visa
DELETE /api/bots/:id                   Stop + eliminar

GET    /api/bots/:id/logs/polls        Historial de polls (paginado)
GET    /api/bots/:id/logs/cas-prefetch Historial de CAS prefetch (paginado)
GET    /api/bots/:id/logs/dispatches  Historial de dispatch events (paginado, para scouts)
GET    /api/bots/:id/logs/reschedules  Historial de reschedules (paginado)

GET    /api/bots/auth-logs             Auth audit log (email decrypted, paginado)
GET    /api/health                     Health check

POST   /api/dev/check-dates/:botId     Trigger manual de poll (dev)
POST   /api/dev/login/:botId           Trigger manual de login (dev)
```

## Trigger.dev Tasks

| Task | Queue | Machine | Descripcion |
|------|-------|---------|-------------|
| `login-visa` | visa-login (2) | micro | **Last resort**: login via pureFetchLogin desde cloud + restart poll chain. Solo se usa si inline re-login en poll-visa falla. |
| `poll-visa` | visa-polling (10) | micro | Cron-triggered (normal) o self-rescheduling (burst/super-critical). `cronTriggered` flag controla exit vs chain. concurrencyKey por bot, dryRun. |
| `poll-cron-cloud` | (cron `*/2 * * * *`, PROD only) | micro | **Cron trigger**: minutos pares, triggers poll-visa para bots con `'prod'` en `pollEnvironments`. Chequea active run antes de trigger. |
| `poll-cron-local` | (cron `1/2 * * * *`) | micro | **Cron trigger**: minutos impares, triggers poll-visa para bots con `'dev'` en `pollEnvironments`. Corre en DEV/RPi. |
| `reschedule-visa` | visa-reschedule (3) | micro | POST reschedule, 3 fallback dates, dryRun |
| `prefetch-cas` | (cron `*/30 * * * *`, PROD only) | micro | **Scheduled cron** en Trigger.dev cloud: descubre CAS dates reales via getCasDays() (sampling), luego getCasTimes(). Persiste en `bots.casCacheJson`, loguea en `cas_prefetch_logs`. Corre cada 30 min desde cloud para no consumir budget del RPi/dev. **Inline re-login** si session >44min (auto-sustentable sin depender de poll-visa). Detecta cambios de slots (appeared/went_full/disappeared) y notifica `cas_slots_changed`. Notifica `cas_prefetch_failed` si cache >30min stale (max 1/hora). |
| `ensure-chain` | (cron `50-59 13 * * 2`, PROD only) | micro | **Tuesday guardian**: cada minuto de 8:50–8:59 Bogota verifica que cada bot activo/error tenga una chain ejecutándose. Cron-aware: si bot usa dual-source (`pollEnvironments.length > 1`) y `activeRunId` es null pero tiene poll reciente (<5min), no resucita. EXECUTING → no-op. DELAYED/QUEUED → cancel + re-trigger ahora (pull forward). Muerta/null → resucita y notifica. |
| `probe-cloud` | visa-probe (2), cron `*/2 * * * *`, PROD only | micro | **Experimento**: fetch consular days cada 2 min (minutos pares) desde cloud. Guarda snapshot en poll_logs con pollPhase='probe-cloud'. Re-login inline si session >30min. |
| `probe-local` | visa-probe (2), cron `1/2 * * * *`, DEV only | micro | **Experimento**: fetch consular days cada 2 min (minutos impares) desde RPi. Guarda snapshot en poll_logs con pollPhase='probe-local'. Re-login inline si session >30min. |
| `notify-user` | visa-notify (5) | micro | Email (Resend) + webhook |

### Patron cron + chain hibrido (poll-visa)
- **Modo normal (cron)**: `poll-cron-cloud` (pares, PROD) y `poll-cron-local` (impares, DEV) triggerean poll-visa con `cronTriggered: true`. Al terminar, el run sale y limpia `activeRunId` → siguiente cron tick lo re-triggerea.
- **Modo burst/super-critical (chain)**: durante ventanas de drop, poll-visa se auto-triggerea (chain) aunque haya sido cron-triggered. Cuando la ventana termina, vuelve a modo cron (exit sin self-trigger).
- **`shouldChain`**: `!cronTriggered || isInSuperCriticalWindow || isInBurstWindow || hadTransientError || botJustErrored`
- **`pollEnvironments`** (jsonb en bots): `['dev']` = solo RPi, `['dev','prod']` = dual-IP offset 1min, `['prod']` = solo cloud
- Budget-aware schedule (locale-aware, ±5% jitter excepto super-critical):
  - Drop - 4h → Drop - 10m: 10 min (early)
  - Drop - 10m → Drop - 2m: 30s (pre-warm)
  - Drop - 2m → Drop + 8m: 1s (super-critical, continuous loop)
  - Drop + 8m → Drop + 60m: 10s (burst)
  - Drop + 60m → Drop + 2h: 5 min (tail)
  - Resto: 2 min (normal)
- **Drop schedule por locale**: `es-co` = martes 9am Bogota, `es-pe` = miercoles 12pm Lima. Config en `scheduling.ts`.
- **Super-critical mode**: `isInSuperCriticalWindow(locale)` activa loop continuo con 2s entre fetches. Budget de 45s por run (maxDuration=120s). Self-trigger con 1s delay.
- **Sniper mode** (`getSniperWaitMs(locale)`): 30s antes del drop, espera hasta el segundo exacto. Solo en burst mode.
- `concurrencyKey: poll-${botId}` (dev) o `poll-cloud-${botId}` (cloud) → max 1 poll por source por bot
- `priority: calculatePriority(activatedAt)` → mas antiguedad = mas prioridad
- `activeRunId` / `activeCloudRunId` en bots table permite pause/resume
- **Orphan detection**: skip cuando `cronTriggered` (cron legitimamente crea runs sin matching activeRunId). En chain mode: si `ctx.run.id !== bot.activeRunId` y el activeRunId esta vivo → aborta.
- **`cancelPreviousRun()`**: antes de self-trigger, cancela `bot.activeRunId` si es diferente de `ctx.run.id`. **IMPORTANTE**: skip si `activeRunId === ctx.run.id`.
- **SessionExpiredError → inline re-login** (performLogin, ~1s) → self-trigger 3s. Fallo → login-visa task (last resort). Creds invalidas → stop.
- **Soft ban detection**: usa `effectiveLastDatesCount` (payload en chain, DB fallback en cron) para detectar caida dramatica de fechas entre runs.
- **dryRun mode**: mock dates, real DB logs + notifications, 30s self-reschedule

### Bot status lifecycle
```
created → POST /activate → login_required → login-visa task (cloud login + restart chain) → active → (polling)
                                                                                                   → (session expires/401) → poll-visa: inline re-login → self-trigger 3s → active
                                                                                                   → (inline re-login fails) → login-visa task (last resort) → active
                                                                                                   → (creds invalidas) → error
                                                                                                   → (session >44min) → poll-visa: pre-emptive login inline (NO status change)
                                                                                                   → (5 errors) → error
                                                                                                   → (pause API) → paused → (resume API) → active
```

## IDs clave (datos de prueba)

| Concepto | Valor |
|----------|-------|
| User ID | Ver `TEST_USER_ID` en `.env` |
| Schedule ID | Ver `TEST_SCHEDULE_ID` en `.env` |
| Applicant IDs | Ver `TEST_APPLICANT_IDS` en `.env` |
| Bogota Consular (facility) | `25` |
| Bogota ASC (facility) | `26` |
| Bot activo | `6` |

**Nota:** Los IDs personales de visa NO deben commitearse. Usar variables de entorno.

## Endpoints visa API

Base: `https://ais.usvisa-info.com/{locale}/niv` (default: `es-co`)

| Endpoint | Metodo | Descripcion |
|----------|--------|-------------|
| `/schedule/{id}/appointment/days/{facility}.json` | GET | Dias disponibles |
| `/schedule/{id}/appointment/times/{facility}.json?date=YYYY-MM-DD` | GET | Horarios para un dia |
| `/schedule/{id}/appointment/days/26.json?consulate_id=25&consulate_date=...&consulate_time=...` | GET | Dias CAS (depende de consular) |
| `/schedule/{id}/appointment` | POST | Reagendar cita |

Ver `api-map.md` para documentacion completa.

## Tokens: csrf-token vs authenticity_token

**Son valores diferentes.** Ambos se extraen del HTML del appointment page:

- `csrf-token`: de `<meta name="csrf-token" content="...">` → header `X-CSRF-Token`
- `authenticity_token`: de `<input name="authenticity_token" value="...">` → campo del form POST

Ambos rotan con cada page load. `VisaClient.refreshTokens()` los refresca.

## Headers y Reschedule POST

- **JSON API (GET)**: `Cookie` + `X-CSRF-Token` + `X-Requested-With: XMLHttpRequest` + `Accept: application/json`. Sin `X-CSRF-Token` → 302 a sign_in.
- **Reschedule POST**: `X-CSRF-Token` header + `authenticity_token` en body (son valores **diferentes**). `Content-Type: application/x-www-form-urlencoded`.
- **Form fields**: `authenticity_token`, `confirmed_limit_message=1`, `use_consulate_appointment_capacity=true`, `appointments[consulate_appointment][facility_id|date|time]`, `appointments[asc_appointment][...]`, `commit=Reprogramar|Reschedule`.
- **Redirect chain**: POST → 302 `/continue` → 302 `/instructions` → 200. `followRedirectChain()` con `redirect: 'manual'`.

## Session / Cookie behavior

- **Cookie rota en cada response** pero la original sigue valida. **DEBE quedarse URL-encoded** — `decodeURIComponent` corrompe → 401.
- **Hard TTL: ~1h 28m** (no idle timeout). Cookie rotation NO extiende TTL. CSRF vive mientras la sesion.
- **Re-login preventivo**: poll-visa a los 44min (mitad TTL). Non-fatal. `session.createdAt` DEBE actualizarse en cada login.
- **`refreshTokens()` condicional**: solo si `userId` no cached o faltan tokens. `userId` se persiste tras primer refresh.
- **Cita actual**: parsea HTML de groups page (`/groups/{userId}`, classes `consular-appt`/`asc-appt`). No existe JSON API. En paralelo con `getConsularDays()`, non-fatal.

## Trigger.dev: dev mode gotchas

- **`tr_dev_...` NO funciona para trigger** — runs quedan QUEUED eternamente. Usar JWT: PAT (`tr_pat_...`) → `POST /api/v1/projects/{ref}/{env}/jwt` → JWT → `POST /api/v1/tasks/{taskId}/trigger`. Payload: `{ payload: JSON.stringify({json: data}), options: { payloadType: "application/super+json" } }`.
- **Runs "Cancelled by user"** = runs delayed reemplazados por nueva version del worker o nuevo trigger con mismo concurrencyKey. Comportamiento normal (siempre en pares: completed + cancelled).

## Soporte multi-embajada (locale)

Campo `locale` por bot (default `'es-co'`). Controla base URL, textos del form (Reprogramar/Reschedule), month names. Facility IDs son strings numericos (no hardcoded). `refreshTokens()` extrae ASC facility ID del HTML si no existe. Locales conocidos: `es-co` (validado), `en-ca`, `en-am`, `es-mx` (pendientes).

## Reschedule Limits & Target Date

Algunas embajadas imponen un **limite maximo de reprogramaciones** por cuenta. Si se alcanza el limite, la cita se bloquea permanentemente — ni el usuario ni soporte pueden reprogramarla.

| Campo | Tipo | Descripcion |
|-------|------|-------------|
| `targetDateBefore` | `date` (nullable) | Hard cutoff: solo reschedula a fechas **estrictamente antes** de este valor. Ej: `2026-04-01` = solo marzo o antes. Se aplica en `filterDates()` y `findBestDate()`. |
| `maxReschedules` | `integer` (nullable) | Limite maximo de reprogramaciones. `null` = ilimitado. Se chequea en poll-visa antes de reschedular y en subscriber-query antes de incluir en dispatch. |
| `rescheduleCount` | `integer` (default 0) | Contador de reschedules exitosos. Se incrementa atomicamente (`SQL +1`) en `reschedule-logic.ts` en cada POST exitoso. |

### Peru (es-pe)
- **Limite: 2 reprogramaciones** por cuenta. Warning: "Hay un numero maximo de 2 cancellaciones/reprogramaciones permitidas por este servicio."
- Si se alcanza el limite, **la cita se bloquea irreversiblemente**.
- Para Peru: `targetDateBefore: '2026-04-01'` (solo marzo 2026 o antes), `maxReschedules: 2`.
- **Ser extremadamente conservador** — cada reschedule cuenta. No desperdiciar en fechas marginales.

### Colombia (es-co)
- Sin limite de reprogramaciones conocido (bot 6 ha reprogramado 6+ veces sin warning).
- `maxReschedules: null`, `targetDateBefore: null`.

## Gotchas

- **`assertOk()`**: 5xx = transitorio (retry), otro no-200 = `SessionExpiredError` (cubre 302/401/403/429). Verifica content-type: HTML en endpoint JSON = proxy redirect a sign_in.
- **Drop martes 9:00 AM Bogota** — confirmado por la Embajada. Pueden agotarse en <60s. Sniper mode alinea fetch a 9:00:00. Cancelaciones tambien otros dias.
- **Cancelaciones 24/7**: flash (<3min) en bursts, horario no-laboral activo. Madrugada (02-04 Bog) = menos competencia.
- **Soft ban**: comunidad reporta 50-60 req/5h, pero **no observado a 300 req/5h** (probe experiment 38.9h). Rate limit es **por IP, no por cuenta**. Si ban: arrays vacios `[]`, dura 5-20h, reset medianoche EST.
- **Bright Data**: Scraping Browser bloquea .gov. Proxy necesita `rejectUnauthorized: false`. **POST devuelve 402** — solo GET.
- **Race condition reschedule**: `reschedule-logic.ts` re-lee `currentConsularDate` de DB antes de POST. Si stale → aborta. Solo correr UN worker a la vez.
- **`npx tsx -e` no funciona** con TypeScript inline. Siempre escribir a archivos `.ts`.
- **DB timestamps sin timezone** — valores son UTC. `new Date("...")` sin timezone interpreta como LOCAL → +5h en Bogota.
- **TCP block (ECONNREFUSED)** — bloqueo **por IP** (no por cuenta/session), IP residencial bloqueada mientras datacenter sigue funcionando. Dura horas. Backoff escalado sin matar chain. **Resuelto desde ~Feb 13** — RPi ya no está bloqueada.

## Reglas de scheduling

- CAS debe ser **antes** que consular. Misma fecha con diferente hora puede tener CAS o no.
- CAS: ~35 horarios vs ~4 consular. Ambas obligatorias para submit.
- CAS disponibilidad depende de distancia: >1 mes abundante, <2-3 semanas escaso/FULL.

### CAS availability patterns

- Weekday: 27-43 slots (07:00-17:30, cada 15min). Saturday: 17 (08:00-12:00). Sunday: 0.
- FULL: solo holidays. Low (1-10): visperas de festivos. >1 mes: **100% cobertura**.
- <2-3 semanas: **escaso o FULL** (0-10 slots). CAS window: ~5-8 dias habiles antes del consular (NO deterministico).
- CAS dates overlap ~89% entre consulares con 1 dia de gap, ~55% a 4 dias, ~10% a 8 dias.

### CAS Prefetch (implementado)

**Cron `prefetch-cas`** (cada 30 min, PRODUCTION only) — cloud, no consume budget RPi. Inline re-login si session >44min (auto-sustentable).
- Samplea cada ~4to consular date (<30 dias) via `getCasDays()` → descubre CAS dates reales → `getCasTimes()` para slots. ~15-25 requests/run.
- Persiste en `bots.casCacheJson` (tipo `CasCacheData`), log en `cas_prefetch_logs`.
- Notifica `cas_prefetch_failed` si cache >30min stale (max 1/hora).
- **En reschedule:** `reschedule-logic.ts` consulta cache. Filtro temporal: 1-12 dias antes del consular. `slots === 0` → skip. `times` con slots > 0 → usa directo sin API. Si cache falla → `casCache.clear()` + retry con API fresca.

### Experimento: probe-dates (medicion de flash dates)

**Diseño:** Dos crons intercalados (`probe-cloud` pares PROD + `probe-local` impares DEV) → resolución 1min. Comparten sesión en DB, re-login inline cada ~30min. Budget: 300 req/5h.
**Archivos:** `src/trigger/probe-dates.ts`, cola `visa-probe` en `queues.ts`.
**Operar:** Pausar bot → deploy cloud+RPi → crons arrancan solos. Parar: eliminar archivo → redeploy → resume bot.
**Análisis:** `scripts/analyze-probe.ts` — catch rate por intervalo. Logs en `poll_logs` con `pollPhase LIKE 'probe-%'`.

### Resultados FINALES del experimento probe-dates (42.1h, 2026-02-12→14)

**Datos:** 2,505 probes (cloud: 1,208 ok, local: 1,252 ok, 45 failed), resolucion efectiva mediana 60s.

**Velocidad de competidores (cuanto tardan otros bots en agarrar una cancelacion):**
- 943 flash dates detectadas (fecha que aparece y luego desaparece = competidor la agarro)
- **43% desaparecen en ≤2min** (4% en ≤1min + 39% en 1-2min) — el bucket dominante
- 54% desaparecen en ≤3min, 65% en ≤5min
- Distribucion: P10=1min, P25=2min, **Mediana=2min**, P75=11min, P90=1.1h
- Fechas 15-120d: mediana **2min** (MUY competido). <15d: mediana 6min. >200d: mediana 5min.

**Oportunidades bookables (mejor que Mar 9 + CAS disponible):**
- **114 bookables en 42.1h** (~65/dia extrapolado)
- Fechas tan cercanas como 4-5 dias (Feb 19, Feb 20) hasta 19d (Mar 6)
- CAS abundante en todas: 32-245 slots. **CAS nunca fue bottleneck** para fechas >4d.
- Cancelaciones vienen en **bursts** — Mar 5 tuvo 24 apariciones, Mar 4 tuvo 15, Mar 6 tuvo 18.

**Impacto por intervalo de polling:**

| Intervalo | Catch rate bookables | Capturadas/42.1h | Perdidas/42.1h | Req/5h |
|-----------|---------------------|-----------------|---------------|--------|
| **1 min** (offset cloud+local) | **97%** | 111.1 | 2.9 | 300 |
| **2 min** (single source) | **84%** | 96.3 | 17.7 | 150 |
| **3 min** (intervalo anterior) | **65%** | 74.5 | 39.5 | 100 |

- **3min → 2min: +19pp** — el salto mas grande por el costo. Pierde ~10.1/dia vs ~22.5/dia.
- **2min → 1min: +13pp** — significativo. 10 bookables SOLO capturables con 1min (duraron 55-62s).
- **3min → 1min: +32pp** — de perder ~22.5/dia a perder ~1.6/dia.

**Limitacion de resolucion (sesgo observacional):**
- Con polling de 1min, cancelaciones que duran **<1min son invisibles** — aparecen y desaparecen entre probes.
- El pico en "2min" realmente mide 1-2 min (una fecha de 61s y una de 119s se ven igual).
- Es probable que existan muchas flash <1min que nunca detectamos.
- Pero si duran <1min, **ningun bot con polling normal las atrapa** — solo refresh manual o polling ultra-agresivo (<30s).

**Patrones horarios (hora Bogota):**
- **Alta competencia** (09:00-14:00, 16:00-23:00): mediana 2min, muchos bots activos
- **Media** (00:00-01:00, 04:00-08:00, 15:00): mediana 3-8min
- **Baja competencia** (02:00-03:00): mediana 12-17min — mejor ventana para capturar
- Cancelaciones ocurren **24/7 con volumen relativamente uniforme** (17-67 flash/hora)

**Hallazgos de infraestructura:**
- Cloud y local compartieron **misma session/cookie/tokens** durante 42.1h sin problemas.
- Rate limiting/bloqueo es **por IP, no por cuenta/session** — confirmado con 2 IPs compartiendo cuenta.
- Cada IP hizo ~30 req/h (1 cada 2min). La cuenta recibio ~60 req/h combinadas (300 req/5h) sin soft ban.
- **Maximo confirmado sin ban: 300 req/5h durante 42.1h** — 5x el threshold comunitario.

**Conclusion:** El offset cloud+local (1min) da 97% catch rate y rescata 10 bookables que 2min pierde. El salto critico es 3min→2min (+19pp), pero 2min→1min (+13pp) es significativo con suficientes datos. A 300 req/5h por 42.1h no hubo ban — el threshold comunitario de 50-60 parece ser mito o aplica a otros patrones. **Experimento concluido y detenido 2026-02-14.**

## Cross-account experiment (2026-02-15)

Resultados de `scripts/cross-account-test.ts --bot-a=6 --bot-b=7` (Colombia es-co vs Peru es-pe):

| Test | Resultado |
|------|-----------|
| Cookie A → schedule B (cross-account days) | **BLOCKED (302)** — sessions are schedule-bound |
| Cookie A → userId B (cross-account groups) | **BLOCKED (302)** — account-bound |
| CSRF A + Cookie B (token swap) | **WORKS** — CSRF tokens are NOT session-bound |
| Cookie A → locale B URL (cross-locale) | **BLOCKED (302)** — session is locale-bound |
| Cookie A → facility B con own schedule (cross-facility) | **OK** — session can query other facilities |
| Cookie A → facility B + schedule B (full cross) | **BLOCKED (302)** — schedule-bound wins |

**Conclusiones:**
- Cada cuenta necesita su propia sesion (no se puede compartir cookie entre cuentas)
- CSRF tokens son intercambiables entre sesiones (cualquier token valido funciona)
- Un scout NO puede pollear para subscribers sin login individual — arquitectura actual es correcta
- Session es locale-bound: cookie de `es-co` no funciona en URLs `es-pe`

### Rate limit experiment (pendiente)

Script: `scripts/rate-limit-experiment.ts` — determina si rate limiting es per-IP o per-IP+account.
3 fases × 10 steps × 20 requests + cooldowns ≈ 6h. Correr de noche desde RPi:
```bash
ssh rpi "cd /home/agetrox/visa-scraper && nohup npx tsx --env-file=.env scripts/rate-limit-experiment.ts > rate-limit-results.txt 2>&1 &"
```

## Notificaciones (ownerEmail)

Dos campos de email por bot:
- **`notificationEmail`**: admin/operador — recibe TODOS los eventos (reschedule, errores, TCP, soft ban, etc.)
- **`ownerEmail`**: dueño de la cuenta — solo recibe `reschedule_success` (sin spam operativo)

Config actual:
- Bot 6 (Colombia): `notificationEmail` = juan, `ownerEmail` = juan
- Bot 7 (Peru): `notificationEmail` = juan (operativo), `ownerEmail` = petter (solo reschedule exitoso)

## poll_logs status values

- **`ok`**: API devolvio fechas Y al menos una pasa filtros (`earliestDate` != null)
- **`filtered_out`**: API devolvio fechas raw pero NINGUNA pasa filtros (exclusiones, `targetDateBefore`). `earliestDate` = null, `allDates` tiene los raw. Antes se llamaba `no_dates` (migrado 2026-02-15).
- **`soft_ban`**, **`session_expired`**, **`error`**, **`tcp_blocked`**, etc.

Dashboard y summary API usan `allDates[0].date` como fallback para trend chart y calendario cuando `earliestDate` es null.

## CAS prefetch skip

Bots sin `ascFacilityId` (o `ascFacilityId = ''`) son skippeados por `prefetch-cas`. Peru (es-pe) no requiere cita CAS.

## Variables de entorno

Ver `.env.example` para la lista completa. Claves:
- `DATABASE_URL` - Neon PostgreSQL
- `TRIGGER_SECRET_KEY` - Trigger.dev
- `BRIGHT_DATA_BROWSER_URL` - CDP websocket (legacy, no se usa)
- `BRIGHT_DATA_PROXY_URL` - Proxy residencial para fetch polling
- `FIRECRAWL_API_KEY` - Provider alternativo de fetch
- `MASTER_ENCRYPTION_KEY` - 64-char hex (AES-256)
- `WEBHOOK_SECRET` - 64-char hex for HMAC-SHA256 webhook signing
- `RESEND_API_KEY` - Email notifications
- `SKIP_APPOINTMENT_SYNC` - Skip getCurrentAppointment() to save request budget (1 fewer request per poll)

## Deployment en Raspberry Pi

El backend puede correr completamente en una Raspberry Pi 4/5 (arm64) con Debian/Raspbian Lite (sin pantalla).

### Acceso SSH

```bash
ssh rpi                    # Via Cloudflare Tunnel (configurar en ~/.ssh/config)
ssh rpi-local              # Via LAN directa (configurar IP en ~/.ssh/config)
```

Requiere `cloudflared` instalado. Configurar hosts en `~/.ssh/config`:
```
Host rpi
  HostName ssh.YOUR_DOMAIN.xyz
  User YOUR_USER
  ProxyCommand cloudflared access ssh --hostname %h
```

### Por que RPi + dev mode (no cloud)

El worker de Trigger.dev corre en **dev mode** (`npx trigger.dev dev`) en la RPi por una razon critica:

- **Dev mode:** Worker corre en la RPi → IP residencial → hCaptcha no aparece, soft ban menos probable
- **Production mode:** Worker corre en Trigger.dev cloud → IP datacenter → hCaptcha bloquea, soft ban mas frecuente

La RPi con IP residencial del ISP local es ideal para este caso de uso.

### Servicios systemd en la RPi

| Servicio | Puerto | Descripcion |
|----------|--------|-------------|
| `visa-api` | 3000 | API Hono (`/etc/systemd/system/visa-api.service`) |
| `visa-trigger` | - | Trigger.dev worker en dev mode (`/etc/systemd/system/visa-trigger.service`) |

```bash
# Ver estado
sudo systemctl status visa-api visa-trigger

# Ver logs
sudo journalctl -u visa-api -f
sudo journalctl -u visa-trigger -f

# Reiniciar
sudo systemctl restart visa-api visa-trigger
```

### URLs publicas (via Cloudflare Tunnel)

- **API**: `https://visa.YOUR_DOMAIN.xyz/api/health`
- **Local**: `http://<RPI_IP>:3000/api/health`

Configurar el dominio en Cloudflare Tunnel (`~/.cloudflared/config.yml`).

### Monitor y monitoreo

- **`npm run monitor`** — Dashboard ASCII con 3 tabs: polls, CAS cache, experiments (TAB para cambiar)
- **Trigger.dev MCP** — Ver runs remotamente sin dashboard web. Ideal para verificar poll chain viva post-deploy.
- **Métricas normales**: poll-visa ~2min interval, 2-3s duración. Runs cancelled = delayed runs reemplazados (normal).

### Archivos en la RPi

```
$RPI_PATH/                      # Codigo del proyecto (default: /home/$RPI_USER/visa-scraper)
~/.config/trigger/config.json   # Token de Trigger.dev (del `npx trigger.dev login`)
~/.cloudflared/config.yml       # Config del tunnel
```

### Deploy a la RPi

**IMPORTANTE**: Despues de hacer cambios al codigo, deployear a la RPi con:

```bash
npm run deploy:rpi          # Sync codigo + restart servicios
npm run deploy:rpi:full     # Sync + npm install + restart (si cambia package.json)
./scripts/deploy-rpi.sh --no-restart  # Solo sync, sin restart
```

El script `scripts/deploy-rpi.sh` sincroniza:
- `src/` - Codigo fuente
- `scripts/` - Scripts de utilidad
- `package.json`, `tsconfig.json`, `trigger.config.ts`, `drizzle.config.ts`
- `CLAUDE.md`

**Variables de entorno** (configurar en `.env` o exportar):
```bash
# En .env:
RPI_HOST=rpi
RPI_USER=myuser
RPI_PASS=mypassword
RPI_PATH=/home/myuser/visa-scraper

# O inline:
RPI_HOST=rpi RPI_PASS=secret npm run deploy:rpi
```

### Reglas para Claude

**Deploy:** Cuando modifiques archivos que afecten la RPi (src/, scripts/, configs), pregunta al usuario si quiere deployear:

> "¿Deployeo los cambios a la RPi? (`npm run deploy:rpi`)"

Archivos que requieren deploy a RPi:
- `src/**/*.ts` - Codigo del servidor/tasks
- `scripts/*.ts` - Scripts de login/monitor
- `package.json` - Usar `--full` si hay cambios
- `trigger.config.ts`, `drizzle.config.ts`

**Deploy a Trigger.dev cloud (PRODUCTION):** El task `prefetch-cas` es un **cron que solo corre en PRODUCTION** (cloud de Trigger.dev), NO en el dev worker de la RPi. Cambios a `src/trigger/*.ts` que afecten tasks con `environments: ['PRODUCTION']` requieren deploy a cloud:

```bash
# Via MCP (preferido):
# Usar mcp__trigger__deploy con environment=prod

# Via CLI:
npx trigger.dev deploy --env prod
```

> Cuando modifiques `src/trigger/prefetch-cas.ts` u otros tasks cloud-only, deployear TANTO a RPi como a Trigger.dev prod.

**Monitoreo:** Para revisar el estado del sistema en la RPi:
```bash
# Logs de servicios
source .env && sshpass -p "$RPI_PASS" ssh rpi "journalctl -u visa-trigger --since '5 min ago' --no-pager | tail -30"

# Poll logs via API
curl -s "https://visa.homiapp.xyz/api/bots/6/logs/polls?limit=5" | jq

# Bot status
curl -s "https://visa.homiapp.xyz/api/bots/6" | jq '{status, activeRunId, currentConsularDate}'
```

**Trigger.dev MCP:** Usar para ver runs sin entrar al dashboard web. Ideal para verificar que la poll chain esta viva despues de un deploy.

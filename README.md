# visa-bot

Multi-tenant US visa appointment monitor and auto-rescheduler.

## What it does

Monitors [ais.usvisa-info.com](https://ais.usvisa-info.com) for B1/B2 visa appointment availability across US embassies. When a better (earlier) date appears, it automatically reschedules the appointment. Supports multiple users and bots, each with independent credentials, schedules, and configurations.

## Key features

- **Multi-tenant**: multiple bots with independent credentials, schedules, and configurations per user
- **Auto-reschedule**: detects earlier appointment dates and reschedules automatically with safety guards
- **Smart polling**: configurable intervals per locale, super-critical burst mode during known drop windows, TCP backoff
- **Date failure tracking**: stops wasting polls on repeatedly-failing dates using a sliding window with CAS escape hatch
- **Proxy support**: direct, Webshare, Bright Data, and Firecrawl providers with circuit breaker and recency penalty
- **Dashboard**: web UI for monitoring bot status, poll logs, and reschedule history
- **Notifications**: email (Resend) and webhook (HMAC-signed) on reschedule events
- **Encrypted credentials**: AES-256-GCM encryption at rest for all stored credentials
- **Dual deployment**: cloud workers (Trigger.dev) and local workers (e.g., Raspberry Pi with residential IP)

## Architecture overview

**Stack**: Node.js ESM/TypeScript, Hono API, Trigger.dev v4, Neon PostgreSQL + Drizzle ORM

**Core flow**:

```
poll-cron --> poll-visa (fetch available dates --> reschedule inline --> self-trigger chain)
```

- **Login**: pure `fetch` implementation (no browser or Playwright needed), completes in ~1s
- **Polling**: each bot runs an independent poll chain with configurable intervals
- **Reschedule**: inline within the poll task -- detects improvement, secures the slot, then attempts further upgrades
- **API**: Hono REST endpoints for bot management, logs, and health monitoring

## Supported locales

- `es-co` -- Colombia (Bogota)
- `es-pe` -- Peru (Lima)

Extensible to other US embassy locales served by `ais.usvisa-info.com`.

## Prerequisites

- Node.js 20+
- PostgreSQL (Neon recommended)
- [Trigger.dev](https://trigger.dev) v4 account
- (Optional) Proxy provider account (Webshare, Bright Data, or Firecrawl)
- (Optional) [Resend](https://resend.com) account for email notifications
- (Optional) [Clerk](https://clerk.com) for frontend authentication

## Setup

1. Clone the repository:

```bash
git clone https://github.com/your-org/visa-bot.git
cd visa-bot
```

2. Install dependencies:

```bash
npm install
```

3. Configure environment variables:

```bash
cp .env.example .env
```

Edit `.env` and fill in the required values. See `.env.example` for all available options. At minimum you need:

- `DATABASE_URL` -- PostgreSQL connection string
- `TRIGGER_SECRET_KEY` -- Trigger.dev secret key
- `MASTER_ENCRYPTION_KEY` -- generate with `openssl rand -hex 32`

4. Push the database schema:

```bash
npm run db:push
```

5. Start the API server:

```bash
npm run dev
```

6. Start the Trigger.dev worker (in a separate terminal):

```bash
npm run trigger:dev
```

7. Create a bot via the API:

```bash
curl -X POST http://localhost:3000/api/bots \
  -H "Content-Type: application/json" \
  -d '{
    "email": "your-visa-email@example.com",
    "password": "your-visa-password",
    "locale": "es-co"
  }'
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/bots/:id` | Get bot status and configuration |
| PUT | `/api/bots/:id` | Update bot configuration |
| POST | `/api/bots/:id/activate` | Activate a bot (starts polling) |
| POST | `/api/bots/:id/pause` | Pause a bot |
| POST | `/api/bots/:id/resume` | Resume a paused bot |
| DELETE | `/api/bots/:id` | Delete a bot |
| POST | `/api/bots/validate-credentials` | Validate visa portal credentials |
| GET | `/api/bots/:id/logs/polls` | Get poll logs |
| GET | `/api/bots/:id/logs/polls/summary` | Get poll summary |
| GET | `/api/bots/:id/logs/reschedules` | Get reschedule logs |
| GET | `/api/bots/:id/logs/cas-prefetch` | Get CAS prefetch logs |
| GET | `/api/health` | Health check |

## Configuration

Each bot supports the following configuration options:

| Option | Type | Description |
|--------|------|-------------|
| `targetDateBefore` | `string` (YYYY-MM-DD) | Only reschedule to dates strictly before this date |
| `maxReschedules` | `number` | Maximum total reschedules allowed for this bot |
| `rescheduleCount` | `number` | Current reschedule count (incremented automatically) |
| `proxyProvider` | `string` | Proxy provider: `direct`, `webshare`, `brightdata`, `firecrawl` |
| `pollEnvironments` | `string[]` | Where this bot polls: `dev` (local), `prod` (cloud), or both |
| `pollIntervalSeconds` | `number` | Override default polling interval |
| `targetPollsPerMin` | `number` | Target poll rate (converted to interval internally) |

### Excluded dates

Configure date ranges to skip during rescheduling via the excluded dates/times tables. The bot will never reschedule to a date within an excluded range.

## Safety guards

- **Never reschedules to an equal or later date** -- the original appointment slot is lost permanently if moved to a worse date
- **`maxReschedules` hard limit** -- prevents runaway rescheduling (especially important for locales like Peru with a 2-reschedule server-side limit)
- **Excluded date ranges** -- fully respected during reschedule candidate evaluation
- **Dry-run by default** -- manual scripts require explicit `--commit` flag to execute real reschedules
- **Locale-specific limits** -- Peru (`es-pe`) enforces a 2-reschedule lifetime limit; exceeding this causes irreversible account blocking

## Deployment

### Cloud (Trigger.dev)

Deploy tasks to Trigger.dev:

```bash
npx trigger.dev@latest deploy
```

### Local (Raspberry Pi)

Deploy to a local machine (e.g., RPi) for residential IP polling:

```bash
npm run deploy:rpi        # sync code and restart
npm run deploy:rpi:full   # sync + npm install (when dependencies change)
```

The hybrid architecture allows running some bots from cloud infrastructure and others from a residential IP to reduce blocking risk.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run login -- --bot-id=N` | Manual login for a specific bot |
| `npm run test-reschedule -- --bot-id=N` | Dry-run reschedule test |
| `npm run test-reschedule -- --bot-id=N --commit` | Execute a real reschedule |
| `npm run monitor` | Live monitoring dashboard |
| `npm test` | Run test suite (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run db:push` | Push schema changes to database |
| `npm run db:studio` | Open Drizzle Studio (database GUI) |

## Project structure

```
src/
  trigger/     Background tasks (poll-visa, poll-cron, login-visa,
               reschedule-visa, prefetch-cas, ensure-chain, notify-user)
  services/    Core logic (visa-client, login, proxy-fetch,
               reschedule-logic, scheduling, notifications)
  api/         REST API routes (bots, dashboard, logs, health)
  db/          Database schema, client, and migrations
  middleware/  Authentication middleware
  utils/       Shared utilities (date helpers, constants)
scripts/       CLI tools (login, deploy, monitor, test utilities)
```

## Database tables

| Table | Purpose |
|-------|---------|
| `bots` | Bot configuration: encrypted credentials, locale, status, proxy provider, polling settings |
| `sessions` | Encrypted session cookies and CSRF tokens |
| `poll_logs` | Poll results: earliest date found, response time, date changes, connection info |
| `reschedule_logs` | Reschedule attempts: old/new dates and times, success status |
| `excluded_dates` | Date ranges to skip per bot |
| `excluded_times` | Time ranges to skip per bot |
| `cas_prefetch_logs` | CAS (Consular Application Support) prefetch results |
| `auth_logs` | Authentication audit trail |

## How polling works

1. A cron trigger fires every 2 minutes, activating `poll-visa` for each active bot
2. `poll-visa` fetches available appointment dates from the visa portal
3. If a date earlier than the bot's current appointment is found (and passes all filters), an inline reschedule is attempted
4. For sub-minute intervals or burst windows, the task self-triggers with a delay instead of waiting for cron
5. Session management is automatic: pre-emptive re-login before session expiry, recovery on auth errors

## How rescheduling works

1. Available dates are filtered against `targetDateBefore`, excluded ranges, and the current appointment date
2. The bot uses a "secure then improve" strategy: first secure any better date, then attempt further upgrades
3. Multiple consular times are tried per date before moving to the next candidate
4. CAS (interview support center) appointments are scheduled to align with the consular date
5. On success, notifications are sent via email and/or webhook

## License

TBD

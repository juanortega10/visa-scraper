# Technology Stack

**Analysis Date:** 2026-04-06

## Languages

**Primary:**
- TypeScript 5.7.0 - Application logic, API routes, database models, and background tasks

## Runtime

**Environment:**
- Node.js (no specific version pinned; runs on arm64 Raspberry Pi + x64 cloud)

**Package Manager:**
- npm (v3 lockfile format)
- Lockfile: `package-lock.json` present

## Frameworks

**Core:**
- Hono 4.6.0 - HTTP server framework (lightweight, ESM-first)
- @hono/node-server 1.19.9 - Hono Node.js adapter

**Background Tasks:**
- @trigger.dev/sdk 4.4.1 - Scheduled and event-driven task runner
- @trigger.dev/build 4.4.1 (dev) - Build tool for Trigger.dev

**Database:**
- drizzle-orm 0.38.0 - TypeScript ORM with zero-runtime overhead
- drizzle-kit 0.30.0 (dev) - Migration and schema management
- @neondatabase/serverless 0.10.4 - Neon PostgreSQL HTTP client (required for Trigger.dev cloud workers)

**Testing:**
- vitest 4.0.18 - Unit test runner (Vite-based, ESM-compatible)

**Build/Development:**
- tsx 4.19.0 - TypeScript executor (used for scripts and dev server)
- tsc (via typescript) - Type checking

## Key Dependencies

**Critical:**
- undici 7.0.0 - Modern HTTP client with ProxyAgent support (replaces Node.js built-in http module; enables low-level proxy control)
- Resend 4.0.0 - Email service (via `resend.emails.send()`)
- @clerk/backend 2.31.0 - Authentication and user management

**Infrastructure:**
- @neondatabase/serverless 0.10.4 - Serverless PostgreSQL (HTTP-based for cloud workers, faster than TCP in Trigger.dev)

## Configuration

**Environment:**
- `.env` file (not committed; contains secrets)
- Environment variables loaded via `--env-file=.env` in npm scripts

**Key configuration variables:**
- `DATABASE_URL` - Neon PostgreSQL connection (HTTP endpoint)
- `MASTER_ENCRYPTION_KEY` - 64-char hex string for AES-256-GCM credential encryption
- `RESEND_API_KEY` - Email service authentication
- `CLERK_SECRET_KEY` - Clerk backend API key
- `CLERK_JWT_KEY` - JWT verification for token-based auth (PEM format)
- `WEBSHARE_API_KEY` - Webshare proxy list API
- `BRIGHT_DATA_PROXY_URL` - Static proxy endpoint (HTTP Proxy protocol)
- `FIRECRAWL_API_KEY` - Browser-based HTTP client (as fallback)
- `WEBHOOK_SECRET` - HMAC-SHA256 signing key for outbound webhooks
- `API_KEY` - Simple Bearer token for API requests (alternative to JWT)
- `PORT` - API server port (default: 3000)
- `TRIGGER_SECRET_KEY` - Trigger.dev dev mode (not used; dev mode requires JWT via PAT)
- `ADMIN_NOTIFICATION_EMAIL` - Default admin notification recipient
- `ADMIN_RESCHEDULE_EMAIL` - Admin email for reschedule summaries
- `DASHBOARD_PASSWORD` - Dashboard endpoint auth (hardcoded fallback: `1004232331`)
- `SKIP_APPOINTMENT_SYNC` - Toggle consular-to-CAS sync in polling loop
- `KAPSO_API_KEY` - Consular availability API (Peru integration)
- `KAPSO_API_BASE_URL` - Kapso API endpoint

**Build:**
- `tsconfig.json` - Strict mode, ES2022 target, ESNext modules, bundler resolution

## Platform Requirements

**Development:**
- Node.js (any recent LTS; tested on Darwin arm64)
- npm 8+
- TypeScript 5.7.0

**Production:**
- Trigger.dev cloud (production tasks)
- Neon PostgreSQL serverless database
- Raspberry Pi arm64 (dev/polling worker)
- Resend (transactional email)
- Clerk (authentication)
- Optional: Webshare (proxy pool), Bright Data (proxy), Firecrawl (HTTP crawler)

## Encryption

**Algorithm:** AES-256-GCM
- IV: 12 bytes (randomized per encryption)
- Auth tag: 16 bytes
- Key: 32 bytes (256 bits) from `MASTER_ENCRYPTION_KEY`
- Format: base64(IV + tag + ciphertext)
- Used for: credential storage in `bots.visaEmail` and `bots.visaPassword` (see `src/services/encryption.ts`)

## ESM Configuration

- `package.json` declares `"type": "module"`
- All imports use `.js` file extensions (required for ESM)
- Build outputs to `dist/` directory
- Tests run with vitest (ESM-native)

## Development Workflow

```bash
npm run dev              # Start API server + watch for changes (uses tsx)
npm run trigger:dev      # Start Trigger.dev worker (local mode)
npm test                 # Run vitest suite once
npm test:watch           # Run vitest in watch mode
npm run build            # Type-check with tsc
npm run db:push          # Apply pending migrations to Neon
npm run db:studio        # Open Drizzle Studio (DB inspector)
```

## Deployment

**Local (Raspberry Pi):**
- `npm run deploy:rpi` - Sync src/ and scripts/ via SSH, restart systemd unit
- `npm run deploy:rpi:full` - Also run `npm install` if dependencies changed

**Cloud (Trigger.dev):**
- Deploy via Trigger.dev web console or `trigger.dev deploy` CLI
- Runs as production worker with high concurrency

---

*Stack analysis: 2026-04-06*

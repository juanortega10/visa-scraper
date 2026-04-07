# Coding Conventions

**Analysis Date:** 2026-04-06

## Naming Patterns

**Files:**
- Kebab-case for multi-word files: `visa-client.ts`, `reschedule-logic.ts`, `proxy-fetch.ts`
- Camel-case for functions within files
- Test files use `.test.ts` suffix: `login.test.ts`, `visa-client.test.ts`
- Index files export the module's public API: `src/services/`, `src/api/`, `src/trigger/`

**Functions:**
- camelCase: `pureFetchLogin()`, `getConsularDays()`, `executeReschedule()`, `isDateExcluded()`
- Verbs for action functions: `fetch*`, `get*`, `set*`, `calculate*`, `filter*`
- Boolean predicates start with `is` or `has`: `isDateExcluded()`, `hasTokens`, `collectsBiometrics`
- Internal/private functions use underscore prefix: `_name` convention in mocks, but not in source

**Variables:**
- camelCase for all variables: `botId`, `visaEmail`, `yatriCookie`, `currentConsularDate`
- UPPER_SNAKE_CASE for module-level constants: `DEFAULT_POLL_INTERVAL_S`, `USER_AGENT`, `BROWSER_HEADERS`, `EMAIL_RE`
- Descriptive names favored over abbreviations: `extractCredentials` not `getCreds`
- Suffix units in numeric constants: `BACKOFF` array with `600` (ms), `connectTimeout: 10_000` (ms)

**Types:**
- PascalCase for interfaces: `LoginCredentials`, `VisaSession`, `RescheduleBot`, `ProxyFetchMeta`
- PascalCase for classes: `InvalidCredentialsError`, `AccountLockedError`, `VisaClient`
- PascalCase for enums: `botStatusEnum`, `proxyProviderEnum` (defined via `pgEnum` in Drizzle)
- Exported types use `export interface` or `export type`
- Request/Response types suffixed with `Result` or left as `Response`: `LoginResult`, `DaySlot[]`

## Code Style

**Formatting:**
- Prettier not enforced (no `.prettierrc`). Code assumes 2-space indentation via editor defaults.
- TypeScript strict mode enabled (`tsconfig.json: strict: true`)
- ESLint not enforced (no `.eslintrc`). Code follows implicit conventions from existing files.

**Linting:**
- No formatter/linter configured in repo. Style derived from codebase examples.
- Imports ordered: external libs → internal services/utils → relative `.js` files (ESM)
- Relative imports use `.js` extensions for ESM compatibility: `import { x } from './module.js'`

## Import Organization

**Order:**
1. External packages (Node.js, npm): `import { ProxyAgent } from 'undici'`, `import { task, logger } from '@trigger.dev/sdk/v3'`
2. Database and ORM: `import { db } from '../db/client.js'`, `import { bots, sessions } from '../db/schema.js'`
3. Internal services: `import { VisaClient } from '../services/visa-client.js'`, `import { encrypt } from '../services/encryption.js'`
4. Utilities and constants: `import { USER_AGENT, BROWSER_HEADERS } from '../utils/constants.js'`
5. Type imports: `import type { VisaSession, DaySlot } from '../services/visa-client.js'`

**Path Aliases:**
- `@/*` resolves to `./src/*` (defined in `tsconfig.json`)
- Used in API endpoints: `import { botsRouter } from '@/api/bots.js'` (not present in codebase, but available)
- Code prefers explicit relative imports over aliases: `../services/login.js` instead of `@/services/login.js`

## Error Handling

**Patterns:**
- Custom error classes extend `Error` and set `.name` property:
  ```typescript
  export class InvalidCredentialsError extends Error {
    constructor(message = 'Invalid email or password') {
      super(message);
      this.name = 'InvalidCredentialsError';
    }
  }
  ```
- Error classes may add domain-specific fields: `AccountLockedError.lockedUntil?: Date`
- Errors caught and re-thrown with context: `catch (err) { throw new SessionExpiredError(...) }`
- Session expiry indicated by non-200 status OR content-type mismatch (HTML instead of JSON on API endpoints)
- `assertOk(resp, label)` validates HTTP responses: throws `SessionExpiredError` on non-200, `Error` on 5xx
- 5xx errors considered transient (retryable), others (302, 401, 403) mean session expired
- Error messages include context: `"${label} failed: HTTP ${status}"` or `"${label}: ${detail}"`

**Error Classification in poll-visa:**
- Connection errors (ECONNRESET, ECONNREFUSED, socket hang up, EPIPE) → TCP block
- HTTP 5xx → transient server error (retryable with backoff)
- Non-200 non-5xx → `SessionExpiredError`
- Error messages recursively extract nested causes from undici: `e.cause?.cause` pattern

## Logging

**Framework:** `logger` from `@trigger.dev/sdk/v3`

**Patterns:**
- Log at task start: `logger.info('poll-visa START', { botId, chainId, dryRun })`
- Log at major decision points: `logger.warn('ORPHAN RUN — aborting', {...})`
- Log at error recovery: `logger.error('reschedule failed', { error: String(e), ...}`
- Structured logging: pass objects as second parameter with context fields
- Field names: `botId`, `chainId`, `error`, `status`, `duration`, `message`
- Don't log sensitive data (passwords, tokens, cookies) — only hashed/masked values
- Level progression: `info` (normal flow), `warn` (warnings, dedup), `error` (failures)

**Auth Logging:**
- Separate `logAuth(action, result, details)` function in `src/utils/auth-logger.js`
- Actions: `'validate'`, `'discover'`, `'login_visa'`, `'dispatch'`, `'token_fetch_failed'`
- Results: `'ok'`, `'invalid_credentials'`, `'account_locked'`, `'error'`

## Comments

**When to Comment:**
- Complex algorithms or non-obvious logic get a multi-line comment or JSDoc
- Regex patterns get inline explanation: `const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/)` — explain intent
- CRITICAL rules from CLAUDE.md get bold markers: `// CRITICAL: ...` or `/** CRITICAL: ... */`
- Gotchas and workarounds documented: `// Cookie rota en cada response pero la original sigue válida`
- TODO/FIXME comments are sparse (not systematically used; prefer atomic commits)

**JSDoc/TSDoc:**
- Function descriptions use JSDoc: `/** Pure fetch-based login ... */`
- Parameter descriptions: `@param creds - Credentials object`
- Return type documentation: `@returns LoginResult with hasTokens flag`
- Used on exported functions and interfaces, not on all functions
- Example from `login.ts`:
  ```typescript
  /**
   * Pure fetch-based login.
   * 1. GET sign_in page → _yatri_session cookie + CSRF token from HTML
   * 2. POST sign_in with AJAX headers → bypasses hCaptcha, gets new session cookie
   * 3. (optional) GET appointment page → csrfToken + authenticityToken
   *
   * Total: ~970ms (skipTokens) or ~1.7s (with tokens)
   */
  export async function pureFetchLogin(...): Promise<LoginResult>
  ```

**Comment Language:**
- English for code comments
- Spanish for domain-specific notes (e.g., "Cita Consular", "Bogota Hora Local")

## Function Design

**Size:** 
- Most functions 30-60 lines
- Complex functions like `poll-visa.ts:pollVisaTask` exceed 1800 lines (orchestration task, justified)
- Helper functions 10-20 lines
- Test setup functions intentionally compact

**Parameters:** 
- Functions accept objects for >2 parameters: `function execute(params: ExecuteParams): Result`
- Interfaces define parameter shapes with required fields at top, optional below
- Default parameters in options: `opts: PureFetchLoginOptions = {}`
- No positional booleans; use named options instead

**Return Values:** 
- Explicit `Promise<T>` for async functions
- Objects for multiple return values: `{ success: boolean, date?: string, attempts?: RescheduleAttempt[] }`
- `null` for optional values, not `undefined`
- Result types export from modules: `export interface RescheduleResult`

## Module Design

**Exports:** 
- Named exports for functions and interfaces: `export function pureFetchLogin(...)`
- Default exports avoided (no `export default`)
- Type imports use `import type { ... }` for tree-shaking
- Re-exported types for API clarity: `export type { GroupInfo as GroupResult }`

**Barrel Files:** 
- Index files in `src/services/`, `src/api/`, `src/trigger/` act as entry points but don't re-export
- Each module imports only what it needs from sibling modules
- Large modules (`login.ts`, `visa-client.ts`) define internal interfaces not exported

**Internal State:**
- Classes store session/config as private properties with accessors: `getSession()`, `getConfig()`
- Database records cached in memory only where necessary (e.g., `discoveryTokens` map in `bots.ts`)
- Immutable approaches favored: `updateSession(newSession: Partial<VisaSession>)` merges, doesn't mutate
- Instance methods prefix with verb or getter: `refreshTokens()`, `getCurrentAppointment()`

## Special Patterns

**Database Layer:**
- Drizzle ORM used with PostgreSQL (`pgTable`, `pgEnum`)
- Queries chained: `.select(...).from(table).where(...)`
- Timestamps stored as ISO strings or database `timestamp` type
- Enums defined via `pgEnum` at schema level: `botStatusEnum`, `proxyProviderEnum`
- Schema types exported and reused: `import { bots, CasCacheData } from '../db/schema.js'`

**Async Patterns:**
- All network operations async: `const resp = await fetch(...)`
- Fire-and-forget promises pushed to `pending: Promise<unknown>[]` array
- Awaited at end: `await Promise.allSettled(pending)`
- No callback-based async; pure async/await

**Race Conditions:**
- Comments note race-prone operations: `// RACE CONDITION GUARD: Re-read ONLY currentConsularDate from DB`
- Multi-step operations documented with numbered steps
- Optimistic locking patterns avoided; prefer re-read on critical updates

**String Formatting:**
- Template literals for interpolation: `` `${botId}-${locale}` ``
- URLSearchParams for form data: `new URLSearchParams({key: value}).toString()`
- ISO 8601 for dates/times: `new Date().toISOString()`, `'YYYY-MM-DD'` for dates

---

*Convention analysis: 2026-04-06*

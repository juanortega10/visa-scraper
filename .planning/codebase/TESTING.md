# Testing Patterns

**Analysis Date:** 2026-04-06

## Test Framework

**Runner:**
- Vitest 4.0.18 (configured in `vitest.config.ts`)
- Config: `vitest.config.ts` (minimal: globals enabled, node environment, includes `src/**/*.test.ts`)

**Assertion Library:**
- Built-in Vitest matchers: `expect(...).toBe()`, `expect(...).toEqual()`, `expect(...).toBeInstanceOf()`, `expect(...).toContain()`
- No external assertion library (Chai available but not used)

**Run Commands:**
```bash
npm test              # Run all tests once
npm run test:watch   # Watch mode with auto-rerun
```

## Test File Organization

**Location:**
- Co-located with source: `src/services/__tests__/` directory contains service tests
- API tests: `src/api/*.test.ts` (same directory as implementation)
- Example: `src/services/__tests__/login.test.ts` tests `src/services/login.ts`
- Trigger tests: `src/trigger/*.test.ts` (e.g., `src/trigger/prefetch-cas.test.ts`)

**Naming:**
- Test files: `.test.ts` suffix
- Test modules: descriptive name matching source module: `login.test.ts`, `visa-client.test.ts`, `reschedule-stability-fixes.test.ts`
- Avoid `__tests__` directory for new files unless colocating multiple related tests

**Structure:**
```
src/
├── services/
│   ├── login.ts
│   ├── visa-client.ts
│   ├── reschedule-logic.ts
│   └── __tests__/
│       ├── login.test.ts
│       ├── visa-client.test.ts
│       ├── reschedule-stability-fixes.test.ts
│       ├── reschedule-cas-cache.test.ts
│       ├── date-helpers.test.ts
│       ├── html-parsers.test.ts
│       └── visa-client-reschedule.test.ts
├── api/
│   ├── bots.ts
│   ├── dashboard.ts
│   └── bots-me.test.ts
└── trigger/
    ├── prefetch-cas.ts
    └── prefetch-cas.test.ts
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('pureFetchLogin — credential detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('throws InvalidCredentialsError when sign_in_form is re-rendered', async () => {
    // Arrange
    mockFetch.mockResolvedValueOnce(makeGetResponse());
    mockFetch.mockResolvedValueOnce(new Response(...));

    // Act
    await expect(pureFetchLogin(BASE_CREDS)).rejects.toThrow(InvalidCredentialsError);

    // Assert is implicit in expect().rejects.toThrow()
  });
});
```

**Patterns:**
- `describe()` blocks group related tests by feature/function
- `beforeEach()` sets up mocks and fake timers
- `it()` statements use descriptive names: "throws X when Y happens", "returns Z for case A"
- Three-part structure (Arrange-Act-Assert) reflected in comments when needed
- Helpers at module top for reusable test data

**Key fixtures and setup:**
```typescript
const NOW = new Date('2026-04-03T12:00:00Z');

function makeClient(overrides: Record<string, any> = {}) {
  return {
    getConsularDays: vi.fn().mockResolvedValue([]),
    // ... mock methods
  } as any;
}

const BASE_BOT: RescheduleBot = {
  currentConsularDate: '2026-05-04',
  // ... bot configuration
};
```

## Mocking

**Framework:** 
- Vitest's `vi` module for mocking
- `vi.mock()` for module mocking (hoisted, runs before imports)
- `vi.fn()` for spy functions with configurable return values
- `vi.stubGlobal()` for globals like `fetch`

**Patterns:**

**Module mocking with hoisted setup:**
```typescript
const { mockVerifyToken } = vi.hoisted(() => {
  process.env.CLERK_JWT_KEY = 'test-pem-key';
  const mockVerifyToken = vi.fn();
  return { mockVerifyToken };
});

vi.mock('@clerk/backend', () => ({
  verifyToken: mockVerifyToken,
  // ...
}));
```

**Chainable mock for Drizzle queries:**
```typescript
const { mockDbSelect, mockDbUpdate, mockDbInsert } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbInsert: vi.fn(),
}));

function chain(resolveValue: any) {
  const c: any = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'offset', 'set', 'values']) {
    c[m] = () => c;
  }
  c.returning = () => Promise.resolve(resolveValue);
  c.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  c.catch = (fn: any) => Promise.resolve(resolveValue).catch(fn);
  return c;
}
```

**Mock setup in tests:**
```typescript
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

// In test:
mockFetch.mockResolvedValueOnce(response1);
mockFetch.mockResolvedValueOnce(response2);
```

**What to Mock:**
- External APIs: `fetch` (global), HTTP responses
- Database: `db.select()`, `db.insert()`, `db.update()`
- Encryption: `encrypt()`, `decrypt()` (simple string transforms in tests)
- Trigger.dev: `logger`, `runs.cancel()`, task triggers
- Authentication: `verifyToken` from `@clerk/backend`
- Time: `vi.useFakeTimers()` + `vi.setSystemTime()`

**What NOT to Mock:**
- HTML parser functions: imported as actual (not mocked) to test parsing logic
  ```typescript
  vi.mock('../html-parsers.js', async () => {
    const actual = await vi.importActual<typeof import('../html-parsers.js')>('../html-parsers.js');
    return actual;  // Use real parser
  });
  ```
- Date helpers: real implementations used to verify calculation logic
- URL/regex patterns: real to validate against actual formats

## Fixtures and Factories

**Test Data:**

Real-world HTML fixtures:
```typescript
const GROUPS_REAL_CO = `
<html><body>
<div class='card'>
<a href="/es-co/niv/schedule/99999/appointment">Reagendar</a>
<p class='consular-appt'>
<strong>Cita Consular<span>&#58;</span></strong>
12 noviembre, 2026, 09:00 Bogota Hora Local at Bogota
</p>
</div>
</body></html>`;
```

Response factory:
```typescript
function makeResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html', ...headers },
  });
}
```

Client/bot factories:
```typescript
function makeClient(userId: string | null = '12345') {
  return new VisaClient(
    { cookie: 'test_cookie', csrfToken: 'csrf', authenticityToken: 'auth' },
    {
      scheduleId: '99999',
      applicantIds: ['1'],
      consularFacilityId: '25',
      ascFacilityId: '26',
      proxyProvider: 'direct',
      userId,
      locale: 'es-co',
    },
  );
}

const BASE_BOT: RescheduleBot = {
  currentConsularDate: '2026-05-04',
  currentConsularTime: '11:15',
  currentCasDate: '2026-04-22',
  currentCasTime: '08:00',
  ascFacilityId: '26',
};
```

**Location:**
- Fixtures defined at top of test file (after imports and mocks)
- Factories as named functions below fixtures
- Constants (NOW, BASE_CREDS) defined once and reused across tests

## Coverage

**Requirements:** 
- No coverage threshold enforced (not configured in `vitest.config.ts`)
- Target: critical paths (login, reschedule, polling logic) well-tested
- API endpoints and database layers have test coverage

**View Coverage:**
- No coverage command configured
- To view: `npm test -- --coverage` (would need coverage reporter plugin)

## Test Types

**Unit Tests:**
- Scope: Single function/method in isolation
- Approach: Mock all dependencies (DB, fetch, auth)
- Examples:
  - `login.test.ts`: Tests credential validation, lock detection, error classification
  - `date-helpers.test.ts`: Tests date filtering, interval calculations
  - `html-parsers.test.ts`: Tests parsing of appointment HTML with various locales
- Setup: Minimal fixtures, focused on function behavior

**Integration Tests:**
- Scope: Multi-function workflows (login → token refresh → reschedule)
- Approach: Mock DB and fetch, but test real service logic flow
- Examples:
  - `reschedule-stability-fixes.test.ts`: Tests full reschedule flow with falsePositiveDates detection
  - `visa-client-reschedule.test.ts`: Tests POST reschedule with session handling and CAS days fetching
  - `bots-me.test.ts`: Tests full API request/response lifecycle (auth → query → response)
- Setup: Realistic bot/client configurations, mock at boundaries

**E2E Tests:**
- Not used in codebase
- Manual testing via `npm run test-reschedule -- --bot-id=5 --commit`
- Scripts for integration testing: `src/scripts/test-reschedule-e2e.ts`

## Common Patterns

**Async Testing:**
```typescript
// Using async/await
it('returns appointment for Colombia groups page', async () => {
  mockProxyFetch.mockResolvedValue(makeResponse(GROUPS_CO));
  const client = makeClient('12345');

  const result = await client.getCurrentAppointment();

  expect(result).toEqual({
    consularDate: '2026-03-09',
    consularTime: '08:15',
    casDate: '2026-03-05',
    casTime: '10:45',
  });
});

// Using expect().rejects for error cases
it('throws InvalidCredentialsError when credentials invalid', async () => {
  mockFetch.mockResolvedValueOnce(makeGetResponse());
  mockFetch.mockResolvedValueOnce(new Response('sign_in_form re-rendered...'));

  await expect(pureFetchLogin(BASE_CREDS)).rejects.toThrow(InvalidCredentialsError);
});
```

**Error Testing:**
```typescript
it('throws AccountLockedError when lock message is present', async () => {
  mockFetch.mockResolvedValueOnce(makeGetResponse());
  mockFetch.mockResolvedValueOnce(new Response(
    'Your account is locked until 28 March, 2026, 20:23:21 -05.',
  ));

  await expect(pureFetchLogin(BASE_CREDS)).rejects.toThrow(AccountLockedError);
});

it('AccountLockedError parses the lockout date', async () => {
  mockFetch.mockResolvedValueOnce(makeGetResponse());
  mockFetch.mockResolvedValueOnce(new Response(
    'Your account is locked until 28 March, 2026, 20:23:21 -05.',
  ));

  try {
    await pureFetchLogin(BASE_CREDS);
  } catch (e) {
    expect(e).toBeInstanceOf(AccountLockedError);
    expect((e as AccountLockedError).lockedUntil).toBeInstanceOf(Date);
  }
});
```

**Mocking Multiple Sequential Calls:**
```typescript
// Setup sequence of responses
mockFetch.mockResolvedValueOnce(getResponse);      // First call
mockFetch.mockResolvedValueOnce(postResponse);     // Second call
mockFetch.mockResolvedValueOnce(appointmentPage);  // Third call

const result = await pureFetchLogin(creds);

expect(mockFetch).toHaveBeenCalledTimes(3);
expect(mockFetch).toHaveBeenNthCalledWith(1, signInUrl, expect.any(Object));
expect(mockFetch).toHaveBeenNthCalledWith(2, signInUrl, expect.objectContaining({ method: 'POST' }));
```

**Testing Reschedule Logic:**
```typescript
// Setup DB mocks
mockDbSelect.mockReturnValue(chain([{ currentConsularDate: '2026-05-04' }]));
mockDbInsert.mockReturnValue(chain([]));
mockDbUpdate.mockReturnValueOnce(chain([{ rescheduleCount: 1 }]));

// Call function
const result = await executeReschedule({
  client: makeClient({
    reschedule: vi.fn().mockResolvedValue(true),
    getCurrentAppointment: vi.fn().mockResolvedValue({ consularDate: '2026-04-09', ... }),
  }),
  botId: 41,
  bot: BASE_BOT,
  dateExclusions: [],
  timeExclusions: [],
  preFetchedDays: [{ date: '2026-04-09', business_day: true }],
  dryRun: false,
  pending: [],
});

// Verify result
expect(result.success).toBe(true);
expect(result.date).toBe('2026-04-09');
expect(result.falsePositiveDates).toContain('2026-04-09');
```

**Fake Timers:**
```typescript
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);  // NOW = new Date('2026-04-03T12:00:00Z')
});

it('uses NOW for timestamps in log entries', async () => {
  // Test code that captures timestamps
  expect(capturedTimestamp).toEqual(NOW);
});
```

**DB Mock Cleanup:**
```typescript
beforeEach(() => {
  vi.clearAllMocks();
  setupDbMocks();  // Custom helper
});

function setupDbMocks(currentDate = '2026-05-04') {
  mockDbSelect.mockReturnValue(chain([{ currentConsularDate: currentDate }]));
  mockDbInsert.mockReturnValue(chain([]));
  mockDbUpdate
    .mockReturnValueOnce(chain([{ rescheduleCount: 1 }]))
    .mockReturnValue(chain([]));
}
```

---

*Testing analysis: 2026-04-06*

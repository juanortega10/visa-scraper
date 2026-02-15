/**
 * Measures _yatri_session cookie TTL using the session already in DB.
 * Two modes:
 *   --mode=active   (default) Refreshes cookie on each poll (simulates real usage)
 *   --mode=stale    Uses the ORIGINAL cookie every time (measures idle expiry)
 *
 * Usage:
 *   npm run session-test                           # active mode, bot 5
 *   npm run session-test -- --bot-id=5 --mode=stale
 *   npm run session-test -- --interval=5           # poll every 5 min
 *
 * Requires: active session in DB (run `npm run login` first).
 * IMPORTANT: Stop monitor-availability cron before running in stale mode,
 * otherwise the monitor refreshes the cookie every 5 min.
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { USER_AGENT, getBaseUrl } from '../src/utils/constants.js';
import { eq } from 'drizzle-orm';

const args = process.argv;
const botId = parseInt(args.find(a => a.startsWith('--bot-id='))?.split('=')[1] ?? '5', 10);
const mode = (args.find(a => a.startsWith('--mode='))?.split('=')[1] ?? 'active') as 'active' | 'stale';
const intervalMin = parseInt(args.find(a => a.startsWith('--interval='))?.split('=')[1] ?? '10', 10);

const INTERVAL_MS = intervalMin * 60 * 1000;
const MAX_ITERATIONS = Math.ceil((24 * 60) / intervalMin); // up to 24h

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface TestResult {
  alive: boolean;
  status: number;
  newCookie: string;
  csrfOk: boolean;
}

async function testSession(
  cookie: string,
  csrfToken: string,
  scheduleId: string,
  facilityId: string,
): Promise<TestResult> {
  // Test 1: JSON API with all headers (the real poll scenario)
  const resp = await fetch(
    `${getBaseUrl()}/schedule/${scheduleId}/appointment/days/${facilityId}.json?appointments[expedite]=false`,
    {
      headers: {
        Cookie: `_yatri_session=${cookie}`,
        'X-CSRF-Token': csrfToken,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'User-Agent': USER_AGENT,
        Referer: `${getBaseUrl()}/schedule/${scheduleId}/appointment`,
      },
      redirect: 'manual',
    },
  );

  let newCookie = cookie;
  const setCookie = resp.headers.get('set-cookie');
  if (setCookie) {
    const match = setCookie.match(/_yatri_session=([^;]+)/);
    if (match?.[1]) newCookie = match[1];
  }

  const alive = resp.status === 200;

  // If alive, also test if CSRF token still works by checking we got valid JSON
  let csrfOk = false;
  if (alive) {
    try {
      const data = await resp.json() as unknown[];
      csrfOk = Array.isArray(data);
    } catch {
      csrfOk = false;
    }
  }

  return { alive, status: resp.status, newCookie, csrfOk };
}

async function refreshCsrf(
  cookie: string,
  scheduleId: string,
  applicantIds: string[],
): Promise<{ csrfToken: string; authenticityToken: string; newCookie: string }> {
  const qs = applicantIds.map(id => `applicants[]=${id}`).join('&');
  const url = `${getBaseUrl()}/schedule/${scheduleId}/appointment?${qs}&confirmed_limit_message=1&commit=Continuar`;

  const resp = await fetch(url, {
    headers: {
      Cookie: `_yatri_session=${cookie}`,
      'User-Agent': USER_AGENT,
    },
    redirect: 'manual',
  });

  let newCookie = cookie;
  const setCookie = resp.headers.get('set-cookie');
  if (setCookie) {
    const match = setCookie.match(/_yatri_session=([^;]+)/);
    if (match?.[1]) newCookie = match[1];
  }

  if (resp.status !== 200) {
    throw new Error(`CSRF refresh failed: HTTP ${resp.status}`);
  }

  const html = await resp.text();
  const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  const authMatch = html.match(/<input[^>]+name="authenticity_token"[^>]+value="([^"]+)"/);

  return {
    csrfToken: csrfMatch?.[1] ?? '',
    authenticityToken: authMatch?.[1] ?? '',
    newCookie,
  };
}

async function main() {
  console.log('=== Session Duration Test ===');
  console.log(`Bot: ${botId} | Mode: ${mode} | Interval: ${intervalMin}min | Max: ${MAX_ITERATIONS} iterations`);
  console.log(`${mode === 'stale' ? 'WARNING: Using original cookie every time (no refresh)' : 'Refreshing cookie on each successful poll'}`);
  console.log();

  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) { console.error(`Bot ${botId} not found`); process.exit(1); }

  const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));
  if (!session) { console.error(`No session for bot ${botId}. Run: npm run login`); process.exit(1); }

  const originalCookie = decrypt(session.yatriCookie);
  const originalCsrf = session.csrfToken ?? '';
  const originalAuth = session.authenticityToken ?? '';

  let currentCookie = originalCookie;
  let currentCsrf = originalCsrf;

  const startTime = Date.now();
  console.log(`Start: ${new Date().toISOString()}`);
  console.log(`Cookie: ${originalCookie.substring(0, 30)}...`);
  console.log(`CSRF: ${originalCsrf.substring(0, 30)}...`);
  console.log();

  // Initial test right away
  const initial = await testSession(currentCookie, currentCsrf, bot.scheduleId, bot.consularFacilityId);
  console.log(`[0] ${new Date().toISOString()} | 0m | HTTP ${initial.status} | ${initial.alive ? 'ALIVE' : 'EXPIRED'} | CSRF: ${initial.csrfOk ? 'OK' : 'FAIL'}`);

  if (!initial.alive) {
    console.log('\nSession already expired! Run: npm run login');
    process.exit(1);
  }

  if (mode === 'active') {
    currentCookie = initial.newCookie;
  }

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    await sleep(INTERVAL_MS);

    const elapsed = Math.round((Date.now() - startTime) / 1000 / 60);
    const testCookie = mode === 'stale' ? originalCookie : currentCookie;
    const testCsrf = mode === 'stale' ? originalCsrf : currentCsrf;

    const result = await testSession(testCookie, testCsrf, bot.scheduleId, bot.consularFacilityId);
    const cookieChanged = result.newCookie !== testCookie;

    console.log(
      `[${i}] ${new Date().toISOString()} | ${elapsed}m | HTTP ${result.status} | ${result.alive ? 'ALIVE' : 'EXPIRED'} | CSRF: ${result.csrfOk ? 'OK' : 'FAIL'} | cookie rotated: ${cookieChanged}`,
    );

    if (!result.alive) {
      console.log(`\n>>> SESSION EXPIRED after ${elapsed} minutes (${(elapsed / 60).toFixed(1)} hours)`);
      console.log(`>>> Mode: ${mode}`);
      console.log(`>>> Last status: HTTP ${result.status}`);
      break;
    }

    if (mode === 'active') {
      currentCookie = result.newCookie;
      // Refresh CSRF every 30 min in active mode (tokens rotate per page load)
      if (i % Math.max(1, Math.floor(30 / intervalMin)) === 0) {
        try {
          const fresh = await refreshCsrf(currentCookie, bot.scheduleId, bot.applicantIds);
          currentCookie = fresh.newCookie;
          currentCsrf = fresh.csrfToken;
          console.log(`  [CSRF refreshed] new token: ${currentCsrf.substring(0, 20)}...`);
        } catch (e) {
          console.log(`  [CSRF refresh failed] ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  }

  const totalMin = Math.round((Date.now() - startTime) / 1000 / 60);
  console.log(`\nTest complete. Total: ${totalMin}min (${(totalMin / 60).toFixed(1)}h)`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});

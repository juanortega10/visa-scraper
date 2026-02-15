/**
 * Measures session IDLE timeout — how long can a cookie survive WITHOUT being used?
 *
 * Strategy: Login once, then wait increasing gaps before each single test.
 * Gap sequence: 15m, 30m, 1h, 2h, 4h (cumulative: 15m, 45m, 1h45m, 3h45m, 7h45m)
 *
 * Each test does ONE request with the original cookie (no refresh).
 * If it dies, we know the idle timeout is between the last success gap and this one.
 *
 * Usage:
 *   npm run session-idle-test -- --bot-id=5
 *   npm run session-idle-test -- --bot-id=5 --gaps=15,30,60,120,240
 *
 * Requires: active session in DB (run `npm run login` first).
 * IMPORTANT: Do NOT run any other process that uses this session while this test runs.
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { USER_AGENT, getBaseUrl } from '../src/utils/constants.js';
import { eq } from 'drizzle-orm';

const args = process.argv;
const botId = parseInt(args.find(a => a.startsWith('--bot-id='))?.split('=')[1] ?? '5', 10);
const gapsArg = args.find(a => a.startsWith('--gaps='))?.split('=')[1];
const gaps = gapsArg
  ? gapsArg.split(',').map(Number)
  : [15, 30, 60, 120, 240]; // minutes between checks

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function fmtDuration(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

async function testOnce(
  cookie: string,
  csrfToken: string,
  scheduleId: string,
  facilityId: string,
): Promise<{ alive: boolean; status: number }> {
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

  return { alive: resp.status === 200, status: resp.status };
}

async function main() {
  console.log('=== Session IDLE Timeout Test ===');
  console.log(`Bot: ${botId}`);
  console.log(`Gap sequence: ${gaps.map(g => `${g}m`).join(' → ')}`);

  let cumulative = 0;
  for (const g of gaps) {
    cumulative += g;
  }
  console.log(`Total test duration: ~${fmtDuration(cumulative * 60000)}`);
  console.log();

  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) { console.error(`Bot ${botId} not found`); process.exit(1); }

  const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));
  if (!session) { console.error(`No session. Run: npm run login`); process.exit(1); }

  const cookie = decrypt(session.yatriCookie);
  const csrf = session.csrfToken ?? '';

  // Verify session is alive right now
  const initial = await testOnce(cookie, csrf, bot.scheduleId, bot.consularFacilityId);
  const startTime = Date.now();
  console.log(`[START] ${new Date().toISOString()} | HTTP ${initial.status} | ${initial.alive ? 'ALIVE' : 'DEAD'}`);

  if (!initial.alive) {
    console.log('Session already dead! Run: npm run login');
    process.exit(1);
  }

  let totalElapsed = 0;
  let lastAliveAt = 0;

  for (let i = 0; i < gaps.length; i++) {
    const gap = gaps[i]!;
    totalElapsed += gap;

    console.log(`\n--- Waiting ${gap}m (total idle: ${fmtDuration(totalElapsed * 60000)}) ---`);

    // Countdown every 5 min so you know it's not stuck
    let waited = 0;
    while (waited < gap) {
      const chunk = Math.min(5, gap - waited);
      await sleep(chunk * 60000);
      waited += chunk;
      if (waited < gap) {
        console.log(`  ... ${gap - waited}m remaining`);
      }
    }

    const result = await testOnce(cookie, csrf, bot.scheduleId, bot.consularFacilityId);
    const elapsed = fmtDuration(totalElapsed * 60000);

    console.log(`[CHECK ${i + 1}/${gaps.length}] ${new Date().toISOString()} | idle: ${elapsed} | HTTP ${result.status} | ${result.alive ? 'ALIVE' : 'EXPIRED'}`);

    if (result.alive) {
      lastAliveAt = totalElapsed;
    } else {
      console.log(`\n>>> SESSION EXPIRED`);
      console.log(`>>> Idle timeout is between ${fmtDuration(lastAliveAt * 60000)} and ${elapsed}`);
      console.log(`>>> The cookie survived ${fmtDuration(lastAliveAt * 60000)} of idle time`);
      process.exit(0);
    }
  }

  console.log(`\n>>> SESSION STILL ALIVE after ${fmtDuration(totalElapsed * 60000)} of idle time`);
  console.log(`>>> Idle timeout is > ${fmtDuration(totalElapsed * 60000)}`);
  console.log('>>> Consider running again with larger gaps');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});

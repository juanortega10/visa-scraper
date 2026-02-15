/**
 * Rate Limit Experiment: determine if rate limiting is per-IP only or per-IP+account.
 *
 * Runs from the RPi at night (02:00-03:00 Bogota recommended).
 * Tests increasing request frequencies with 1 and 2 accounts to compare thresholds.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/rate-limit-experiment.ts [--phase=1|2|3|all]
 *
 * Phases:
 *   1: Single account (bot 6) — escalate frequency until issues
 *   2: Two accounts interleaved (bot 6 + bot 7) — same total freq as phase 1
 *   3: Two accounts interleaved — double total freq
 *
 * If phase 1 breaks at X req/min and phase 2 survives at X req/min total:
 *   → Rate limit is per account (not shared per IP)
 * If both break at the same total req/min:
 *   → Rate limit is per IP (shared across accounts)
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';
import { eq, desc } from 'drizzle-orm';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl } from '../src/utils/constants.js';

// ── Config ──────────────────────────────────────────────
const BOT_A_ID = 6;  // Colombia (es-co, facility 25)
const BOT_B_ID = 7;  // Peru (es-pe, facility 115)

// Frequency steps: interval in seconds between requests
// ~6h total: 3 phases × ~2h each. Each step = 20 requests + 60s cooldown.
const FREQ_STEPS = [120, 90, 60, 45, 30, 20, 15, 10, 7, 5];
const REQUESTS_PER_STEP = 20;  // more requests per level for statistical significance
const COOLDOWN_BETWEEN_STEPS = 60_000; // 60s cooldown between steps to let things settle

interface AccountSession {
  botId: number;
  locale: string;
  scheduleId: string;
  consularFacilityId: string;
  cookie: string;
  csrfToken: string;
  label: string;
}

// ── Helpers ─────────────────────────────────────────────

async function loadSession(botId: number): Promise<AccountSession> {
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) throw new Error(`Bot ${botId} not found`);

  const email = decrypt(bot.visaEmail);
  const locale = bot.locale ?? 'es-co';

  const [existing] = await db.select().from(sessions)
    .where(eq(sessions.botId, botId))
    .orderBy(desc(sessions.createdAt))
    .limit(1);

  const sessionAge = existing ? (Date.now() - existing.createdAt.getTime()) / 60000 : Infinity;

  let cookie: string, csrfToken: string;

  if (existing && sessionAge < 40) {
    console.log(`  Bot ${botId}: reusing session (${Math.round(sessionAge)}min old)`);
    cookie = decrypt(existing.yatriCookie);
    csrfToken = existing.csrfToken ?? '';
  } else {
    console.log(`  Bot ${botId}: logging in as ${email}...`);
    const result = await performLogin({
      email, password: decrypt(bot.visaPassword),
      scheduleId: bot.scheduleId,
      applicantIds: bot.applicantIds,
      locale,
    });
    cookie = result.cookie;
    csrfToken = result.csrfToken;
  }

  return {
    botId, locale,
    scheduleId: bot.scheduleId,
    consularFacilityId: bot.consularFacilityId,
    cookie, csrfToken,
    label: `Bot${botId}(${locale})`,
  };
}

interface FetchResult {
  account: string;
  status: number;
  datesCount: number | null;
  latencyMs: number;
  error: string | null;
  isHealthy: boolean;  // 200 + JSON array with dates
  isSoftBan: boolean;  // 200 + empty array or very few dates
  isTcpError: boolean; // ECONNREFUSED / ECONNRESET
  isRedirect: boolean; // 302/401 (session issue)
}

async function fetchDays(acct: AccountSession): Promise<FetchResult> {
  const baseUrl = getBaseUrl(acct.locale);
  const url = `${baseUrl}/schedule/${acct.scheduleId}/appointment/days/${acct.consularFacilityId}.json?appointments[expedite]=false`;
  const start = Date.now();

  try {
    const resp = await fetch(url, {
      headers: {
        Cookie: `_yatri_session=${acct.cookie}`,
        'X-CSRF-Token': acct.csrfToken,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'User-Agent': USER_AGENT,
        Referer: `${baseUrl}/schedule/${acct.scheduleId}/appointment`,
        ...BROWSER_HEADERS,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });

    const latencyMs = Date.now() - start;
    const contentType = resp.headers.get('content-type') ?? '';

    if (resp.status !== 200) {
      await resp.text().catch(() => {});
      return {
        account: acct.label, status: resp.status, datesCount: null, latencyMs,
        error: `HTTP ${resp.status}`, isHealthy: false,
        isSoftBan: false, isTcpError: false, isRedirect: resp.status === 302 || resp.status === 401,
      };
    }

    const text = await resp.text();
    if (!contentType.includes('json')) {
      return {
        account: acct.label, status: resp.status, datesCount: null, latencyMs,
        error: 'HTML response (not JSON)', isHealthy: false,
        isSoftBan: true, isTcpError: false, isRedirect: false,
      };
    }

    const data = JSON.parse(text);
    const count = Array.isArray(data) ? data.length : null;

    return {
      account: acct.label, status: 200, datesCount: count, latencyMs,
      error: null, isHealthy: count !== null && count > 0,
      isSoftBan: count === 0, isTcpError: false, isRedirect: false,
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    const isTcp = msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT');
    return {
      account: acct.label, status: 0, datesCount: null, latencyMs,
      error: msg.slice(0, 100), isHealthy: false,
      isSoftBan: false, isTcpError: isTcp, isRedirect: false,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtTime(): string {
  return new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour12: false });
}

// ── Phase runners ───────────────────────────────────────

interface StepResult {
  phase: string;
  intervalSec: number;
  totalReqs: number;
  healthy: number;
  softBan: number;
  tcpError: number;
  redirects: number;
  errors: number;
  avgLatencyMs: number;
  brokeAt: string | null;  // description of first issue
}

async function runStep(
  accounts: AccountSession[],
  intervalSec: number,
  label: string,
): Promise<StepResult> {
  const results: FetchResult[] = [];
  let accountIdx = 0;
  let brokeAt: string | null = null;
  let consecutiveIssues = 0;

  console.log(`\n  [${fmtTime()}] ${label}: ${intervalSec}s interval, ${REQUESTS_PER_STEP} requests (${accounts.length} account(s))`);

  for (let i = 0; i < REQUESTS_PER_STEP; i++) {
    const acct = accounts[accountIdx % accounts.length]!;
    accountIdx++;

    const r = await fetchDays(acct);
    results.push(r);

    const statusIcon = r.isHealthy ? '✓' : r.isSoftBan ? '⚠' : r.isTcpError ? '✗TCP' : r.isRedirect ? '→302' : '✗';
    const datesStr = r.datesCount !== null ? `${r.datesCount}d` : '-';
    console.log(`    #${String(i + 1).padStart(2)} ${acct.label.padEnd(16)} ${statusIcon.padEnd(6)} ${datesStr.padEnd(6)} ${r.latencyMs}ms${r.error ? ` [${r.error}]` : ''}`);

    // Track consecutive issues
    if (!r.isHealthy) {
      consecutiveIssues++;
      if (consecutiveIssues >= 3 && !brokeAt) {
        brokeAt = `3 consecutive issues at req #${i + 1} (${r.error || 'unhealthy'})`;
      }
    } else {
      consecutiveIssues = 0;
    }

    // Abort early if clearly broken
    if (consecutiveIssues >= 5) {
      console.log(`    ⛔ 5 consecutive issues — aborting step`);
      brokeAt = brokeAt || `5 consecutive issues at req #${i + 1}`;
      break;
    }

    // Wait interval (except after last request)
    if (i < REQUESTS_PER_STEP - 1) {
      await sleep(intervalSec * 1000);
    }
  }

  const healthy = results.filter((r) => r.isHealthy).length;
  const softBan = results.filter((r) => r.isSoftBan).length;
  const tcpError = results.filter((r) => r.isTcpError).length;
  const redirects = results.filter((r) => r.isRedirect).length;
  const errors = results.length - healthy - softBan;
  const avgLatency = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length);

  return {
    phase: label, intervalSec, totalReqs: results.length,
    healthy, softBan, tcpError, redirects, errors: errors - tcpError - redirects,
    avgLatencyMs: avgLatency, brokeAt,
  };
}

// ── Main ────────────────────────────────────────────────

async function main() {
  const phaseArg = process.argv.find((a) => a.startsWith('--phase='))?.split('=')[1] ?? 'all';
  const runPhases = phaseArg === 'all' ? [1, 2, 3] : [parseInt(phaseArg)];

  console.log('═══════════════════════════════════════════════════════');
  console.log('  Rate Limit Experiment');
  console.log(`  Started: ${fmtTime()} Bogota`);
  console.log(`  Phases: ${runPhases.join(', ')}`);
  console.log('═══════════════════════════════════════════════════════\n');

  console.log('[Setup] Loading sessions...');
  const acctA = await loadSession(BOT_A_ID);
  const acctB = await loadSession(BOT_B_ID);
  console.log(`  A: ${acctA.label} (schedule ${acctA.scheduleId}, facility ${acctA.consularFacilityId})`);
  console.log(`  B: ${acctB.label} (schedule ${acctB.scheduleId}, facility ${acctB.consularFacilityId})`);

  const allResults: StepResult[] = [];

  // ── Phase 1: Single account, escalating frequency ─────
  if (runPhases.includes(1)) {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  PHASE 1: Single account (Bot A) — escalating frequency');
    console.log('  Baseline: at what total req/min does ONE account break?');
    console.log('═══════════════════════════════════════════════════════');

    for (const interval of FREQ_STEPS) {
      const result = await runStep([acctA], interval, `P1-single-${interval}s`);
      allResults.push(result);

      if (result.brokeAt) {
        console.log(`\n  ⛔ Phase 1 broke at ${interval}s interval: ${result.brokeAt}`);
        console.log(`  Cooldown 60s before next phase...`);
        await sleep(60_000);
        break;
      }

      console.log(`  ✓ ${interval}s OK — cooling down ${COOLDOWN_BETWEEN_STEPS / 1000}s`);
      await sleep(COOLDOWN_BETWEEN_STEPS);
    }
  }

  // ── Phase 2: Two accounts interleaved, SAME total frequency ──
  if (runPhases.includes(2)) {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  PHASE 2: Two accounts interleaved — SAME total freq');
    console.log('  If phase 1 broke at Xs, test both accounts at 2Xs each');
    console.log('  (same total requests from IP, split across accounts)');
    console.log('═══════════════════════════════════════════════════════');

    // Find where phase 1 broke (or use all steps)
    const p1Broke = allResults.find((r) => r.phase.startsWith('P1-') && r.brokeAt);
    const startInterval = p1Broke ? p1Broke.intervalSec : FREQ_STEPS[FREQ_STEPS.length - 1]!;
    // Start from one step before the breaking point
    const startIdx = Math.max(0, FREQ_STEPS.indexOf(startInterval) - 1);

    for (let i = startIdx; i < FREQ_STEPS.length; i++) {
      const interval = FREQ_STEPS[i]!;
      // Each account gets a request every `interval` seconds, but interleaved
      // So total from IP = 1 request every `interval/2` seconds
      const result = await runStep([acctA, acctB], interval, `P2-interleaved-${interval}s`);
      allResults.push(result);

      if (result.brokeAt) {
        console.log(`\n  ⛔ Phase 2 broke at ${interval}s interval (${interval / 2}s effective per IP): ${result.brokeAt}`);
        console.log(`  Cooldown 60s...`);
        await sleep(60_000);
        break;
      }

      console.log(`  ✓ ${interval}s OK — cooling down ${COOLDOWN_BETWEEN_STEPS / 1000}s`);
      await sleep(COOLDOWN_BETWEEN_STEPS);
    }
  }

  // ── Phase 3: Two accounts interleaved, DOUBLE total frequency ──
  if (runPhases.includes(3)) {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  PHASE 3: Two accounts interleaved — DOUBLE total freq');
    console.log('  Both accounts at the SAME per-account rate as phase 1');
    console.log('  (2x total requests from IP vs phase 1)');
    console.log('═══════════════════════════════════════════════════════');

    for (const interval of FREQ_STEPS) {
      // interval/2 between each request (alternating accounts)
      // so each account gets hit every `interval` seconds
      // but total from IP = every `interval/2` seconds
      const effectiveInterval = Math.max(3, Math.round(interval / 2));
      const result = await runStep([acctA, acctB], effectiveInterval, `P3-double-${interval}s-per-acct`);
      allResults.push(result);

      if (result.brokeAt) {
        console.log(`\n  ⛔ Phase 3 broke at ${effectiveInterval}s interval (${interval}s per-account): ${result.brokeAt}`);
        await sleep(60_000);
        break;
      }

      console.log(`  ✓ ${effectiveInterval}s effective OK — cooling down ${COOLDOWN_BETWEEN_STEPS / 1000}s`);
      await sleep(COOLDOWN_BETWEEN_STEPS);
    }
  }

  // ── Summary ───────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════════════\n');

  const colW = [28, 6, 4, 5, 3, 3, 3, 6, 30];
  console.log(`  ${'Phase'.padEnd(colW[0]!)} ${'Int'.padStart(colW[1]!)} ${'Req'.padStart(colW[2]!)} ${'OK'.padStart(colW[3]!)} ${'SB'.padStart(colW[4]!)} ${'TCP'.padStart(colW[5]!)} ${'302'.padStart(colW[6]!)} ${'AvgMs'.padStart(colW[7]!)} Broke?`);
  console.log(`  ${'─'.repeat(colW[0]!)} ${'─'.repeat(colW[1]!)} ${'─'.repeat(colW[2]!)} ${'─'.repeat(colW[3]!)} ${'─'.repeat(colW[4]!)} ${'─'.repeat(colW[5]!)} ${'─'.repeat(colW[6]!)} ${'─'.repeat(colW[7]!)} ${'─'.repeat(colW[8]!)}`);

  for (const r of allResults) {
    const ok = `${r.healthy}/${r.totalReqs}`;
    console.log(`  ${r.phase.padEnd(colW[0]!)} ${String(r.intervalSec + 's').padStart(colW[1]!)} ${String(r.totalReqs).padStart(colW[2]!)} ${ok.padStart(colW[3]!)} ${String(r.softBan).padStart(colW[4]!)} ${String(r.tcpError).padStart(colW[5]!)} ${String(r.redirects).padStart(colW[6]!)} ${String(r.avgLatencyMs).padStart(colW[7]!)} ${r.brokeAt || '—'}`);
  }

  // ── Analysis ──────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  ANALYSIS');
  console.log('═══════════════════════════════════════════════════════\n');

  const p1Broke = allResults.find((r) => r.phase.startsWith('P1-') && r.brokeAt);
  const p2Broke = allResults.find((r) => r.phase.startsWith('P2-') && r.brokeAt);
  const p3Broke = allResults.find((r) => r.phase.startsWith('P3-') && r.brokeAt);

  if (p1Broke) {
    console.log(`  Phase 1 (single account) broke at: ${p1Broke.intervalSec}s interval`);
    console.log(`    = ${(60 / p1Broke.intervalSec).toFixed(1)} req/min from IP`);
  } else {
    console.log('  Phase 1 (single account): survived all intervals!');
  }

  if (p2Broke) {
    console.log(`  Phase 2 (2 accounts, same total) broke at: ${p2Broke.intervalSec}s interval`);
    console.log(`    = ${(60 / p2Broke.intervalSec).toFixed(1)} req/min total, ${(60 / p2Broke.intervalSec / 2).toFixed(1)} per account`);
  } else if (runPhases.includes(2)) {
    console.log('  Phase 2 (2 accounts, same total): survived all intervals!');
  }

  if (p3Broke) {
    const perAcctInterval = p3Broke.intervalSec * 2;
    console.log(`  Phase 3 (2 accounts, double total) broke at: ${p3Broke.intervalSec}s effective (${perAcctInterval}s per-account)`);
    console.log(`    = ${(60 / p3Broke.intervalSec).toFixed(1)} req/min total from IP`);
  } else if (runPhases.includes(3)) {
    console.log('  Phase 3 (2 accounts, double total): survived all intervals!');
  }

  console.log('');
  if (p1Broke && !p2Broke) {
    console.log('  CONCLUSION: Rate limit is likely PER ACCOUNT (not per IP).');
    console.log('  → 2 accounts can poll at full speed independently from the same IP.');
  } else if (p1Broke && p2Broke && p1Broke.intervalSec === p2Broke.intervalSec) {
    console.log('  CONCLUSION: Rate limit is likely PER IP (shared across accounts).');
    console.log('  → 2 bots on same IP share the same request budget.');
  } else if (p1Broke && p3Broke) {
    const p1Rate = 60 / p1Broke.intervalSec;
    const p3Rate = 60 / p3Broke.intervalSec;
    if (Math.abs(p1Rate - p3Rate) < 2) {
      console.log('  CONCLUSION: Rate limit is PER IP — both phases broke at similar total rate.');
    } else {
      console.log('  CONCLUSION: Mixed signals — rate limit may have per-account AND per-IP components.');
    }
  } else {
    console.log('  CONCLUSION: No clear breaking point found — rates tested are within safe limits.');
  }

  console.log(`\n  Finished: ${fmtTime()} Bogota\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

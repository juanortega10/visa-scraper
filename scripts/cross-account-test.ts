/**
 * Cross-account experiment: test what can be shared between two different
 * usvisa-info.com accounts (cookies, CSRF tokens, schedule access).
 *
 * Usage:
 *   npx tsx scripts/cross-account-test.ts --bot-a=6 --bot-b=<ID>
 *
 * Both bots must exist in the DB with valid encrypted credentials.
 * Uses direct fetch (no proxy) to isolate variables.
 *
 * Experiments:
 *   1. Cross-account days fetch (cookie A → scheduleId B)
 *   2. Cross-account groups page (cookie A → userId B)
 *   3. Cross-token swap (CSRF A + cookie B)
 *   4. Cross-account reschedule page (cookie A → appointment page B) [read-only]
 *   5. Cross-embassy (different locale/facility — only if bots have different locales)
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import { eq, desc } from 'drizzle-orm';

interface BotInfo {
  id: number;
  email: string;
  scheduleId: string;
  applicantIds: string[];
  consularFacilityId: string;
  ascFacilityId: string;
  userId: string | null;
  locale: string;
  cookie: string;
  csrfToken: string;
  authenticityToken: string;
}

async function loadBot(botId: number): Promise<BotInfo> {
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) throw new Error(`Bot ${botId} not found`);

  const email = decrypt(bot.visaEmail);
  const password = decrypt(bot.visaPassword);
  const locale = bot.locale ?? 'es-co';

  // Try to use existing session first
  const [existing] = await db.select().from(sessions)
    .where(eq(sessions.botId, botId))
    .orderBy(desc(sessions.createdAt))
    .limit(1);

  const sessionAge = existing ? (Date.now() - existing.createdAt.getTime()) / 60000 : Infinity;

  let cookie: string, csrfToken: string, authenticityToken: string;

  if (existing && sessionAge < 60) {
    console.log(`  Bot ${botId}: reusing session (${Math.round(sessionAge)}min old)`);
    cookie = decrypt(existing.yatriCookie);
    csrfToken = existing.csrfToken ?? '';
    authenticityToken = existing.authenticityToken ?? '';

    // If missing tokens, refresh them
    if (!csrfToken || !authenticityToken) {
      console.log(`  Bot ${botId}: refreshing tokens...`);
      const client = new VisaClient(
        { cookie, csrfToken, authenticityToken },
        { scheduleId: bot.scheduleId, applicantIds: bot.applicantIds, consularFacilityId: bot.consularFacilityId, ascFacilityId: bot.ascFacilityId ?? '26', proxyProvider: 'direct', userId: bot.userId, locale },
      );
      await client.refreshTokens();
      const s = client.getSession();
      cookie = s.cookie;
      csrfToken = s.csrfToken;
      authenticityToken = s.authenticityToken;
    }
  } else {
    console.log(`  Bot ${botId}: logging in as ${email}...`);
    const result = await performLogin({
      email, password,
      scheduleId: bot.scheduleId,
      applicantIds: bot.applicantIds,
      locale,
    });
    cookie = result.cookie;
    csrfToken = result.csrfToken;
    authenticityToken = result.authenticityToken;
  }

  return {
    id: botId,
    email,
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    consularFacilityId: bot.consularFacilityId,
    ascFacilityId: bot.ascFacilityId ?? '26',
    userId: bot.userId,
    locale,
    cookie,
    csrfToken,
    authenticityToken,
  };
}

// ── Experiment helpers ─────────────────────────────────

async function fetchDays(cookie: string, csrfToken: string, scheduleId: string, facilityId: string, locale: string): Promise<{ status: number; body: unknown; contentType: string }> {
  const { USER_AGENT, BROWSER_HEADERS, getBaseUrl } = await import('../src/utils/constants.js');
  const baseUrl = getBaseUrl(locale);
  const url = `${baseUrl}/schedule/${scheduleId}/appointment/days/${facilityId}.json?appointments[expedite]=false`;

  const resp = await fetch(url, {
    headers: {
      Cookie: `_yatri_session=${cookie}`,
      'X-CSRF-Token': csrfToken,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'User-Agent': USER_AGENT,
      Referer: `${baseUrl}/schedule/${scheduleId}/appointment`,
      ...BROWSER_HEADERS,
    },
    redirect: 'manual',
  });

  const contentType = resp.headers.get('content-type') ?? '';
  let body: unknown;
  try {
    const text = await resp.text();
    body = contentType.includes('json') ? JSON.parse(text) : text.slice(0, 200);
  } catch { body = '<read error>'; }

  return { status: resp.status, body, contentType };
}

async function fetchGroupsPage(cookie: string, userId: string, locale: string): Promise<{ status: number; hasConsularAppt: boolean; snippet: string }> {
  const { USER_AGENT, BROWSER_HEADERS, getBaseUrl } = await import('../src/utils/constants.js');
  const baseUrl = getBaseUrl(locale);
  const url = `${baseUrl}/groups/${userId}`;

  const resp = await fetch(url, {
    headers: {
      Cookie: `_yatri_session=${cookie}`,
      'User-Agent': USER_AGENT,
      Accept: 'text/html',
      ...BROWSER_HEADERS,
    },
    redirect: 'manual',
  });

  if (resp.status !== 200) {
    await resp.text().catch(() => {});
    return { status: resp.status, hasConsularAppt: false, snippet: `Redirect to: ${resp.headers.get('location') ?? 'N/A'}` };
  }

  const html = await resp.text();
  const hasConsularAppt = html.includes('consular-appt');
  const snippet = html.slice(0, 300).replace(/\s+/g, ' ');
  return { status: resp.status, hasConsularAppt, snippet };
}

// ── Main ───────────────────────────────────────────────

async function main() {
  const argA = process.argv.find((a) => a.startsWith('--bot-a='));
  const argB = process.argv.find((a) => a.startsWith('--bot-b='));

  if (!argA || !argB) {
    console.error('Usage: npx tsx scripts/cross-account-test.ts --bot-a=6 --bot-b=<ID>');
    process.exit(1);
  }

  const botAId = parseInt(argA.split('=')[1]!, 10);
  const botBId = parseInt(argB.split('=')[1]!, 10);

  console.log('═══════════════════════════════════════════════════');
  console.log('  Cross-Account Experiment');
  console.log('═══════════════════════════════════════════════════\n');

  console.log('[1/2] Loading accounts...');
  const botA = await loadBot(botAId);
  const botB = await loadBot(botBId);

  console.log(`\n  Bot A (#${botA.id}): ${botA.email} — schedule ${botA.scheduleId}, userId ${botA.userId}, locale ${botA.locale}`);
  console.log(`  Bot B (#${botB.id}): ${botB.email} — schedule ${botB.scheduleId}, userId ${botB.userId}, locale ${botB.locale}`);

  const results: { test: string; result: string; details: string }[] = [];

  // ── Experiment 1: Cross-account days fetch ──────────
  console.log('\n───────────────────────────────────────────────────');
  console.log('  Experiment 1: Cross-account days fetch');
  console.log('  Cookie A → scheduleId B (and vice versa)');
  console.log('───────────────────────────────────────────────────\n');

  // Baseline: own cookie → own schedule
  console.log('  [baseline] A→A ...');
  const aa = await fetchDays(botA.cookie, botA.csrfToken, botA.scheduleId, botA.consularFacilityId, botA.locale);
  console.log(`    Status: ${aa.status}, Type: ${aa.contentType}, Dates: ${Array.isArray(aa.body) ? (aa.body as unknown[]).length : 'N/A'}`);
  results.push({ test: 'Days A→A (baseline)', result: aa.status === 200 ? 'OK' : `FAIL (${aa.status})`, details: `${Array.isArray(aa.body) ? (aa.body as unknown[]).length + ' dates' : String(aa.body).slice(0, 80)}` });

  console.log('  [baseline] B→B ...');
  const bb = await fetchDays(botB.cookie, botB.csrfToken, botB.scheduleId, botB.consularFacilityId, botB.locale);
  console.log(`    Status: ${bb.status}, Type: ${bb.contentType}, Dates: ${Array.isArray(bb.body) ? (bb.body as unknown[]).length : 'N/A'}`);
  results.push({ test: 'Days B→B (baseline)', result: bb.status === 200 ? 'OK' : `FAIL (${bb.status})`, details: `${Array.isArray(bb.body) ? (bb.body as unknown[]).length + ' dates' : String(bb.body).slice(0, 80)}` });

  // Cross: A's cookie → B's scheduleId
  console.log('  [cross] A→B (cookie A, schedule B) ...');
  const ab = await fetchDays(botA.cookie, botA.csrfToken, botB.scheduleId, botB.consularFacilityId, botA.locale);
  console.log(`    Status: ${ab.status}, Type: ${ab.contentType}, Dates: ${Array.isArray(ab.body) ? (ab.body as unknown[]).length : 'N/A'}`);
  const abMatch = Array.isArray(ab.body) && Array.isArray(bb.body) && JSON.stringify(ab.body) === JSON.stringify(bb.body);
  results.push({ test: 'Days A→B (cross)', result: ab.status === 200 ? `OK${abMatch ? ' (SAME data as B→B)' : ' (DIFFERENT data)'}` : `BLOCKED (${ab.status})`, details: `${Array.isArray(ab.body) ? (ab.body as unknown[]).length + ' dates' : String(ab.body).slice(0, 80)}` });

  // Cross: B's cookie → A's scheduleId
  console.log('  [cross] B→A (cookie B, schedule A) ...');
  const ba = await fetchDays(botB.cookie, botB.csrfToken, botA.scheduleId, botA.consularFacilityId, botB.locale);
  console.log(`    Status: ${ba.status}, Type: ${ba.contentType}, Dates: ${Array.isArray(ba.body) ? (ba.body as unknown[]).length : 'N/A'}`);
  const baMatch = Array.isArray(ba.body) && Array.isArray(aa.body) && JSON.stringify(ba.body) === JSON.stringify(aa.body);
  results.push({ test: 'Days B→A (cross)', result: ba.status === 200 ? `OK${baMatch ? ' (SAME data as A→A)' : ' (DIFFERENT data)'}` : `BLOCKED (${ba.status})`, details: `${Array.isArray(ba.body) ? (ba.body as unknown[]).length + ' dates' : String(ba.body).slice(0, 80)}` });

  // ── Experiment 2: Cross-account groups page ─────────
  console.log('\n───────────────────────────────────────────────────');
  console.log('  Experiment 2: Cross-account groups page');
  console.log('  Cookie A → userId B (and vice versa)');
  console.log('───────────────────────────────────────────────────\n');

  if (botA.userId && botB.userId) {
    console.log('  [baseline] A→A ...');
    const gAA = await fetchGroupsPage(botA.cookie, botA.userId, botA.locale);
    console.log(`    Status: ${gAA.status}, Has appt: ${gAA.hasConsularAppt}`);
    results.push({ test: 'Groups A→A (baseline)', result: gAA.status === 200 ? 'OK' : `FAIL (${gAA.status})`, details: gAA.hasConsularAppt ? 'Has appointment' : gAA.snippet.slice(0, 80) });

    console.log('  [cross] A→B (cookie A, userId B) ...');
    const gAB = await fetchGroupsPage(botA.cookie, botB.userId, botA.locale);
    console.log(`    Status: ${gAB.status}, Has appt: ${gAB.hasConsularAppt}`);
    results.push({ test: 'Groups A→B (cross)', result: gAB.status === 200 ? `OK (sees B data: ${gAB.hasConsularAppt})` : `BLOCKED (${gAB.status})`, details: gAB.snippet.slice(0, 80) });

    console.log('  [cross] B→A (cookie B, userId A) ...');
    const gBA = await fetchGroupsPage(botB.cookie, botA.userId, botB.locale);
    console.log(`    Status: ${gBA.status}, Has appt: ${gBA.hasConsularAppt}`);
    results.push({ test: 'Groups B→A (cross)', result: gBA.status === 200 ? `OK (sees A data: ${gBA.hasConsularAppt})` : `BLOCKED (${gBA.status})`, details: gBA.snippet.slice(0, 80) });
  } else {
    console.log(`  SKIP: userId A=${botA.userId}, userId B=${botB.userId} (need both)`);
    results.push({ test: 'Groups (cross)', result: 'SKIPPED', details: 'Missing userId' });
  }

  // ── Experiment 3: Token swap ────────────────────────
  console.log('\n───────────────────────────────────────────────────');
  console.log('  Experiment 3: CSRF token swap');
  console.log('  CSRF A + Cookie B (and vice versa)');
  console.log('───────────────────────────────────────────────────\n');

  // Use A's CSRF with B's cookie on B's schedule
  console.log('  [swap] CSRF A + Cookie B → schedule B ...');
  const swapAB = await fetchDays(botB.cookie, botA.csrfToken, botB.scheduleId, botB.consularFacilityId, botB.locale);
  console.log(`    Status: ${swapAB.status}, Type: ${swapAB.contentType}`);
  results.push({ test: 'Token swap: CSRF A + Cookie B', result: swapAB.status === 200 ? 'WORKS' : `REJECTED (${swapAB.status})`, details: `${Array.isArray(swapAB.body) ? (swapAB.body as unknown[]).length + ' dates' : String(swapAB.body).slice(0, 80)}` });

  // Use B's CSRF with A's cookie on A's schedule
  console.log('  [swap] CSRF B + Cookie A → schedule A ...');
  const swapBA = await fetchDays(botA.cookie, botB.csrfToken, botA.scheduleId, botA.consularFacilityId, botA.locale);
  console.log(`    Status: ${swapBA.status}, Type: ${swapBA.contentType}`);
  results.push({ test: 'Token swap: CSRF B + Cookie A', result: swapBA.status === 200 ? 'WORKS' : `REJECTED (${swapBA.status})`, details: `${Array.isArray(swapBA.body) ? (swapBA.body as unknown[]).length + ' dates' : String(swapBA.body).slice(0, 80)}` });

  // ── Experiment 4: Cross-account appointment page ────
  console.log('\n───────────────────────────────────────────────────');
  console.log('  Experiment 4: Cross-account appointment page');
  console.log('  Cookie A → appointment page of schedule B');
  console.log('───────────────────────────────────────────────────\n');

  {
    const { USER_AGENT, BROWSER_HEADERS, getBaseUrl, getLocaleTexts } = await import('../src/utils/constants.js');
    const texts = getLocaleTexts(botB.locale);
    const baseUrl = getBaseUrl(botB.locale);
    const qs = botB.applicantIds.map((id) => `applicants[]=${id}`).join('&');
    const url = `${baseUrl}/schedule/${botB.scheduleId}/appointment?${qs}&confirmed_limit_message=1&commit=${texts.continueText}`;

    console.log('  [cross] Cookie A → appointment page B ...');
    const resp = await fetch(url, {
      headers: {
        Cookie: `_yatri_session=${botA.cookie}`,
        'User-Agent': USER_AGENT,
        Accept: 'text/html',
        ...BROWSER_HEADERS,
      },
      redirect: 'manual',
    });

    const location = resp.headers.get('location') ?? '';
    let hasAuthToken = false;
    let hasScheduleB = false;
    if (resp.status === 200) {
      const html = await resp.text();
      hasAuthToken = html.includes('authenticity_token');
      hasScheduleB = html.includes(botB.scheduleId);
      console.log(`    Status: ${resp.status}, Has authenticity_token: ${hasAuthToken}, Contains scheduleId B: ${hasScheduleB}`);
    } else {
      await resp.text().catch(() => {});
      console.log(`    Status: ${resp.status}, Location: ${location}`);
    }
    results.push({
      test: 'Appointment page A→B (cross)',
      result: resp.status === 200 ? `OK (authToken: ${hasAuthToken}, scheduleB: ${hasScheduleB})` : `BLOCKED (${resp.status})`,
      details: resp.status !== 200 ? `Redirect: ${location}` : '',
    });
  }

  // ── Experiment 5: Cross-embassy ──────────────────────
  const diffLocale = botA.locale !== botB.locale;
  const diffFacility = botA.consularFacilityId !== botB.consularFacilityId;

  if (diffLocale || diffFacility) {
    console.log('\n───────────────────────────────────────────────────');
    console.log('  Experiment 5: Cross-embassy');
    console.log(`  A: ${botA.locale} facility ${botA.consularFacilityId}`);
    console.log(`  B: ${botB.locale} facility ${botB.consularFacilityId}`);
    console.log('───────────────────────────────────────────────────\n');

    // 5a: Cookie A (locale A) → days on locale B's URL with B's facility
    if (diffLocale) {
      console.log('  [5a] Cookie A → days via locale B URL (schedule A, facility A) ...');
      const crossLocale = await fetchDays(botA.cookie, botA.csrfToken, botA.scheduleId, botA.consularFacilityId, botB.locale);
      console.log(`    Status: ${crossLocale.status}, Dates: ${Array.isArray(crossLocale.body) ? (crossLocale.body as unknown[]).length : 'N/A'}`);
      const sameAsBaseline = Array.isArray(crossLocale.body) && Array.isArray(aa.body) && JSON.stringify(crossLocale.body) === JSON.stringify(aa.body);
      results.push({
        test: `Days A via locale B URL (${botB.locale})`,
        result: crossLocale.status === 200 ? `OK${sameAsBaseline ? ' (SAME as baseline)' : ' (DIFFERENT)'}` : `BLOCKED (${crossLocale.status})`,
        details: `${Array.isArray(crossLocale.body) ? (crossLocale.body as unknown[]).length + ' dates' : String(crossLocale.body).slice(0, 80)}`,
      });
    }

    // 5b: Cookie A → days for B's facility (different embassy)
    if (diffFacility) {
      console.log(`  [5b] Cookie A → days for facility B (${botB.consularFacilityId}) with own schedule ...`);
      const crossFacilityOwn = await fetchDays(botA.cookie, botA.csrfToken, botA.scheduleId, botB.consularFacilityId, botA.locale);
      console.log(`    Status: ${crossFacilityOwn.status}, Dates: ${Array.isArray(crossFacilityOwn.body) ? (crossFacilityOwn.body as unknown[]).length : 'N/A'}`);
      results.push({
        test: `Days A → facility B (${botB.consularFacilityId}) own sched`,
        result: crossFacilityOwn.status === 200 ? `OK (${Array.isArray(crossFacilityOwn.body) ? (crossFacilityOwn.body as unknown[]).length + ' dates' : 'N/A'})` : `BLOCKED (${crossFacilityOwn.status})`,
        details: `${Array.isArray(crossFacilityOwn.body) ? (crossFacilityOwn.body as unknown[]).length + ' dates' : String(crossFacilityOwn.body).slice(0, 80)}`,
      });

      console.log(`  [5c] Cookie A → days for facility B (${botB.consularFacilityId}) with B's schedule ...`);
      const crossFacilityB = await fetchDays(botA.cookie, botA.csrfToken, botB.scheduleId, botB.consularFacilityId, botA.locale);
      console.log(`    Status: ${crossFacilityB.status}, Dates: ${Array.isArray(crossFacilityB.body) ? (crossFacilityB.body as unknown[]).length : 'N/A'}`);
      const matchesBB = Array.isArray(crossFacilityB.body) && Array.isArray(bb.body) && JSON.stringify(crossFacilityB.body) === JSON.stringify(bb.body);
      results.push({
        test: `Days A → facility B (${botB.consularFacilityId}) B's sched`,
        result: crossFacilityB.status === 200 ? `OK${matchesBB ? ' (SAME as B→B)' : ' (DIFFERENT)'}` : `BLOCKED (${crossFacilityB.status})`,
        details: `${Array.isArray(crossFacilityB.body) ? (crossFacilityB.body as unknown[]).length + ' dates' : String(crossFacilityB.body).slice(0, 80)}`,
      });
    }

    // 5d: Full cross — Cookie A → locale B URL + facility B + schedule B
    if (diffLocale && diffFacility) {
      console.log(`  [5d] Full cross: Cookie A → locale ${botB.locale} + facility ${botB.consularFacilityId} + schedule B ...`);
      const fullCross = await fetchDays(botA.cookie, botA.csrfToken, botB.scheduleId, botB.consularFacilityId, botB.locale);
      console.log(`    Status: ${fullCross.status}, Dates: ${Array.isArray(fullCross.body) ? (fullCross.body as unknown[]).length : 'N/A'}`);
      const matchesFull = Array.isArray(fullCross.body) && Array.isArray(bb.body) && JSON.stringify(fullCross.body) === JSON.stringify(bb.body);
      results.push({
        test: 'Full cross: A cookie → B locale+fac+sched',
        result: fullCross.status === 200 ? `OK${matchesFull ? ' (SAME as B→B)' : ' (DIFFERENT)'}` : `BLOCKED (${fullCross.status})`,
        details: `${Array.isArray(fullCross.body) ? (fullCross.body as unknown[]).length + ' dates' : String(fullCross.body).slice(0, 80)}`,
      });
    }

    // 5e: Cookie B → days for A's facility (reverse)
    if (diffFacility) {
      console.log(`  [5e] Cookie B → days for facility A (${botA.consularFacilityId}) with A's schedule ...`);
      const reverseFac = await fetchDays(botB.cookie, botB.csrfToken, botA.scheduleId, botA.consularFacilityId, botB.locale);
      console.log(`    Status: ${reverseFac.status}, Dates: ${Array.isArray(reverseFac.body) ? (reverseFac.body as unknown[]).length : 'N/A'}`);
      const matchesAA = Array.isArray(reverseFac.body) && Array.isArray(aa.body) && JSON.stringify(reverseFac.body) === JSON.stringify(aa.body);
      results.push({
        test: `Days B → facility A (${botA.consularFacilityId}) A's sched`,
        result: reverseFac.status === 200 ? `OK${matchesAA ? ' (SAME as A→A)' : ' (DIFFERENT)'}` : `BLOCKED (${reverseFac.status})`,
        details: `${Array.isArray(reverseFac.body) ? (reverseFac.body as unknown[]).length + ' dates' : String(reverseFac.body).slice(0, 80)}`,
      });
    }
  } else {
    console.log('\n───────────────────────────────────────────────────');
    console.log('  Experiment 5: Cross-embassy — SKIPPED');
    console.log(`  Both bots use same locale (${botA.locale}) and facility (${botA.consularFacilityId})`);
    console.log('───────────────────────────────────────────────────');
    results.push({ test: 'Cross-embassy', result: 'SKIPPED', details: 'Same locale + facility' });
  }

  // ── Summary ─────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════════\n');

  const colW = [38, 30, 50];
  console.log(`  ${'Test'.padEnd(colW[0]!)} ${'Result'.padEnd(colW[1]!)} Details`);
  console.log(`  ${'─'.repeat(colW[0]!)} ${'─'.repeat(colW[1]!)} ${'─'.repeat(colW[2]!)}`);
  for (const r of results) {
    console.log(`  ${r.test.padEnd(colW[0]!)} ${r.result.padEnd(colW[1]!)} ${r.details}`);
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  IMPLICATIONS');
  console.log('═══════════════════════════════════════════════════\n');

  const crossDaysWorks = ab.status === 200;
  const crossGroupsWorks = results.find(r => r.test === 'Groups A→B (cross)')?.result.startsWith('OK');
  const tokenSwapWorks = swapAB.status === 200;

  if (crossDaysWorks) {
    console.log('  ✓ CROSS-ACCOUNT DAYS: Session A can fetch dates for schedule B.');
    console.log('    → Scout can poll for ALL subscribers without individual logins.');
    console.log('    → Dispatch only needs login for the POST reschedule, not for date checks.');
  } else {
    console.log('  ✗ CROSS-ACCOUNT DAYS: Sessions are schedule-bound.');
    console.log('    → Each account needs its own session for polling (current architecture is correct).');
  }

  if (crossGroupsWorks) {
    console.log('  ✓ CROSS-ACCOUNT GROUPS: Session A can see account B appointment details.');
    console.log('    → Scout can verify reschedule success for subscribers without their session.');
  } else {
    console.log('  ✗ CROSS-ACCOUNT GROUPS: Groups page is account-bound (expected).');
  }

  if (tokenSwapWorks) {
    console.log('  ✓ TOKEN SWAP: CSRF tokens are NOT session-bound — any valid token works.');
    console.log('    → Can share CSRF tokens across sessions (less token management needed).');
  } else {
    console.log('  ✗ TOKEN SWAP: CSRF tokens are session-bound (expected).');
    console.log('    → Each session needs its own CSRF token.');
  }

  if (diffLocale || diffFacility) {
    const crossLocaleWorks = diffLocale && results.find(r => r.test.startsWith('Days A via locale B'))?.result.startsWith('OK');
    const crossFacilityWorks = diffFacility && results.find(r => r.test.includes('facility B') && r.test.includes('own sched'))?.result.startsWith('OK');
    const fullCrossWorks = diffLocale && diffFacility && results.find(r => r.test.startsWith('Full cross'))?.result.startsWith('OK');

    console.log('');
    if (crossLocaleWorks) {
      console.log('  ✓ CROSS-LOCALE: Session works across locale URLs.');
      console.log('    → Cookie from es-co login can access es-pe URLs (or vice versa).');
    } else if (diffLocale) {
      console.log('  ✗ CROSS-LOCALE: Session is locale-bound.');
      console.log('    → Need separate login per locale.');
    }

    if (crossFacilityWorks) {
      console.log('  ✓ CROSS-FACILITY: Session can query different embassy facilities.');
      console.log('    → One session can poll Bogota AND Lima (or any facility) simultaneously.');
      console.log('    → Single scout could monitor multiple embassies!');
    } else if (diffFacility) {
      console.log('  ✗ CROSS-FACILITY: Facility access is tied to account registration.');
      console.log('    → Need one scout per embassy (current architecture is correct).');
    }

    if (fullCrossWorks) {
      console.log('  ✓ FULL CROSS-EMBASSY: One session can access any locale + facility + schedule.');
      console.log('    → GAME CHANGER: Single scout for all embassies worldwide.');
    }
  }

  console.log('');
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

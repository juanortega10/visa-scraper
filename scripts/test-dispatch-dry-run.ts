/**
 * Dispatch Dry-Run Test
 *
 * Simulates the full dispatch flow for a subscriber bot:
 *   1. Login with subscriber creds (~1s)
 *   2. (optional) Save HTML fixtures (--save-fixtures)
 *   3. Discover userId if missing (refreshTokens)
 *   4. getCurrentAppointment() → sync DB if different
 *   5. getConsularDays() → filter → show candidates
 *   6. If no real improvement → generate mock date 5 days before current
 *   7. executeReschedule({ dryRun }) with the date
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/test-dispatch-dry-run.ts --bot-id=12                 # dry-run
 *   npx tsx --env-file=.env scripts/test-dispatch-dry-run.ts --bot-id=12 --commit        # REAL
 *   npx tsx --env-file=.env scripts/test-dispatch-dry-run.ts --bot-id=12 --save-fixtures # dry-run + save HTML
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots, sessions, excludedDates, excludedTimes } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import { executeReschedule } from '../src/services/reschedule-logic.js';
import { filterDates, isAtLeastNDaysEarlier } from '../src/utils/date-helpers.js';
import { getBaseUrl, USER_AGENT, getLocaleTexts } from '../src/utils/constants.js';
import type { ProxyProvider } from '../src/services/proxy-fetch.js';
import type { CasCacheData } from '../src/db/schema.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const isCommit = process.argv.includes('--commit');
const saveFixtures = process.argv.includes('--save-fixtures');
const botIdArg = process.argv.find((a) => a.startsWith('--bot-id='));
const botId = botIdArg ? parseInt(botIdArg.split('=')[1]!, 10) : 12;

let stepN = 0;
function step(label: string) {
  stepN++;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  STEP ${stepN}: ${label}`);
  console.log('='.repeat(60));
}

async function main() {
  console.log(`\n🔬 Dispatch Dry-Run Test — ${isCommit ? '⚠️  REAL (--commit)' : '🛡️  DRY-RUN'}${saveFixtures ? ' + 📁 FIXTURES' : ''}`);
  console.log(`Bot: ${botId}\n`);

  // ── Load bot + exclusions ──
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) { console.error(`Bot ${botId} not found`); process.exit(1); }

  const email = decrypt(bot.visaEmail);
  const password = decrypt(bot.visaPassword);
  const exDates = await db.select().from(excludedDates).where(eq(excludedDates.botId, botId));
  const exTimes = await db.select().from(excludedTimes).where(eq(excludedTimes.botId, botId));

  console.log(`Locale:           ${bot.locale}`);
  console.log(`Schedule:         ${bot.scheduleId}`);
  console.log(`Applicants:       ${bot.applicantIds.length}`);
  console.log(`Consular facility: ${bot.consularFacilityId}`);
  console.log(`ASC facility:     ${bot.ascFacilityId || '(none)'}`);
  console.log(`Current consular: ${bot.currentConsularDate} ${bot.currentConsularTime}`);
  console.log(`Current CAS:      ${bot.currentCasDate} ${bot.currentCasTime}`);
  console.log(`Provider:         ${bot.proxyProvider}`);
  console.log(`isSubscriber:     ${bot.isSubscriber}`);
  console.log(`isScout:          ${bot.isScout}`);
  console.log(`Excluded dates:   ${exDates.length} ranges`);
  console.log(`Excluded times:   ${exTimes.length} ranges`);
  console.log(`maxReschedules:   ${bot.maxReschedules ?? 'unlimited'}`);
  console.log(`rescheduleCount:  ${bot.rescheduleCount}`);
  console.log(`targetDateBefore: ${bot.targetDateBefore ?? '(none)'}`);

  // ── Login (like dispatch does) ──
  step('performLogin() — subscriber login');
  const t1 = Date.now();
  const loginResult = await performLogin({
    email,
    password,
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    locale: bot.locale,
  });
  const loginMs = Date.now() - t1;
  console.log(`  Cookie: ${loginResult.cookie.length} chars`);
  console.log(`  hasTokens: ${loginResult.hasTokens}`);
  console.log(`  CSRF: ${loginResult.csrfToken?.substring(0, 30) || '(none)'}...`);
  console.log(`  ⏱️  ${loginMs}ms`);

  // Save session to DB (like dispatch does)
  const sessionData = {
    yatriCookie: encrypt(loginResult.cookie),
    csrfToken: loginResult.csrfToken || null,
    authenticityToken: loginResult.authenticityToken || null,
    lastUsedAt: new Date(),
    createdAt: new Date(),
  };
  await db.insert(sessions).values({ botId, ...sessionData })
    .onConflictDoUpdate({ target: sessions.botId, set: sessionData });
  console.log('  Session saved to DB');

  // ── Save HTML fixtures (uses fresh cookie, before VisaClient consumes pages) ──
  if (saveFixtures) {
    step('Saving HTML fixtures');
    const baseUrl = getBaseUrl(bot.locale);
    const headers = { Cookie: `_yatri_session=${loginResult.cookie}`, 'User-Agent': USER_AGENT, Accept: 'text/html' };

    // Fetch groups page (via /account redirect)
    const tf = Date.now();
    const accountResp = await fetch(`${baseUrl}/account`, { headers, redirect: 'follow' });
    const groupsHtml = await accountResp.text();
    const fixtureUserId = accountResp.url.match(/\/groups\/(\d+)/)?.[1] || bot.userId || 'unknown';
    const fixtureScheduleId = groupsHtml.match(/\/schedule\/(\d+)/)?.[1] || bot.scheduleId;

    // Extract applicant IDs for appointment page URL
    const fixtureApplicantIds: string[] = [];
    const regex = /\/applicants\/(\d+)/g;
    const seen = new Set<string>();
    let m;
    while ((m = regex.exec(groupsHtml)) !== null) {
      if (!seen.has(m[1]!)) { seen.add(m[1]!); fixtureApplicantIds.push(m[1]!); }
    }

    // Use rotated cookie from groups response
    let fixtureCookie = loginResult.cookie;
    for (const h of accountResp.headers.getSetCookie()) {
      const cm = h.match(/_yatri_session=([^;]+)/);
      if (cm?.[1]) { fixtureCookie = cm[1]; break; }
    }

    // Fetch appointment page
    const texts = getLocaleTexts(bot.locale);
    const qs = fixtureApplicantIds.map(id => `applicants[]=${id}`).join('&') + '&';
    const apptUrl = `${baseUrl}/schedule/${fixtureScheduleId}/appointment?${qs}confirmed_limit_message=1&commit=${texts.continueText}`;
    const apptResp = await fetch(apptUrl, {
      headers: { ...headers, Cookie: `_yatri_session=${fixtureCookie}` },
      redirect: 'follow',
    });
    const apptHtml = await apptResp.text();
    console.log(`  ⏱️  ${Date.now() - tf}ms (both pages)`);

    // Save to disk
    const fixturesDir = join(import.meta.dirname, '..', 'src', 'services', '__tests__', 'fixtures', `bot-${botId}-${bot.locale}`);
    mkdirSync(fixturesDir, { recursive: true });

    writeFileSync(join(fixturesDir, 'groups-page.html'), groupsHtml, 'utf-8');
    writeFileSync(join(fixturesDir, 'appointment-page.html'), apptHtml, 'utf-8');
    writeFileSync(join(fixturesDir, 'manifest.json'), JSON.stringify({
      botId,
      locale: bot.locale,
      userId: fixtureUserId,
      scheduleId: fixtureScheduleId,
      applicantCount: fixtureApplicantIds.length,
      applicantIds: fixtureApplicantIds,
      capturedAt: new Date().toISOString(),
    }, null, 2), 'utf-8');

    console.log(`  ✅ Fixtures saved to ${fixturesDir}/`);
    console.log(`     groups-page.html (${(groupsHtml.length / 1024).toFixed(1)} KB)`);
    console.log(`     appointment-page.html (${(apptHtml.length / 1024).toFixed(1)} KB)`);
    console.log(`     manifest.json`);
  }

  // ── Create VisaClient + discover userId ──
  step('VisaClient + userId discovery');
  const client = new VisaClient(
    {
      cookie: loginResult.cookie,
      csrfToken: loginResult.csrfToken,
      authenticityToken: loginResult.authenticityToken,
    },
    {
      scheduleId: bot.scheduleId,
      applicantIds: bot.applicantIds,
      consularFacilityId: bot.consularFacilityId,
      ascFacilityId: bot.ascFacilityId,
      proxyProvider: 'direct' as ProxyProvider,
      userId: bot.userId,
      locale: bot.locale,
    },
  );

  if (!bot.userId) {
    console.log('  userId not cached — running refreshTokens() to discover...');
    const t2 = Date.now();
    await client.refreshTokens();
    const discoveredUserId = client.getUserId();
    console.log(`  Discovered userId: ${discoveredUserId}`);
    console.log(`  ⏱️  ${Date.now() - t2}ms`);
    if (discoveredUserId) {
      await db.update(bots).set({ userId: discoveredUserId, updatedAt: new Date() }).where(eq(bots.id, botId));
      console.log('  userId persisted to DB');
    }
  } else {
    console.log(`  userId already cached: ${bot.userId}`);
  }

  // ── getCurrentAppointment() — sync check ──
  step('getCurrentAppointment() — sync DB vs web');
  const t3 = Date.now();
  const currentAppt = await client.getCurrentAppointment();
  console.log(`  ⏱️  ${Date.now() - t3}ms`);

  if (currentAppt) {
    console.log(`  Web:  Consular ${currentAppt.consularDate} ${currentAppt.consularTime}`);
    console.log(`        CAS      ${currentAppt.casDate} ${currentAppt.casTime}`);
    console.log(`  DB:   Consular ${bot.currentConsularDate} ${bot.currentConsularTime}`);
    console.log(`        CAS      ${bot.currentCasDate} ${bot.currentCasTime}`);

    const changed =
      currentAppt.consularDate !== bot.currentConsularDate ||
      currentAppt.consularTime !== bot.currentConsularTime ||
      currentAppt.casDate !== bot.currentCasDate ||
      currentAppt.casTime !== bot.currentCasTime;

    if (changed) {
      console.log('  ⚠️  MISMATCH — syncing DB to web values');
      await db.update(bots).set({
        currentConsularDate: currentAppt.consularDate,
        currentConsularTime: currentAppt.consularTime,
        currentCasDate: currentAppt.casDate,
        currentCasTime: currentAppt.casTime,
        updatedAt: new Date(),
      }).where(eq(bots.id, botId));
    } else {
      console.log('  ✅ DB matches web — no sync needed');
    }
  } else {
    console.log('  ⚠️  Could not parse appointment from web');
  }

  // Use fresh consular date for comparison
  const effectiveConsularDate = currentAppt?.consularDate ?? bot.currentConsularDate;

  // ── getConsularDays() — available dates ──
  step('getConsularDays() — check availability');
  const t4 = Date.now();
  const days = await client.getConsularDays();
  console.log(`  Total available: ${days.length} days`);
  console.log(`  First 5: ${days.slice(0, 5).map(d => d.date).join(', ')}`);
  console.log(`  ⏱️  ${Date.now() - t4}ms`);

  const dateExclusions = exDates.map((d) => ({ startDate: d.startDate, endDate: d.endDate }));
  const filteredDays = filterDates(days, dateExclusions);
  console.log(`  After exclusion filter: ${filteredDays.length} days`);

  const candidates = filteredDays
    .filter((d) => effectiveConsularDate ? isAtLeastNDaysEarlier(d.date, effectiveConsularDate, 1) : true)
    .slice(0, 5);

  const hasRealImprovement = candidates.length > 0;
  console.log(`  Candidates earlier than ${effectiveConsularDate}: ${candidates.length}`);
  if (candidates.length > 0) {
    for (const d of candidates) {
      console.log(`    📅 ${d.date}`);
    }
  }

  // ── Prepare dates for executeReschedule ──
  let daysForReschedule = days;
  if (!hasRealImprovement) {
    step('No real improvement — generating mock date for dry-run');
    if (!effectiveConsularDate) {
      console.log('  ❌ No current consular date — cannot generate mock');
      process.exit(0);
    }
    const mockDate = new Date(effectiveConsularDate);
    mockDate.setDate(mockDate.getDate() - 5);
    const mockDateStr = mockDate.toISOString().split('T')[0]!;
    console.log(`  Mock date: ${mockDateStr} (5 days before ${effectiveConsularDate})`);
    daysForReschedule = [{ date: mockDateStr, business_day: true }, ...days];
  } else {
    step('Real improvement found — using actual dates');
    console.log(`  Best candidate: ${candidates[0]!.date}`);
  }

  // ── executeReschedule ──
  const isDryRun = !isCommit || !hasRealImprovement;
  step(`executeReschedule() — ${isDryRun ? 'DRY-RUN' : '⚠️  REAL POST'}`);

  if (!isCommit && hasRealImprovement) {
    console.log('  ℹ️  Real improvement exists but running as dry-run. Pass --commit for real POST.');
  }
  if (isCommit && !hasRealImprovement) {
    console.log('  ℹ️  --commit passed but no real improvement — forcing dry-run.');
  }

  const timeExclusions = exTimes.map((t) => ({ date: t.date, timeStart: t.timeStart, timeEnd: t.timeEnd }));
  const pending: Promise<unknown>[] = [];

  const t6 = Date.now();
  const result = await executeReschedule({
    client,
    botId,
    bot: {
      currentConsularDate: effectiveConsularDate,
      currentConsularTime: currentAppt?.consularTime ?? bot.currentConsularTime,
      currentCasDate: currentAppt?.casDate ?? bot.currentCasDate,
      currentCasTime: currentAppt?.casTime ?? bot.currentCasTime,
      ascFacilityId: bot.ascFacilityId,
    },
    dateExclusions,
    timeExclusions,
    preFetchedDays: daysForReschedule,
    casCacheJson: bot.casCacheJson as CasCacheData | null,
    dryRun: isDryRun,
    pending,
    loginCredentials: { email, password, scheduleId: bot.scheduleId, applicantIds: bot.applicantIds, locale: bot.locale },
  });
  const rescheduleMs = Date.now() - t6;

  await Promise.allSettled(pending);

  // ── Summary ──
  console.log(`\n${'='.repeat(60)}`);
  console.log('  RESULT');
  console.log('='.repeat(60));
  console.log(`  Success: ${result.success ? '✅' : '❌'}`);
  if (result.success) {
    console.log(`  New consular: ${result.date} ${result.consularTime}`);
    console.log(`  New CAS:      ${result.casDate} ${result.casTime}`);
  } else {
    console.log(`  Reason: ${result.reason}`);
  }
  if (result.attempts?.length) {
    console.log(`  Attempts: ${result.attempts.length}`);
    for (const a of result.attempts) {
      console.log(`    - ${a.date} ${a.consularTime || ''}: ${a.failReason} (${a.durationMs}ms)`);
    }
  }

  console.log(`\n  Timings:`);
  console.log(`    Login:      ${loginMs}ms`);
  console.log(`    Reschedule: ${rescheduleMs}ms`);
  console.log(`    Total:      ${loginMs + rescheduleMs}ms`);
  console.log(`\n✅ Dispatch test completed.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ Error:', e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) {
    console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  }
  process.exit(1);
});

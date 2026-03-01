/**
 * Verify full date ranges for Bot 7 and Liz to check MRV theory.
 * If MRV limits the window, Liz (paid June 2025) should NOT see dates after June 2026.
 *
 * Usage: npx tsx --env-file=.env scripts/verify-date-ranges.ts
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { pureFetchLogin, performLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';

const BOT_ID = 7;
const LIZ_EMAIL = 'shiara.arauzo@hotmail.com';
const LIZ_PASSWORD = '=Visa123ReunionHackaton';
const LOCALE = 'es-pe';
const LIZ_SCHEDULE = '69454137';
const LIZ_APPLICANT = '80769164';

function log(msg: string) {
  const ts = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Bogota', hour12: false });
  console.log(`[${ts}] ${msg}`);
}

async function main() {
  log('=== Verify date ranges: Bot 7 vs Liz ===\n');

  // Bot 7
  const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
  if (!bot) throw new Error('Bot 7 not found');

  log('--- Bot 7 ---');
  const bot7Login = await performLogin({
    email: decrypt(bot.visaEmail), password: decrypt(bot.visaPassword),
    scheduleId: bot.scheduleId, applicantIds: bot.applicantIds, locale: bot.locale,
  });
  const bot7Client = new VisaClient(bot7Login, {
    scheduleId: bot.scheduleId, applicantIds: bot.applicantIds,
    consularFacilityId: bot.consularFacilityId, ascFacilityId: bot.ascFacilityId,
    proxyProvider: 'direct', locale: bot.locale,
  });
  await bot7Client.refreshTokens();
  const bot7Days = await bot7Client.getConsularDays();
  const bot7Dates = bot7Days.map(d => d.date).sort();

  log(`  Total: ${bot7Dates.length} dates`);
  log(`  Earliest: ${bot7Dates[0]}`);
  log(`  Latest:   ${bot7Dates[bot7Dates.length - 1]}`);
  log(`  Current appointment: ${bot.currentConsularDate}`);
  log(`  All dates: ${bot7Dates.join(', ')}`);

  // Liz
  log('\n--- Liz (schedule 69454137) ---');
  const lizLogin = await pureFetchLogin(
    { email: LIZ_EMAIL, password: LIZ_PASSWORD, scheduleId: LIZ_SCHEDULE, applicantIds: [LIZ_APPLICANT], locale: LOCALE },
    { skipTokens: false },
  );
  const lizClient = new VisaClient(lizLogin, {
    scheduleId: LIZ_SCHEDULE, applicantIds: [LIZ_APPLICANT],
    consularFacilityId: '115', ascFacilityId: '', proxyProvider: 'direct', locale: LOCALE,
  });
  await lizClient.refreshTokens();
  const lizDays = await lizClient.getConsularDays();
  const lizDates = lizDays.map(d => d.date).sort();

  log(`  Total: ${lizDates.length} dates`);
  log(`  Earliest: ${lizDates[0]}`);
  log(`  Latest:   ${lizDates[lizDates.length - 1]}`);
  log(`  Current appointment: 2026-07-09`);
  log(`  MRV paid: ~June 2025 → expires ~June 2026`);
  log(`  All dates: ${lizDates.join(', ')}`);

  // Analysis
  log('\n=== Analysis ===');
  const lizAfterJun2026 = lizDates.filter(d => d > '2026-06-30');
  log(`  Liz dates AFTER June 2026 (beyond MRV expiry): ${lizAfterJun2026.length}`);
  if (lizAfterJun2026.length > 0) {
    log(`  → MRV DOES NOT limit end of visible window!`);
    log(`  → Dates beyond MRV: ${lizAfterJun2026.slice(0, 10).join(', ')}${lizAfterJun2026.length > 10 ? '...' : ''}`);
  }

  // Compare overlaps
  const bot7Set = new Set(bot7Dates);
  const lizSet = new Set(lizDates);
  const shared = bot7Dates.filter(d => lizSet.has(d));
  const onlyBot7 = bot7Dates.filter(d => !lizSet.has(d));
  const onlyLiz = lizDates.filter(d => !bot7Set.has(d));

  log(`\n  Shared dates: ${shared.length}`);
  log(`  Only Bot 7:   ${onlyBot7.length} [${onlyBot7.slice(0, 5).join(', ')}...]`);
  log(`  Only Liz:     ${onlyLiz.length} [${onlyLiz.slice(0, 5).join(', ')}...]`);

  // Date range by month
  log('\n=== Dates per month ===');
  const months = new Map<string, { bot7: number; liz: number }>();
  for (const d of bot7Dates) {
    const m = d.substring(0, 7);
    if (!months.has(m)) months.set(m, { bot7: 0, liz: 0 });
    months.get(m)!.bot7++;
  }
  for (const d of lizDates) {
    const m = d.substring(0, 7);
    if (!months.has(m)) months.set(m, { bot7: 0, liz: 0 });
    months.get(m)!.liz++;
  }
  const sortedMonths = [...months.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log('\n  Month     | Bot 7 | Liz | Diff');
  console.log('  ----------|-------|-----|-----');
  for (const [month, counts] of sortedMonths) {
    const diff = counts.liz > 0 && counts.bot7 === 0 ? '← ONLY LIZ' :
                 counts.bot7 > 0 && counts.liz === 0 ? '← ONLY BOT7' : '';
    console.log(`  ${month}  |   ${String(counts.bot7).padStart(2)}  |  ${String(counts.liz).padStart(2)} | ${diff}`);
  }

  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

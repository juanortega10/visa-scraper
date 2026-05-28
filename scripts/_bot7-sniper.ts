/**
 * Manual sniper loop for bot 7 — polls consular days at a fixed interval.
 * Equivalent to the super-critical loop in poll-visa.ts but runs locally.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/_bot7-sniper.ts [--interval=6] [--budget=120]
 *
 * --interval  seconds between polls (default 6)
 * --budget    total seconds to run (default 120)
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots, sessions, excludedDates } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { VisaClient } from '../src/services/visa-client.js';
import { filterDates, isAtLeastNDaysEarlier } from '../src/utils/date-helpers.js';
import type { ProxyProvider } from '../src/services/proxy-fetch.js';

const BOT_ID = 7;

const args = process.argv.slice(2);
const intervalS = parseFloat(args.find(a => a.startsWith('--interval='))?.split('=')[1] ?? '6');
const budgetS   = parseFloat(args.find(a => a.startsWith('--budget='))?.split('=')[1]  ?? '120');

const intervalMs = intervalS * 1000;
const budgetMs   = budgetS   * 1000;

console.log(`\n=== Bot 7 Sniper ===`);
console.log(`Interval: ${intervalS}s | Budget: ${budgetS}s\n`);

// ── Load bot + session ────────────────────────────────────────
const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!bot) { console.error('Bot 7 not found'); process.exit(1); }

const [session] = await db.select().from(sessions).where(eq(sessions.botId, BOT_ID));
if (!session) { console.error('No session for bot 7. Run: npm run login -- --bot-id=7'); process.exit(1); }

const cookie = decrypt(session.yatriCookie);
const client = new VisaClient(
  { cookie, csrfToken: session.csrfToken ?? '', authenticityToken: session.authenticityToken ?? '' },
  {
    scheduleId:          bot.scheduleId,
    applicantIds:        bot.applicantIds,
    consularFacilityId:  bot.consularFacilityId,
    ascFacilityId:       bot.ascFacilityId,
    proxyProvider:       (bot.proxyProvider ?? 'direct') as ProxyProvider,
    userId:              bot.userId,
    locale:              bot.locale,
  },
);

const exDates = await db.select().from(excludedDates).where(eq(excludedDates.botId, BOT_ID));
const dateExclusions = exDates.map(d => ({ startDate: d.startDate, endDate: d.endDate }));

console.log(`Current consular date: ${bot.currentConsularDate}`);
console.log(`Target before:        ${bot.targetDateBefore ?? '(none)'}`);
console.log(`Excluded ranges:      ${exDates.length}\n`);

// ── Sniper loop ───────────────────────────────────────────────
const startMs = Date.now();
let fetchCount = 0;

while (true) {
  const elapsed = Date.now() - startMs;
  if (elapsed >= budgetMs) {
    console.log(`\nBudget exhausted (${budgetS}s). Done.`);
    break;
  }

  const iterStart = Date.now();
  fetchCount++;

  try {
    const allDays = await client.getConsularDays();
    const filtered = filterDates(allDays, dateExclusions, bot.targetDateBefore ?? undefined);
    const candidates = filtered.filter(d =>
      bot.currentConsularDate
        ? isAtLeastNDaysEarlier(d.date, bot.currentConsularDate, 1)
        : true,
    );

    const fetchMs = Date.now() - iterStart;
    const ts = new Date().toISOString().slice(11, 19);
    const earliest = candidates[0]?.date ?? filtered[0]?.date ?? 'none';

    if (candidates.length > 0) {
      console.log(`[${ts}] #${fetchCount} | ${fetchMs}ms | CANDIDATES: ${candidates.length} | best: ${candidates[0]!.date} ← BETTER THAN ${bot.currentConsularDate}`);
    } else {
      console.log(`[${ts}] #${fetchCount} | ${fetchMs}ms | total=${allDays.length} filtered=${filtered.length} earliest=${earliest}`);
    }
  } catch (err) {
    const fetchMs = Date.now() - iterStart;
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] #${fetchCount} | ${fetchMs}ms | ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Sleep until next interval (start-to-start)
  const iterElapsed = Date.now() - iterStart;
  const sleepMs = Math.max(0, intervalMs - iterElapsed);
  if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));
}

process.exit(0);

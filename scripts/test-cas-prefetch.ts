/**
 * Test CAS prefetch: runs the same algorithm as prefetch-cas task locally.
 * Generates probe dates across [today+5, today+window+10], discovers CAS dates
 * via getCasDays(), then fetches times for each.
 *
 * Usage: npx tsx scripts/test-cas-prefetch.ts [--bot-id=6] [--window=30]
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { sessions, bots } from '../src/db/schema.js';
import type { CasCacheData } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { VisaClient, SessionExpiredError } from '../src/services/visa-client.js';

const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const a = args.find((a) => a.startsWith(`--${name}=`));
  return a ? a.split('=')[1]! : def;
};
const botId = parseInt(getArg('bot-id', '6'), 10);
const WINDOW_DAYS = parseInt(getArg('window', '30'), 10);
const shouldSave = args.includes('--save');

const PROBE_INTERVAL = 5;
const MAX_PROBES = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY_NAMES = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];

async function main() {
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));
  if (!bot || !session) { console.log('No bot/session'); process.exit(1); }

  const cookie = decrypt(session.yatriCookie);
  const ageMin = Math.round((Date.now() - session.createdAt.getTime()) / 60000);
  console.log(`Bot ${botId} | Session age: ${ageMin}min | Provider: direct\n`);

  const client = new VisaClient(
    { cookie, csrfToken: session.csrfToken ?? '', authenticityToken: session.authenticityToken ?? '' },
    {
      scheduleId: bot.scheduleId, applicantIds: bot.applicantIds,
      consularFacilityId: bot.consularFacilityId, ascFacilityId: bot.ascFacilityId,
      proxyProvider: 'direct', userId: bot.userId, locale: bot.locale,
    },
  );

  let requestCount = 0;
  const startMs = Date.now();

  // ── Phase 1: Get a consular time from any real consular date ──
  console.log('Phase 1: Fetching consular days + finding a consular time...');
  let consularDays;
  try {
    consularDays = await client.getConsularDays();
    requestCount++;
  } catch (err) {
    console.error('Failed:', err instanceof SessionExpiredError ? 'SESSION EXPIRED' : err);
    process.exit(1);
  }
  console.log(`  Consular days: ${consularDays.length} total, first: ${consularDays[0]?.date}`);

  let sampleTime: string | null = null;
  for (const cd of consularDays.slice(0, 3)) {
    try {
      const timesData = await client.getConsularTimes(cd.date);
      requestCount++;
      if (timesData.available_times?.length > 0) {
        sampleTime = timesData.available_times[0]!;
        console.log(`  Using consular time: ${cd.date} @ ${sampleTime}`);
        break;
      }
    } catch (err) {
      requestCount++;
      if (err instanceof SessionExpiredError) { console.error('SESSION EXPIRED'); process.exit(1); }
    }
    await sleep(300);
  }
  if (!sampleTime) { console.error('No consular times available. Aborting.'); process.exit(1); }

  // ── Phase 2: Generate probes ──
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0]!;
  const cutoff = new Date(today.getTime() + WINDOW_DAYS * 86400000).toISOString().split('T')[0]!;

  const probes: string[] = [];
  for (let offset = PROBE_INTERVAL; offset <= WINDOW_DAYS + 10; offset += PROBE_INTERVAL) {
    const d = new Date(today.getTime() + offset * 86400000);
    if (d.getDay() === 0) d.setDate(d.getDate() + 1); // skip Sunday
    probes.push(d.toISOString().split('T')[0]!);
  }
  const samples = probes.slice(0, MAX_PROBES);
  console.log(`\nPhase 2: Probes (${samples.length}): ${samples.join(', ')}`);
  console.log(`  Window: ${todayStr} → ${cutoff}`);

  // ── Phase 3: Discover CAS dates ──
  console.log(`\nPhase 3: Discovering CAS dates via getCasDays...`);
  const discoveredCasDates = new Set<string>();

  for (let i = 0; i < samples.length; i++) {
    const probeDate = samples[i]!;
    try {
      const casDays = await client.getCasDays(probeDate, sampleTime);
      requestCount++;
      const inWindow = casDays.filter((d) => d.date >= todayStr && d.date <= cutoff);
      for (const d of inWindow) discoveredCasDates.add(d.date);
      console.log(`  getCasDays(${probeDate}): ${casDays.length} total, ${inWindow.length} in window — ${casDays.slice(0, 3).map(d => d.date).join(', ')}${casDays.length > 3 ? '...' : ''}`);
    } catch (err) {
      requestCount++;
      if (err instanceof SessionExpiredError) { console.error('SESSION EXPIRED'); break; }
      console.log(`  getCasDays(${probeDate}): ERROR — ${err instanceof Error ? err.message : err}`);
    }
    if (i < samples.length - 1) await sleep(500);
  }

  const uniqueCasDates = [...discoveredCasDates].sort();
  console.log(`\n  Unique CAS dates in window: ${uniqueCasDates.length}`);

  if (uniqueCasDates.length === 0) {
    console.log('No CAS dates found in window. Done.');
    const durationMs = Date.now() - startMs;
    console.log(`Requests: ${requestCount} | Duration: ${(durationMs / 1000).toFixed(1)}s`);
    process.exit(0);
  }

  // ── Phase 4: Fetch CAS times ──
  console.log(`\nPhase 4: Fetching CAS times for ${uniqueCasDates.length} dates...`);
  const entries: { date: string; slots: number; times: string[] }[] = [];

  for (let i = 0; i < uniqueCasDates.length; i++) {
    const casDate = uniqueCasDates[i]!;
    try {
      const timesData = await client.getCasTimes(casDate);
      requestCount++;
      const times = timesData.available_times ?? [];
      entries.push({ date: casDate, slots: times.length, times });
    } catch (err) {
      requestCount++;
      if (err instanceof SessionExpiredError) { console.error('SESSION EXPIRED'); break; }
      entries.push({ date: casDate, slots: -1, times: [] });
      console.log(`  ${casDate}: ERROR — ${err instanceof Error ? err.message : err}`);
    }
    if (i < uniqueCasDates.length - 1) await sleep(500);
  }

  const durationMs = Date.now() - startMs;

  // ── Results table ──
  const fullDates = entries.filter((e) => e.slots === 0).length;
  const lowDates = entries.filter((e) => e.slots > 0 && e.slots <= 10).length;
  const errDates = entries.filter((e) => e.slots === -1).length;

  console.log(`\n${'═'.repeat(76)}`);
  console.log(`CAS SLOTS — próximos ${WINDOW_DAYS} días (${entries.length} dates)`);
  console.log(`${'═'.repeat(76)}`);
  console.log(`${'Date'.padEnd(14)} ${'Day'.padEnd(5)} ${'Slots'.padStart(5)}  ${'Status'.padEnd(8)}  Times`);
  console.log(`${'─'.repeat(76)}`);

  for (const e of entries) {
    const d = new Date(e.date + 'T12:00:00');
    const day = DAY_NAMES[d.getDay()]!;
    const slotsStr = e.slots === -1 ? 'ERR' : String(e.slots);
    let status = '';
    if (e.slots === 0) status = 'FULL';
    else if (e.slots === -1) status = 'ERROR';
    else if (e.slots <= 10) status = 'LOW';
    else status = 'ok';

    const firstTimes = e.times.slice(0, 5).join(', ');
    const more = e.times.length > 5 ? ` +${e.times.length - 5} more` : '';
    console.log(`${e.date.padEnd(14)} ${day.padEnd(5)} ${slotsStr.padStart(5)}  ${status.padEnd(8)}  ${firstTimes}${more}`);
  }

  console.log(`${'─'.repeat(76)}`);
  console.log(`Total: ${entries.length} | FULL: ${fullDates} | LOW: ${lowDates} | ERROR: ${errDates}`);
  console.log(`Requests: ${requestCount} | Duration: ${(durationMs / 1000).toFixed(1)}s`);

  // ── Save to DB ──
  if (shouldSave && entries.length > 0) {
    const cacheData: CasCacheData = {
      refreshedAt: new Date().toISOString(),
      windowDays: WINDOW_DAYS,
      totalDates: entries.length,
      fullDates,
      entries,
    };
    await db.update(bots).set({ casCacheJson: cacheData, updatedAt: new Date() }).where(eq(bots.id, botId));
    console.log(`\nSaved to DB (bots.casCacheJson).`);
  }

  // ── Compare with cached data ──
  const cached = bot.casCacheJson as CasCacheData | null;
  if (cached?.entries && cached.entries.length > 0) {
    console.log(`\n${'═'.repeat(76)}`);
    console.log('DIFF vs DB cache');
    console.log(`${'═'.repeat(76)}`);
    console.log(`Cache refreshed: ${cached.refreshedAt}`);
    const cacheMap = new Map(cached.entries.map((e) => [e.date, e.slots]));
    let diffs = 0;
    for (const e of entries) {
      const cachedSlots = cacheMap.get(e.date);
      if (cachedSlots === undefined) {
        console.log(`  ${e.date}: NEW (${e.slots} slots) — not in cache`);
        diffs++;
      } else if (cachedSlots !== e.slots) {
        console.log(`  ${e.date}: ${cachedSlots} → ${e.slots} slots`);
        diffs++;
      }
    }
    for (const [date, slots] of cacheMap) {
      if (!entries.find((e) => e.date === date)) {
        console.log(`  ${date}: REMOVED from fresh (was ${slots} slots)`);
        diffs++;
      }
    }
    if (diffs === 0) console.log('  No differences — cache matches fresh data.');
    else console.log(`  ${diffs} difference(s) found.`);
  } else {
    console.log('\nNo cached data in DB to compare.');
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

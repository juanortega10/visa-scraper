/**
 * Pre-flight checks before launching the May-26 alignment snipers.
 * NO POSTs, only GETs. Probes availability for both bots' pools.
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { VisaClient } from '../src/services/visa-client.js';
import type { ProxyProvider } from '../src/services/proxy-fetch.js';

const BOT_IDS = [140, 141];
const TARGET_CAS_START = '2026-05-19';
const TARGET_CAS_END   = '2026-05-22';
const PROBE_CONSULAR_START = '2026-05-23'; // earliest plausible consular given CAS Tue-Fri
const PROBE_CONSULAR_END   = '2026-06-05'; // generous upper bound

const botRows = await db.select({
  id: bots.id,
  scheduleId: bots.scheduleId,
  applicantIds: bots.applicantIds,
  consularFacilityId: bots.consularFacilityId,
  ascFacilityId: bots.ascFacilityId,
  proxyProvider: bots.proxyProvider,
  userId: bots.userId,
  locale: bots.locale,
}).from(bots).where(inArray(bots.id, BOT_IDS));

console.log('=== PREFLIGHT — May 2026 alignment ===\n');

for (const b of botRows.sort((a, z) => a.id - z.id)) {
  console.log(`--- Bot ${b.id} (schedule ${b.scheduleId}, ${(b.applicantIds as string[]).length} aplicantes) ---`);

  const [session] = await db.select().from(sessions).where(eq(sessions.botId, b.id));
  if (!session) {
    console.log(`  ⚠️ NO session in DB — needs npm run login -- --bot-id=${b.id}`);
    console.log('');
    continue;
  }
  console.log(`  ✓ Session present (updated ${session.updatedAt?.toISOString() ?? '(unknown)'})`);

  const client = new VisaClient(
    {
      cookie: decrypt(session.yatriCookie),
      csrfToken: session.csrfToken ?? '',
      authenticityToken: session.authenticityToken ?? '',
    },
    {
      scheduleId: b.scheduleId,
      applicantIds: b.applicantIds,
      consularFacilityId: b.consularFacilityId,
      ascFacilityId: b.ascFacilityId,
      proxyProvider: (b.proxyProvider ?? 'direct') as ProxyProvider,
      userId: b.userId,
      locale: b.locale,
    },
  );

  try {
    const allDays = await client.getConsularDays();
    const totalDates = allDays.length;
    const inWindow = allDays.filter(d => d.date >= PROBE_CONSULAR_START && d.date <= PROBE_CONSULAR_END);
    console.log(`  Consular days available: ${totalDates} total, ${inWindow.length} in [${PROBE_CONSULAR_START}, ${PROBE_CONSULAR_END}]`);
    if (inWindow.length > 0) {
      console.log(`    First ${Math.min(5, inWindow.length)} in-window: ${inWindow.slice(0, 5).map(d => d.date).join(', ')}`);

      // For the first in-window consular, probe its CAS pool
      const first = inWindow[0]!;
      const consularTimes = await client.getConsularTimes(first.date);
      const firstTime = consularTimes.available_times[0];
      if (firstTime) {
        console.log(`    Probing CAS pool for ${first.date} ${firstTime}...`);
        const casDays = await client.getCasDays(first.date, firstTime);
        const casInWindow = casDays.filter(d => d.date >= TARGET_CAS_START && d.date <= TARGET_CAS_END);
        console.log(`    CAS days available: ${casDays.length} total, ${casInWindow.length} in [${TARGET_CAS_START}, ${TARGET_CAS_END}]`);
        if (casInWindow.length > 0) {
          console.log(`    ✓ CAS in window for this consular: ${casInWindow.map(d => d.date).join(', ')}`);
        } else {
          console.log(`    ✗ CAS pool: ${casDays.slice(0, 5).map(d => d.date).join(', ')}${casDays.length > 5 ? '...' : ''}`);
        }
      } else {
        console.log(`    ⚠️ No consular times for ${first.date}`);
      }
    } else {
      console.log(`    First 5 available (any date): ${allDays.slice(0, 5).map(d => d.date).join(', ')}`);
    }
  } catch (err) {
    console.log(`  ✗ Error fetching: ${err instanceof Error ? err.message : err}`);
  }
  console.log('');
}

// Webshare pool sanity
console.log('--- Webshare pool ---');
const { ProxyPoolManager } = await import('../src/services/proxy-fetch.js');
const pool = ProxyPoolManager.getInstance();
console.log(`  ${pool.getStateSummary?.() ?? '(stats not available)'}`);

process.exit(0);

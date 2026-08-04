import { db } from '../src/db/client.js';
import { bots, excludedDates } from '../src/db/schema.js';
import { eq, inArray } from 'drizzle-orm';

const ids = [140, 141];
const rows = await db.select().from(bots).where(inArray(bots.id, ids));
const excl = await db.select().from(excludedDates).where(inArray(excludedDates.botId, ids));

for (const b of rows.sort((a, z) => a.id - z.id)) {
  const cas = b.casCacheJson as { availableDates?: string[]; fetchedAt?: string } | null;
  console.log(`\n=== Bot ${b.id} (${b.locale}) ===`);
  console.log(`  status:               ${b.status}`);
  console.log(`  scheduleId:           ${b.scheduleId}`);
  console.log(`  applicants:           ${b.applicantIds}`);
  console.log(`  currentConsularDate:  ${b.currentConsularDate} ${b.currentConsularTime ?? ''}`);
  console.log(`  currentCasDate:       ${b.currentCasDate} ${b.currentCasTime ?? ''}`);
  console.log(`  currentConsulateId:   ${b.currentConsulateId}`);
  console.log(`  currentCasFacilityId: ${b.currentCasFacilityId}`);
  console.log(`  targetDateBefore:     ${b.targetDateBefore}`);
  console.log(`  maxReschedules:       ${b.maxReschedules} (used ${b.rescheduleCount})`);
  console.log(`  proxyProvider:        ${b.proxyProvider}`);
  console.log(`  pollEnvironments:     ${JSON.stringify(b.pollEnvironments)}`);
  console.log(`  pollIntervalSeconds:  ${b.pollIntervalSeconds}`);
  console.log(`  targetPollsPerMin:    ${b.targetPollsPerMin}`);
  console.log(`  isScout:              ${b.isScout}, isSubscriber: ${b.isSubscriber}`);
  console.log(`  activeRunId:          ${b.activeRunId}`);
  console.log(`  casCache:             ${cas ? `${cas.availableDates?.length ?? 0} dates, fetched ${cas.fetchedAt}` : 'null'}`);
  if (cas?.availableDates) {
    const may2026 = cas.availableDates.filter((d) => d.startsWith('2026-05'));
    if (may2026.length) console.log(`  CAS May 2026:         ${may2026.slice(0, 10).join(', ')}`);
  }
  const myExcl = excl.filter((e) => e.botId === b.id);
  if (myExcl.length) {
    console.log(`  excluded:             ${myExcl.map((e) => `${e.startDate}→${e.endDate}`).join(', ')}`);
  }
}
process.exit(0);

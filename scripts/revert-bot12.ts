import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { VisaClient } from '../src/services/visa-client.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function retry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) { if (i === retries) throw e; await sleep(1000); }
  }
  throw new Error('unreachable');
}

const [bot] = await db.select().from(bots).where(eq(bots.id, 12));
if (!bot) { console.error('Bot 12 not found'); process.exit(1); }
const [session] = await db.select().from(sessions).where(eq(sessions.botId, 12));
if (!session?.yatriCookie) { console.error('No session'); process.exit(1); }

const client = new VisaClient(
  { cookie: decrypt(session.yatriCookie), csrfToken: session.csrfToken, authenticityToken: session.authenticityToken },
  { scheduleId: bot.scheduleId, applicantIds: bot.applicantIds, consularFacilityId: bot.consularFacilityId, ascFacilityId: bot.ascFacilityId, proxyProvider: 'direct', locale: bot.locale },
);

console.log('Refreshing tokens...');
await client.refreshTokens();

// Get all days and find earliest before Nov 19 (current after my mistake)
const days = await retry(() => client.getConsularDays());
const beforeNov19 = days.filter(d => d.date < '2026-11-19').map(d => d.date);
console.log(`Dates before Nov 19: ${beforeNov19.length} — ${beforeNov19.join(', ')}`);

if (beforeNov19.length === 0) {
  console.log('\nNo dates before Nov 19 available for 4 people.');
  console.log('Current first date:', days[0]?.date);
  console.log('The original Nov 12 slot is gone for a group of 4.');

  // Just reschedule to Nov 19 (same as what we moved to) to keep it stable
  console.log('\nRescheduling back to Nov 19 (earliest available)...');
  const times = await retry(() => client.getConsularTimes('2026-11-19'));
  const consularTime = times.available_times.includes('09:00') ? '09:00' : times.available_times[0];
  await sleep(300);
  const casDays = await retry(() => client.getCasDays('2026-11-19', consularTime));
  const casDate = casDays[0]?.date;
  if (!casDate) { console.error('No CAS'); process.exit(1); }
  const casTimes = await retry(() => client.getCasTimes(casDate));
  const casTime = casTimes.available_times[0];

  console.log(`  ${consularTime} / CAS ${casDate} ${casTime}`);
  // Already at Nov 19 from the test-reschedule, just update DB
  await db.update(bots).set({
    currentConsularDate: '2026-11-19',
    currentConsularTime: consularTime,
    currentCasDate: casDate,
    currentCasTime: casTime,
    updatedAt: new Date(),
  }).where(eq(bots.id, 12));
  console.log('DB synced to Nov 19');
  process.exit(0);
}

for (const date of beforeNov19) {
  console.log(`\nTrying ${date}...`);
  const times = await retry(() => client.getConsularTimes(date));
  await sleep(300);
  if (times.available_times.length === 0) {
    console.log(`  No times`);
    continue;
  }
  console.log(`  Times: ${times.available_times.join(', ')}`);
  const consularTime = times.available_times.includes('09:00') ? '09:00' : times.available_times[0];

  const casDays = await retry(() => client.getCasDays(date, consularTime));
  await sleep(300);
  if (casDays.length === 0) { console.log(`  No CAS days`); continue; }

  const casDate = casDays[0].date;
  const casTimes = await retry(() => client.getCasTimes(casDate));
  if (casTimes.available_times.length === 0) { console.log(`  No CAS times`); continue; }

  const casTime = casTimes.available_times[0];
  console.log(`  Rescheduling: ${date} ${consularTime} / CAS ${casDate} ${casTime}`);
  const ok = await client.reschedule(date, consularTime, casDate, casTime);
  console.log(`  Result: ${ok ? 'SUCCESS' : 'FAILED'}`);

  if (ok) {
    await db.update(bots).set({
      currentConsularDate: date, currentConsularTime: consularTime,
      currentCasDate: casDate, currentCasTime: casTime, updatedAt: new Date(),
    }).where(eq(bots.id, 12));
    console.log('  DB updated');
    process.exit(0);
  }
}

console.error('Failed to revert');
process.exit(1);

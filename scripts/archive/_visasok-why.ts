import { db } from '../src/db/client.js';
import { bots, pollLogs } from '../src/db/schema.js';
import { inArray, eq, gte, sql, and } from 'drizzle-orm';

const IDS = [178,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211];
const since = new Date(Date.now() - 12 * 60_000);

// run state of the batch
const rows = await db.select({ id: bots.id, status: bots.status, activeRunId: bots.activeRunId, activeCloudRunId: bots.activeCloudRunId, envs: bots.pollEnvironments, consec: bots.consecutiveErrors }).from(bots).where(inArray(bots.id, IDS));
let withRun = 0, noRun = 0;
for (const b of rows) {
  if (b.activeRunId) withRun++; else noRun++;
}
console.log(`batch: status active=${rows.filter(r=>r.status==='active').length}/${IDS.length}  withActiveRunId=${withRun}  noRunId=${noRun}`);
console.log('per bot:');
for (const b of rows) console.log(`  ${b.id}: ${b.status} run=${b.activeRunId? b.activeRunId.slice(0,18):'NULL'} envs=${JSON.stringify(b.envs)} consec=${b.consec}`);

// fleet: total active, distinct polling, throughput
const totalActive = (await db.select({ id: bots.id }).from(bots).where(and(eq(bots.status,'active'), eq(bots.testMode,false)))).length;
const distinct = await db.select({ id: pollLogs.botId }).from(pollLogs).where(gte(pollLogs.createdAt, since)).groupBy(pollLogs.botId);
const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(pollLogs).where(gte(pollLogs.createdAt, since));
console.log(`\nfleet: totalActive=${totalActive}  distinctPolling(12m)=${distinct.length}  polls(12m)=${c} (~${Math.round((c as number)/12)}/min)`);
const batchPolling = distinct.filter(d => IDS.includes(d.id!)).map(d=>d.id);
console.log(`batch bots that polled (12m): ${batchPolling.length} -> ${batchPolling.join(',') || 'none'}`);
process.exit(0);

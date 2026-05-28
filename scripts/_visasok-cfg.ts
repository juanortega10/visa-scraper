import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { inArray } from 'drizzle-orm';

const ab = await db.select({
  id: bots.id, status: bots.status, proxyProvider: bots.proxyProvider,
  pollIntervalSeconds: bots.pollIntervalSeconds, targetPollsPerMin: bots.targetPollsPerMin,
  pollEnvironments: bots.pollEnvironments, cloudEnabled: bots.cloudEnabled,
  rescheduleCount: bots.rescheduleCount, maxReschedules: bots.maxReschedules,
}).from(bots).where(inArray(bots.id, [179, 180]));
const ss = await db.select({ botId: sessions.botId, createdAt: sessions.createdAt }).from(sessions).where(inArray(sessions.botId, [179, 180]));
for (const b of ab) {
  const s = ss.find((x) => x.botId === b.id);
  console.log(JSON.stringify({ ...b, sessionAgeMin: s ? Math.round((Date.now() - s.createdAt.getTime()) / 60000) : 'NO SESSION' }));
}
process.exit(0);

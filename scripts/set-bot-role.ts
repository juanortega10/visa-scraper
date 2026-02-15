import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { MAX_SCOUTS_PER_FACILITY } from '../src/utils/constants.js';

// Usage: npx tsx scripts/set-bot-role.ts <botId> <role>
// Roles: scout, subscriber, scout+subscriber
const botId = parseInt(process.argv[2] ?? '');
const roleArg = process.argv[3] ?? '';

if (!botId || !roleArg) {
  console.error('Usage: npx tsx scripts/set-bot-role.ts <botId> <role>');
  console.error('Roles: scout, subscriber, scout+subscriber');
  process.exit(1);
}

const VALID_ROLES = ['scout', 'subscriber', 'scout+subscriber'];
if (!VALID_ROLES.includes(roleArg)) {
  console.error(`Invalid role: ${roleArg}. Must be one of: ${VALID_ROLES.join(', ')}`);
  process.exit(1);
}

const isScout = roleArg.includes('scout');
const isSubscriber = roleArg.includes('subscriber');

// Validate scout limit
if (isScout) {
  const [bot] = await db.select({ consularFacilityId: bots.consularFacilityId }).from(bots).where(eq(bots.id, botId));
  if (!bot) {
    console.error(`Bot ${botId} not found`);
    process.exit(1);
  }

  const scoutCount = await db.select({ count: sql<number>`count(*)::int` }).from(bots)
    .where(and(
      eq(bots.consularFacilityId, bot.consularFacilityId),
      eq(bots.isScout, true),
      inArray(bots.status, ['active', 'login_required', 'paused']),
    ));
  const existing = scoutCount[0]?.count ?? 0;

  // Exclude this bot from count if it's already a scout
  const [self] = await db.select({ isScout: bots.isScout, status: bots.status }).from(bots).where(eq(bots.id, botId));
  const selfCounted = self?.isScout && ['active', 'login_required', 'paused'].includes(self.status) ? 1 : 0;
  const othersCount = existing - selfCounted;

  if (othersCount >= MAX_SCOUTS_PER_FACILITY) {
    console.error(`Cannot set bot ${botId} as scout: facility ${bot.consularFacilityId} already has ${othersCount} scout(s) (max: ${MAX_SCOUTS_PER_FACILITY})`);
    process.exit(1);
  }
}

const [b] = await db.update(bots)
  .set({ isScout, isSubscriber })
  .where(eq(bots.id, botId))
  .returning({ id: bots.id, isScout: bots.isScout, isSubscriber: bots.isSubscriber, status: bots.status });

console.log(`Bot ${botId}:`, b);
process.exit(0);

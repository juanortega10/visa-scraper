/**
 * Test all notification templates by sending mock emails via Resend.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/test-notifications.ts
 *   npx tsx --env-file=.env scripts/test-notifications.ts --event=tcp_blocked   # single event
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { notifyUser } from '../src/services/notifications.js';

const args = process.argv.slice(2);
const eventFilter = args.find((a) => a.startsWith('--event='))?.split('=')[1];
const botId = parseInt(args.find((a) => a.startsWith('--bot-id='))?.split('=')[1] ?? '6', 10);

const mockEvents: Array<{ event: string; data: Record<string, unknown> }> = [
  {
    event: 'reschedule_success',
    data: {
      oldConsularDate: '2026-11-30',
      oldConsularTime: '08:45',
      newConsularDate: '2026-07-24',
      newConsularTime: '08:45',
      newCasDate: '2026-07-13',
      newCasTime: '07:00',
    },
  },
  {
    event: 'reschedule_success',
    data: {
      dryRun: true,
      oldConsularDate: '2026-07-24',
      oldConsularTime: '08:45',
      newConsularDate: '2026-07-19',
      newConsularTime: '09:00',
      newCasDate: '2026-07-10',
      newCasTime: '07:30',
    },
  },
  {
    event: 'reschedule_failed',
    data: {
      totalDurationMs: 4523,
      currentDate: '2026-07-24',
      attempts: [
        { date: '2026-06-15', consularTime: '08:00', failReason: 'no_cas_days', durationMs: 1200 },
        { date: '2026-06-18', consularTime: '09:15', casDate: '2026-06-10', failReason: 'no_cas_times', durationMs: 1800 },
        { date: '2026-06-20', consularTime: '08:30', casDate: '2026-06-12', casTime: '07:00', failReason: 'post_failed', durationMs: 1523 },
      ],
    },
  },
  {
    event: 'session_expired',
    data: {
      message: 'Session expired. login-visa task will attempt re-login. If it fails, run `npm run login`.',
      scheduleId: process.env.TEST_SCHEDULE_ID || 'XXXXXXXX',
    },
  },
  {
    event: 'tcp_blocked',
    data: {
      error: 'fetch failed',
      window: 'super-critical',
      fetchNumber: 4,
      consecutiveErrors: 2,
    },
  },
  {
    event: 'server_throttled',
    data: {
      consecutive5xx: 3,
      window: 'super-critical',
      error: 'Consular days failed: HTTP 502',
    },
  },
  {
    event: 'soft_ban_suspected',
    data: {
      previousCount: 71,
      currentCount: 2,
      window: 'burst',
    },
  },
  {
    event: 'bot_error',
    data: {
      message: 'Bot stopped after 5 consecutive errors',
      lastError: 'fetch failed',
      tcpBlock: true,
    },
  },
  {
    event: 'bot_error',
    data: {
      message: 'Bot stopped after 5 consecutive errors',
      lastError: 'Consular days failed: HTTP 502',
      tcpBlock: false,
    },
  },
];

async function main() {
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) {
    console.error(`Bot ${botId} not found`);
    process.exit(1);
  }
  if (!bot.notificationEmail) {
    console.error(`Bot ${botId} has no notification email configured`);
    process.exit(1);
  }
  console.log(`Sending test notifications to: ${bot.notificationEmail}\n`);

  const toSend = eventFilter
    ? mockEvents.filter((e) => e.event === eventFilter)
    : mockEvents;

  if (toSend.length === 0) {
    console.error(`No mock event found for: ${eventFilter}`);
    console.log('Available events:', mockEvents.map((e) => e.event).join(', '));
    process.exit(1);
  }

  for (const { event, data } of toSend) {
    try {
      console.log(`  Sending: ${event}...`);
      await notifyUser(bot, event, data);
      console.log(`  OK: ${event}`);
    } catch (err) {
      console.error(`  FAIL: ${event} — ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\nDone — ${toSend.length} email(s) sent. Check ${bot.notificationEmail}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

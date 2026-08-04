/**
 * Monitor bots and restart-chain if they haven't polled in the watch window.
 * Counts poll_logs created AFTER the marker timestamp (passed via --since).
 *
 * Usage: npx tsx --env-file=.env scripts/_monitor-and-restart.ts <bot1,bot2,...> [--since=ISO]
 */
import { db } from '../src/db/client.js';
import { pollLogs } from '../src/db/schema.js';
import { runs } from '@trigger.dev/sdk';
import { and, eq, gte } from 'drizzle-orm';

const ids = (process.argv[2] ?? '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
const sinceArg = process.argv.find(a => a.startsWith('--since='))?.slice(8);
const since = sinceArg ? new Date(sinceArg) : new Date(Date.now() - 60_000);

if (ids.length === 0) { console.log('Usage: <bot1,bot2,...> [--since=ISO]'); process.exit(1); }

const API_KEY = process.env.API_KEY!;
const API_URL = 'https://visa.homiapp.xyz';

const log = (...a: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...a);

log(`Checking polls since ${since.toISOString()} for bots ${ids.join(', ')}`);

for (const botId of ids) {
  const polls = await db.select({ id: pollLogs.id }).from(pollLogs)
    .where(and(eq(pollLogs.botId, botId), gte(pollLogs.createdAt, since)));
  log(`  bot ${botId}: ${polls.length} polls since marker`);

  if (polls.length > 0) continue;

  log(`  bot ${botId}: NO polls — cancelling orphan runs + restart-chain`);
  let cancelled = 0;
  for (const status of ['EXECUTING', 'DEQUEUED', 'QUEUED', 'DELAYED'] as const) {
    for await (const r of runs.list({ tag: [`bot:${botId}`], status: [status], limit: 100 })) {
      try { await runs.cancel(r.id); cancelled++; } catch { /* ignore */ }
    }
  }
  log(`    cancelled ${cancelled} orphan runs`);

  const resp = await fetch(`${API_URL}/api/bots/${botId}/restart-chain`, {
    method: 'POST', headers: { 'X-API-Key': API_KEY },
  });
  const body = await resp.json().catch(() => ({}));
  log(`    restart-chain HTTP ${resp.status}:`, body);
}

process.exit(0);

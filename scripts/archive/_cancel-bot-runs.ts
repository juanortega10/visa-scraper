import { runs } from '@trigger.dev/sdk';

const botId = parseInt(process.argv[2] ?? '0', 10);
if (!botId) { console.log('Usage: _cancel-bot-runs.ts <botId>'); process.exit(1); }

const states = ['EXECUTING', 'DEQUEUED', 'QUEUED', 'DELAYED'] as const;

let total = 0;
for (const status of states) {
  for await (const run of runs.list({ tag: [`bot:${botId}`], status: [status], limit: 100 })) {
    try {
      await runs.cancel(run.id);
      console.log(`Cancelled ${run.id} (was ${status})`);
      total++;
    } catch (e) {
      console.log(`Failed to cancel ${run.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
console.log(`\nTotal cancelled: ${total}`);
process.exit(0);

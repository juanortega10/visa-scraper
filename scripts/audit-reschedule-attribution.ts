/**
 * Reschedule attribution auditor — who actually moved each appointment?
 *
 * Billing is "days advanced x price", so every day credited to the bot must be a day
 * the bot really produced. Two known ways a manual (owner) move gets billed to the bot:
 *
 *   1. [post_error_recovered] mis-attribution. The POST threw a network error, the safety
 *      net re-read /groups, saw a different date, and logged success=true — even when that
 *      date was never the bot's target. Fixed in reschedule-logic.ts (attribution guard),
 *      but historical rows still carry the error. Detected here as SUSPECT.
 *
 *   2. Chain breaks. Successful reschedules form a chain: row N's newConsularDate must equal
 *      row N+1's oldConsularDate. A break means the appointment moved with no bot log —
 *      an external change. Detected here as EXTERNAL.
 *
 * Method: replay each bot's successful reschedules in time order and account for every day
 * between the first known date and the last. Nothing is inferred from the success flag alone.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/audit-reschedule-attribution.ts              # whole fleet
 *   npx tsx --env-file=.env scripts/audit-reschedule-attribution.ts --bot 266    # one bot
 *   npx tsx --env-file=.env scripts/audit-reschedule-attribution.ts --price 1000 # billing view
 *   npx tsx --env-file=.env scripts/audit-reschedule-attribution.ts --json
 *
 * Exit code 1 if any SUSPECT row is found (use it as a CI / monitoring gate).
 */
import { db } from '../src/db/client.js';
import { rescheduleLogs, bots } from '../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { auditReschedules, type AttributionSummary } from '../src/services/reschedule-attribution.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const onlyBot = flag('bot') ? Number(flag('bot')) : null;
const price = flag('price') ? Number(flag('price')) : 0;
const asJson = args.includes('--json');

type BotAudit = AttributionSummary & { botId: number };

async function auditBot(botId: number): Promise<BotAudit | null> {
  const rows = await db
    .select()
    .from(rescheduleLogs)
    .where(eq(rescheduleLogs.botId, botId))
    .orderBy(asc(rescheduleLogs.createdAt), asc(rescheduleLogs.id));

  const summary = auditReschedules(rows);
  if (summary.moves.length === 0) return null;
  return { botId, ...summary };
}

async function main() {
  const ids = onlyBot
    ? [onlyBot]
    : (await db.select({ id: bots.id }).from(bots).orderBy(asc(bots.id))).map((b) => b.id);

  const audits: BotAudit[] = [];
  for (const id of ids) {
    const a = await auditBot(id);
    if (a) audits.push(a);
  }

  if (asJson) {
    console.log(JSON.stringify(audits, null, 2));
  } else {
    for (const a of audits) {
      const hasNoise = a.externalDays > 0 || a.suspectDays > 0;
      if (!onlyBot && !hasNoise) continue; // fleet view: only show bots that need a look
      console.log(`\n── bot ${a.botId}  ${a.firstDate} → ${a.lastDate}`);
      for (const m of a.moves) {
        const tag = m.suspect ? 'SUSPECT ' : m.actor === 'external' ? 'EXTERNAL' : 'BOT     ';
        const when = m.at ? m.at.slice(0, 16).replace('T', ' ') : '      (gap)     ';
        console.log(`   ${tag} ${when}  ${m.from} → ${m.to}  ${String(m.days).padStart(4)}d  ${m.note}`);
      }
      console.log(
        `   bot=${a.botDays}d  external=${a.externalDays}d  suspect=${a.suspectDays}d  net=${a.netDays}d`,
      );
      if (price > 0) {
        console.log(
          `   billing: confirmed ${a.billableDays}d = $${(a.billableDays * price).toLocaleString('es-CO')}` +
            (a.suspectDays > 0 ? `  (+${a.suspectDays}d suspect, review before charging)` : ''),
        );
      }
    }
  }

  const suspects = audits.filter((a) => a.suspectDays > 0);
  const external = audits.filter((a) => a.externalDays > 0);
  console.error(
    `\nbots with moves: ${audits.length} | with external moves: ${external.length} | with SUSPECT rows: ${suspects.length}`,
  );
  if (suspects.length > 0) {
    console.error(`SUSPECT bots: ${suspects.map((a) => `${a.botId}(${a.suspectDays}d)`).join(', ')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

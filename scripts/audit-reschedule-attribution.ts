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

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const onlyBot = flag('bot') ? Number(flag('bot')) : null;
const price = flag('price') ? Number(flag('price')) : 0;
const asJson = args.includes('--json');

const DAY_MS = 86400000;
/** Whole days between two YYYY-MM-DD dates. Positive = `to` is earlier than `from`. */
function daysEarlier(from: string, to: string): number {
  return Math.round((new Date(`${from}T00:00:00Z`).getTime() - new Date(`${to}T00:00:00Z`).getTime()) / DAY_MS);
}

interface Move {
  at: string;
  from: string;
  to: string;
  days: number;
  actor: 'bot' | 'external';
  kind: 'clean' | 'post_error_recovered' | 'chain_break';
  suspect: boolean;
  note: string;
  logId: number | null;
}

interface BotAudit {
  botId: number;
  firstDate: string | null;
  lastDate: string | null;
  botDays: number;
  externalDays: number;
  suspectDays: number;
  moves: Move[];
}

async function auditBot(botId: number): Promise<BotAudit | null> {
  const rows = await db
    .select()
    .from(rescheduleLogs)
    .where(eq(rescheduleLogs.botId, botId))
    .orderBy(asc(rescheduleLogs.createdAt), asc(rescheduleLogs.id));

  // Rows that assert the appointment actually moved.
  const moved = rows.filter(
    (r) => r.success === true && r.oldConsularDate && r.newConsularDate && r.oldConsularDate !== r.newConsularDate,
  );
  if (moved.length === 0) return null;

  // A later portal_reversion cancels the success it names in oldConsularDate.
  const reverted = new Set(
    rows
      .filter((r) => r.success === false && typeof r.error === 'string' && r.error.startsWith('portal_reversion'))
      .map((r) => `${r.oldConsularDate}->${r.newConsularDate}`),
  );

  const moves: Move[] = [];
  let chainDate: string | null = null;

  for (const r of moved) {
    const from = r.oldConsularDate!;
    const to = r.newConsularDate!;
    const err = typeof r.error === 'string' ? r.error : '';

    // Chain break: the appointment was somewhere else before this row's `old`.
    if (chainDate && chainDate !== from) {
      moves.push({
        at: r.createdAt ? new Date(r.createdAt).toISOString() : '',
        from: chainDate,
        to: from,
        days: daysEarlier(chainDate, from),
        actor: 'external',
        kind: 'chain_break',
        suspect: false,
        note: 'no bot log covers this move — changed outside the bot',
        logId: null,
      });
    }

    if (reverted.has(`${to}->${from}`)) {
      chainDate = from;
      continue; // the portal took it back; not a real move
    }

    // Mis-attribution risk: recovered-from-error rows are only trustworthy when the
    // portal landed on the exact date the bot POSTed. Pre-fix rows did not check that.
    const recovered = err.startsWith('[post_error_recovered]');
    moves.push({
      at: r.createdAt ? new Date(r.createdAt).toISOString() : '',
      from,
      to,
      days: daysEarlier(from, to),
      actor: 'bot',
      kind: recovered ? 'post_error_recovered' : 'clean',
      suspect: recovered,
      note: recovered
        ? 'POST errored; credited by re-read. Pre-fix rows may be an owner move.'
        : err,
      logId: r.id,
    });
    chainDate = to;
  }

  const botDays = moves.filter((m) => m.actor === 'bot').reduce((s, m) => s + m.days, 0);
  const externalDays = moves.filter((m) => m.actor === 'external').reduce((s, m) => s + m.days, 0);
  const suspectDays = moves.filter((m) => m.suspect).reduce((s, m) => s + m.days, 0);

  return {
    botId,
    firstDate: moves[0]?.from ?? null,
    lastDate: chainDate,
    botDays,
    externalDays,
    suspectDays,
    moves,
  };
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
      // Net = first known date → last known date. Days billed to the bot can never
      // exceed this, whatever the per-move accounting says.
      const net = a.firstDate && a.lastDate ? daysEarlier(a.firstDate, a.lastDate) : 0;
      console.log(`   bot=${a.botDays}d  external=${a.externalDays}d  suspect=${a.suspectDays}d  net=${net}d`);
      if (price > 0) {
        const billable = Math.min(a.botDays - a.suspectDays, net);
        console.log(
          `   billing: confirmed ${billable}d = $${(billable * price).toLocaleString('es-CO')}` +
            (a.suspectDays > 0 ? `  (+${a.suspectDays}d suspect, review before charging; ceiling ${net}d)` : ''),
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

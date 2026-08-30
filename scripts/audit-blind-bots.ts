/**
 * Blind-bot detector — active bots that poll but never see a single date.
 *
 * A bot whose consular facility is wrong polls a real endpoint, gets HTTP 200, and
 * receives `[]` every time. Every layer downstream reads that as normal:
 *
 *   - `poll-visa.ts` logs it as `filtered_out`, the same status as "there were dates
 *     but none qualified". Nothing distinguishes the two in the dashboard.
 *   - The soft-ban detector (`poll-visa.ts:662`) needs a prior median above 15 dates
 *     before it fires. A bot that has never seen a date can never reach that median,
 *     so it is structurally exempt from the only existing alarm.
 *   - `prefetch-cas.ts` aborts at `no_consular_dates` and writes a log row nobody reads.
 *
 * So the failure is silent and permanent. Bot 281 (es-mx) ran 24,253 polls over 6 days
 * against Ciudad Juarez (facility 65) while its appointment was in Mexico City (70).
 * Zero dates, zero errors, zero alerts, and a paying client with no service.
 *
 * This checks the one invariant those layers miss: a bot that polls enough times must
 * eventually see SOMETHING. `max(raw_dates_count) = 0` over a large sample is not low
 * availability — it is a misconfigured facility.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/audit-blind-bots.ts
 *   npx tsx --env-file=.env scripts/audit-blind-bots.ts --hours 48 --min-polls 200
 *   npx tsx --env-file=.env scripts/audit-blind-bots.ts --json
 *
 * Exit code 1 if any blind bot is found (use it as a cron / monitoring gate).
 */
import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? dflt) : dflt;
};

const hours = Number(flag('hours', '24'));
const minPolls = Number(flag('min-polls', '100'));
const asJson = args.includes('--json');

interface Row {
  bot_id: number;
  locale: string;
  status: string;
  consular_facility_id: string | null;
  asc_facility_id: string | null;
  current_consular_date: string | null;
  log_rows: string;
  real_polls: string;
  max_dates: number | null;
  last_poll: string;
}

// `polls_since_prev` is the exact number of real polls a written row stands in for
// (see poll-logging.ts), so `sum` gives true poll volume even under write reduction.
const res = await db.execute(sql`
  SELECT b.id                      AS bot_id,
         b.locale,
         b.status,
         b.consular_facility_id,
         b.asc_facility_id,
         b.current_consular_date,
         count(*)                  AS log_rows,
         sum(p.polls_since_prev)   AS real_polls,
         max(p.raw_dates_count)    AS max_dates,
         max(p.created_at)         AS last_poll
  FROM poll_logs p
  JOIN bots b ON b.id = p.bot_id
  WHERE b.status = 'active'
    AND p.created_at > now() - (${hours} * interval '1 hour')
  GROUP BY b.id, b.locale, b.status, b.consular_facility_id, b.asc_facility_id, b.current_consular_date
  HAVING sum(p.polls_since_prev) >= ${minPolls}
     AND coalesce(max(p.raw_dates_count), 0) = 0
  ORDER BY sum(p.polls_since_prev) DESC
`);

const rows = res.rows as unknown as Row[];

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(`Bots ciegos — activos, >=${minPolls} polls en ${hours}h, 0 fechas vistas\n`);
  if (rows.length === 0) {
    console.log('  ninguno');
  } else {
    // A bot whose appointment date already passed can never reschedule (it needs a
    // strictly earlier slot), so it is a dead bot for a different reason. Separate it:
    // conflating the two hides the facility bug behind a pile of expired bots.
    const today = new Date().toISOString().split('T')[0]!;
    const expired = rows.filter(r => r.current_consular_date && String(r.current_consular_date).slice(0, 10) < today);
    const blind = rows.filter(r => !expired.includes(r));

    const line = (r: Row, tag: string) =>
      `  bot ${String(r.bot_id).padStart(4)} · ${r.locale} · consular=${r.consular_facility_id} asc=${r.asc_facility_id}` +
      ` · cita=${String(r.current_consular_date ?? 'n/a').slice(0, 10)} · ${r.real_polls} polls${tag}`;

    if (blind.length > 0) {
      console.log('FACILITY SOSPECHOSO — cita vigente y aun asi cero fechas:');
      for (const r of blind) console.log(line(r, ''));
      console.log(
        `\n  Revisa el facility contra la opcion <option selected> del formulario` +
        ` /schedule/{id}/appointment antes de asumir que el consulado no tiene cupos.`,
      );
    }
    if (expired.length > 0) {
      if (blind.length > 0) console.log('');
      console.log('CITA VENCIDA — no puede reagendar, necesita fecha estrictamente anterior:');
      for (const r of expired) console.log(line(r, ''));
    }
  }
}

process.exit(rows.length > 0 ? 1 : 0);

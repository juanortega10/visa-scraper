import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
import fs from 'fs';

const r = await db.execute(sql`
  SELECT pl.id, pl.bot_id, pl.created_at, pl.all_dates
  FROM poll_logs pl
  JOIN bots b ON b.id = pl.bot_id
  WHERE pl.all_dates IS NOT NULL AND pl.status IN ('ok','filtered_out')
    AND pl.created_at > now() - interval '10 days'
    AND b.locale = 'es-co' AND b.consular_facility_id = '25'
`);
console.log('rows fetched:', r.rows.length);
const out = r.rows.map((row: any) => ({
  id: row.id,
  bot_id: row.bot_id,
  created_at: row.created_at,
  dates: (row.all_dates || []).map((d: any) => d.date),
}));
fs.writeFileSync('/private/tmp/claude-501/-Users-juanortega-visa-scraper/27e21829-715b-452d-a193-322c0e07e065/scratchpad/polls.json', JSON.stringify(out));
console.log('written');
process.exit(0);

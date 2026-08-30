import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
for (const t of ['date_sightings','bookable_events','dispatch_logs','cas_prefetch_logs']) {
  try {
    const r = await db.execute(sql.raw(`SELECT count(*) n, min(created_at_col) mn, max(created_at_col) mx FROM (
      SELECT ${t==='date_sightings'?'appeared_at':t==='bookable_events'?'detected_at':'created_at'} AS created_at_col FROM ${t}) x`));
    console.log(t, r.rows[0]);
  } catch(e:any) { console.log(t, 'ERR', e.message); }
}
process.exit(0);

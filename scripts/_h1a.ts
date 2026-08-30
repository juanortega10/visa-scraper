import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const a = await db.execute(sql`
  SELECT count(*) n,
         count(*) FILTER (WHERE all_dates IS NOT NULL) with_all,
         count(*) FILTER (WHERE top_dates IS NOT NULL) with_top,
         count(*) FILTER (WHERE raw_dates_count IS NOT NULL) with_raw
  FROM poll_logs WHERE created_at > now() - interval '10 days'`);
console.log('cobertura de campos:', a.rows[0]);
const p = await db.execute(sql`
  SELECT b.locale, b.consular_facility_id fac, COALESCE(jsonb_array_length(b.applicant_ids),0) napp,
         count(*) bots, array_agg(b.id ORDER BY b.id) ids
  FROM bots b
  WHERE b.id IN (SELECT DISTINCT bot_id FROM poll_logs WHERE created_at > now() - interval '10 days' AND all_dates IS NOT NULL)
  GROUP BY 1,2,3 HAVING count(*) > 1 ORDER BY bots DESC LIMIT 20`);
console.log('=== grupos comparables (mismo locale+facility+#solicitantes) ===');
console.table(p.rows);
process.exit(0);

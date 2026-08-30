import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

// Base: reproduce the core dataset - distinct bots per category in es-co/facility-25
const r = await db.execute(sql`
  SELECT b.id as bot_id, b.visa_category, jsonb_array_length(b.applicant_ids) as napp,
         b.consular_facility_id, b.asc_facility_id, b.schedule_id, b.agency_id,
         b.proxy_provider, b.poll_environments, b.created_at as bot_created_at,
         b.locale
  FROM bots b
  WHERE b.locale = 'es-co' AND b.consular_facility_id = '25'
    AND b.id IN (
      SELECT DISTINCT bot_id FROM poll_logs
      WHERE all_dates IS NOT NULL AND status IN ('ok','filtered_out')
        AND created_at > now() - interval '10 days'
    )
  ORDER BY b.visa_category NULLS LAST, napp, b.id
`);
console.table(r.rows);
process.exit(0);

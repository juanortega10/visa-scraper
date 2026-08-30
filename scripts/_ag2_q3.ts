import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`
  SELECT id, visa_category, jsonb_array_length(to_jsonb(applicant_ids)) as n_applicants,
         consular_facility_id, locale, status, is_scout, is_subscriber, current_consular_date
  FROM bots WHERE id IN (6,12,17,18)
  ORDER BY id
`);
console.log(JSON.stringify(r.rows, null, 2));
process.exit(0);

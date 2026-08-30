import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

const r = await db.execute(sql`
  SELECT visa_category, count(*) as n_bots,
    count(DISTINCT consular_facility_id) as n_facility,
    count(DISTINCT asc_facility_id) as n_asc,
    count(DISTINCT proxy_provider) as n_proxy,
    array_agg(DISTINCT proxy_provider) as proxies,
    count(DISTINCT visa_class_id) as n_classid,
    array_agg(DISTINCT visa_class_id) as classids,
    count(DISTINCT poll_environments::text) as n_env,
    array_agg(DISTINCT poll_environments::text) as envs,
    count(DISTINCT agency_id) as n_agency
  FROM bots
  WHERE id IN (185,248,255,263,180,242,262,179,219,246,251,253,235,240,249,260,261,66,105,107,114,136)
  GROUP BY visa_category
`);
console.table(r.rows);
process.exit(0);

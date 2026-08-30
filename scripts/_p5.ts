import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const b = await db.execute(sql`
  SELECT locale, consular_facility_id fac, asc_facility_id asc_fac, status, count(*) bots,
    array_agg(id ORDER BY id) ids, count(*) FILTER (WHERE visa_category IS NOT NULL) con_cat
  FROM bots WHERE locale NOT IN ('es-co') GROUP BY 1,2,3,4 ORDER BY 1,2,4`);
console.log('=== bots fuera de es-co, por consulado y estado ===');
console.table(b.rows);
const s = await db.execute(sql`
  SELECT b.locale, b.consular_facility_id fac, b.status, count(ds.id) sightings,
    count(DISTINCT ds.bot_id) bots_con_datos,
    sum(COALESCE(p.pl,0)) polls
  FROM bots b
  LEFT JOIN date_sightings ds ON ds.bot_id=b.id AND ds.appeared_at > now()-interval '160 days'
  LEFT JOIN (SELECT bot_id, sum(COALESCE(polls_since_prev,1)) pl FROM poll_logs
             WHERE created_at > now()-interval '10 days' GROUP BY 1) p ON p.bot_id=b.id
  WHERE b.locale NOT IN ('es-co') GROUP BY 1,2,3 ORDER BY 4 DESC`);
console.log('=== datos disponibles por consulado fuera de es-co ===');
console.table(s.rows);
process.exit(0);

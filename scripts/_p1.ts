import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// Que hay realmente por locale + facility
const r = await db.execute(sql`
  SELECT b.locale, b.consular_facility_id fac, count(*) n,
    count(DISTINCT ds.bot_id) bots,
    min(ds.appeared_at)::date desde, max(ds.appeared_at)::date hasta
  FROM date_sightings ds JOIN bots b ON b.id=ds.bot_id
  WHERE ds.appeared_at > now()-interval '160 days'
  GROUP BY 1,2 ORDER BY n DESC`);
console.log('=== volumen por locale + consulado ===');
console.table(r.rows);
// exposicion: polls por hora del dia y locale (10 dias) — para saber si es plana
const e = await db.execute(sql`
  SELECT b.locale,
    round(100.0*count(*) FILTER (WHERE EXTRACT(HOUR FROM p.created_at) < 6)/count(*),1) h00_05,
    round(100.0*count(*) FILTER (WHERE EXTRACT(HOUR FROM p.created_at) BETWEEN 6 AND 11)/count(*),1) h06_11,
    round(100.0*count(*) FILTER (WHERE EXTRACT(HOUR FROM p.created_at) BETWEEN 12 AND 17)/count(*),1) h12_17,
    round(100.0*count(*) FILTER (WHERE EXTRACT(HOUR FROM p.created_at) >= 18)/count(*),1) h18_23,
    count(*) n
  FROM poll_logs p JOIN bots b ON b.id=p.bot_id
  WHERE p.created_at > now()-interval '10 days' GROUP BY 1 ORDER BY 6 DESC`);
console.log('=== exposicion de sondeo por franja UTC (uniforme = 25% cada una) ===');
console.table(e.rows);
process.exit(0);

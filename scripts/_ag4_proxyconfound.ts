import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

// Within B1/B2 1-app group, does direct-vs-webshare pairing show lower Jaccard than webshare-vs-webshare?
// bots: 185(direct), 248(webshare), 255(webshare), 263(webshare)
const r = await db.execute(sql`
WITH polls AS (
  SELECT pl.id, pl.bot_id, pl.created_at,
         (SELECT array_agg(x->>'date') FROM jsonb_array_elements(pl.all_dates) x) AS dates
  FROM poll_logs pl
  WHERE pl.bot_id IN (185,248,255,263)
    AND pl.all_dates IS NOT NULL AND pl.status IN ('ok','filtered_out')
    AND pl.created_at > now() - interval '10 days'
)
SELECT a.bot_id as bot_a, b.bot_id as bot_b, count(*) n,
  round(avg(
    (SELECT count(*) FROM unnest(a.dates) d WHERE d = ANY(b.dates))::numeric /
    NULLIF(cardinality(array(SELECT unnest(a.dates) UNION SELECT unnest(b.dates))),0)
  ),4) as jaccard
FROM polls a JOIN polls b ON a.bot_id < b.bot_id AND abs(extract(epoch from a.created_at-b.created_at))<=5
GROUP BY a.bot_id, b.bot_id ORDER BY 1,2
`);
console.table(r.rows);
process.exit(0);

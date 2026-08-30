import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

async function secondOfMinute(label: string, locale: string, maxGap: number) {
  const r = await db.execute(sql`
    WITH s AS (
      SELECT p.bot_id, p.created_at AS t,
             lag(p.created_at) OVER (PARTITION BY p.bot_id ORDER BY p.created_at) AS tp,
             COALESCE(jsonb_array_length(p.date_changes->'appeared'),0) AS app
      FROM poll_logs p JOIN bots b ON b.id=p.bot_id
      WHERE p.created_at > now() - interval '10 days' AND b.locale = ${locale}
    ), iv AS (
      SELECT t, app, EXTRACT(EPOCH FROM t - tp)::int AS g
      FROM s WHERE tp IS NOT NULL
    ), f AS (
      SELECT t, app, g FROM iv WHERE g BETWEEN 1 AND ${maxGap}
    ), ex AS (
      SELECT ((EXTRACT(EPOCH FROM f.t)::bigint - k) % 60)::int AS sec,
             1.0 AS expo,
             CASE WHEN f.app>0 THEN 1.0/f.g ELSE 0 END AS ev
      FROM f, generate_series(0, f.g-1) k
    )
    SELECT sec/5*5 AS bucket, sum(expo) expo, round(sum(ev)::numeric,1) events,
           round((1000.0*sum(ev)/sum(expo))::numeric,3) AS per_1000s
    FROM ex GROUP BY 1 ORDER BY 1`);
  console.log(`\n=== ${label} · seg-del-minuto (bucket 5s, maxGap ${maxGap}s) ===`);
  console.table(r.rows);
}

await secondOfMinute('es-co', 'es-co', 30);
await secondOfMinute('es-pe', 'es-pe', 15);
process.exit(0);

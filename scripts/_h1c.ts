import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

const base = sql`
  WITH d AS (
    SELECT p.id, p.bot_id, p.created_at,
           ARRAY(SELECT x->>'date' FROM jsonb_array_elements(p.all_dates) x) AS dates
    FROM poll_logs p JOIN bots b ON b.id = p.bot_id
    WHERE p.created_at > now() - interval '10 days'
      AND p.all_dates IS NOT NULL AND p.status IN ('ok','filtered_out')
      AND b.locale='es-co' AND b.consular_facility_id='25'
      AND jsonb_array_length(b.applicant_ids)=1
  ), s AS (SELECT *, (EXTRACT(EPOCH FROM created_at)::bigint/20) bkt FROM d),
  pairs AS (
    SELECT a.bot_id ba, b.bot_id bb, a.created_at ts,
           cardinality(a.dates) na, cardinality(b.dates) nb,
           cardinality(ARRAY(SELECT unnest(a.dates) INTERSECT SELECT unnest(b.dates))) inter,
           cardinality(ARRAY(SELECT unnest(a.dates) UNION SELECT unnest(b.dates))) uni,
           (SELECT min(x) FROM unnest(a.dates) x) ea,
           (SELECT min(x) FROM unnest(b.dates) x) eb,
           cardinality(ARRAY(SELECT unnest(a.dates) INTERSECT SELECT unnest(b.dates)
                             WHERE 1=1)) i2
    FROM s a JOIN s b ON a.bkt=b.bkt AND a.bot_id < b.bot_id
  )`;

const h = await db.execute(sql`${base}
  SELECT CASE WHEN na=0 AND nb=0 THEN 'ambos vacios'
              WHEN na=0 OR nb=0 THEN 'uno vacio'
              ELSE 'ambos con fechas' END caso,
         count(*) n, round(100.0*count(*)/sum(count(*)) OVER (),1) pct
  FROM pairs GROUP BY 1 ORDER BY 2 DESC`);
console.log('=== composicion de los pares ===');
console.table(h.rows);

const j = await db.execute(sql`${base}
  SELECT width_bucket(100.0*inter/uni, 0, 100.0001, 10)*10-10 AS jaccard_bucket_pct,
         count(*) n, round(100.0*count(*)/sum(count(*)) OVER (),1) pct
  FROM pairs WHERE na>0 AND nb>0 GROUP BY 1 ORDER BY 1`);
console.log('=== H1 · distribucion Jaccard (ambos con fechas) ===');
console.table(j.rows);

const e = await db.execute(sql`${base}
  SELECT count(*) n,
    round(100.0*count(*) FILTER (WHERE ea = eb)/count(*),1) pct_misma_fecha_mas_temprana,
    round(avg(abs(ea::date - eb::date))::numeric,1) dias_dif_medio,
    round((percentile_cont(0.9) WITHIN GROUP (ORDER BY abs(ea::date - eb::date)))::numeric,0) dias_dif_p90
  FROM pairs WHERE na>0 AND nb>0`);
console.log('=== H1 · coincidencia de la FECHA MAS TEMPRANA (lo que importa) ===');
console.table(e.rows);
process.exit(0);

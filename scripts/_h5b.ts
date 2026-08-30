import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// Robustez 1: contar INSTANTES DE DETECCION distintos (bot, timestamp), no filas.
// Un lote de 50 fechas en un mismo poll cuenta 1, no 50.
const r = await db.execute(sql`
  WITH ap AS (SELECT DISTINCT bot_id, appeared_at ts FROM date_sightings WHERE appeared_at > now()-interval '150 days'),
       de AS (SELECT DISTINCT bot_id, disappeared_at ts FROM date_sightings WHERE disappeared_at IS NOT NULL AND disappeared_at > now()-interval '150 days'),
       ev AS (SELECT ts,'a' k FROM ap UNION ALL SELECT ts,'d' FROM de)
  SELECT (FLOOR(EXTRACT(SECOND FROM ts))::int/5)*5 seg,
    count(*) FILTER (WHERE k='a') n_ap,
    round(100.0*count(*) FILTER (WHERE k='a')/sum(count(*) FILTER (WHERE k='a')) OVER (),2) pct_ap,
    round(100.0*count(*) FILTER (WHERE k='d')/sum(count(*) FILTER (WHERE k='d')) OVER (),2) pct_des
  FROM ev GROUP BY 1 ORDER BY 1`);
console.log('=== H5 robustez · instantes distintos (uniforme 8.33%) ===');
console.table(r.rows);

// Robustez 2: por locale y por periodo
const l = await db.execute(sql`
  WITH ap AS (SELECT DISTINCT ds.bot_id, ds.appeared_at ts, b.locale,
       CASE WHEN ds.appeared_at < now()-interval '60 days' THEN 'antiguo' ELSE 'reciente' END per
     FROM date_sightings ds JOIN bots b ON b.id=ds.bot_id WHERE ds.appeared_at > now()-interval '150 days')
  SELECT locale, per, count(*) n,
    round(100.0*count(*) FILTER (WHERE FLOOR(EXTRACT(SECOND FROM ts)) BETWEEN 15 AND 39)/count(*),1) pct_seg_15_39
  FROM ap GROUP BY 1,2 ORDER BY 1,2`);
console.log('=== H5 robustez · ventana seg 15-39 por locale y periodo (esperado 41.7%) ===');
console.table(l.rows);
process.exit(0);

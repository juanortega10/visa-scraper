import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

// CONTROL INTERNO: las desapariciones se observan con el MISMO muestreo que las
// apariciones. Si ambas comparten la misma fase, la fase es nuestra, no del portal.
const p = await db.execute(sql`
  WITH ev AS (
    SELECT appeared_at ts, 'aparicion' k FROM date_sightings WHERE appeared_at > now()-interval '150 days'
    UNION ALL
    SELECT disappeared_at ts, 'desaparicion' k FROM date_sightings WHERE disappeared_at IS NOT NULL AND disappeared_at > now()-interval '150 days'
  )
  SELECT (EXTRACT(SECOND FROM ts)::int/5)*5 seg_bucket,
     count(*) FILTER (WHERE k='aparicion') apar,
     count(*) FILTER (WHERE k='desaparicion') desap,
     round(100.0*count(*) FILTER (WHERE k='aparicion')/sum(count(*) FILTER (WHERE k='aparicion')) OVER (),2) pct_ap,
     round(100.0*count(*) FILTER (WHERE k='desaparicion')/sum(count(*) FILTER (WHERE k='desaparicion')) OVER (),2) pct_des
  FROM ev GROUP BY 1 ORDER BY 1`);
console.log('=== H5 · segundo-del-minuto: aparicion vs desaparicion (control) ===');
console.log('   uniforme = 8.33% por bucket de 5s');
console.table(p.rows);

const m = await db.execute(sql`
  WITH ev AS (
    SELECT appeared_at ts, 'a' k FROM date_sightings WHERE appeared_at > now()-interval '150 days'
    UNION ALL SELECT disappeared_at, 'd' FROM date_sightings WHERE disappeared_at IS NOT NULL AND disappeared_at > now()-interval '150 days'
  )
  SELECT (EXTRACT(MINUTE FROM ts)::int/5)*5 min_bucket,
     round(100.0*count(*) FILTER (WHERE k='a')/sum(count(*) FILTER (WHERE k='a')) OVER (),2) pct_ap,
     round(100.0*count(*) FILTER (WHERE k='d')/sum(count(*) FILTER (WHERE k='d')) OVER (),2) pct_des
  FROM ev GROUP BY 1 ORDER BY 1`);
console.log('=== H5 · minuto-de-hora (uniforme = 8.33%) ===');
console.table(m.rows);

const h = await db.execute(sql`
  SELECT EXTRACT(HOUR FROM appeared_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::int hora_bog,
    count(*) apar,
    round(100.0*count(*)/sum(count(*)) OVER (),2) pct,
    round((percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms))/1000.0) vida_p50_s
  FROM date_sightings WHERE appeared_at > now()-interval '150 days'
  GROUP BY 1 ORDER BY 1`);
console.log('=== H6 · hora Bogota (uniforme = 4.17%) ===');
console.table(h.rows);
process.exit(0);

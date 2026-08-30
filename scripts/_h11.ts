import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

// H11: tamano del lote por instante de liberacion
const b = await db.execute(sql`
  WITH burst AS (
    SELECT bot_id, appeared_at, count(*) n FROM date_sightings
    WHERE appeared_at > now()-interval '90 days' GROUP BY 1,2)
  SELECT CASE WHEN n=1 THEN '1 fecha' WHEN n<=3 THEN '2-3' WHEN n<=10 THEN '4-10'
              WHEN n<=30 THEN '11-30' ELSE '>30' END lote,
    count(*) instantes, sum(n) fechas,
    round(100.0*count(*)/sum(count(*)) OVER (),1) pct_instantes,
    round(100.0*sum(n)/sum(sum(n)) OVER (),1) pct_fechas,
    round(100.0*count(*) FILTER (WHERE FLOOR(EXTRACT(SECOND FROM appeared_at)) BETWEEN 15 AND 39)/count(*),1) pct_en_ventana
  FROM burst GROUP BY 1 ORDER BY min(n)`);
console.log('=== H11 · tamano del lote y si respeta el reloj ===');
console.table(b.rows);

// H12: dia de la semana
const d = await db.execute(sql`
  SELECT to_char(appeared_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota','ID Dy') dia,
    count(*) n, round(100.0*count(*)/sum(count(*)) OVER (),2) pct
  FROM date_sightings WHERE appeared_at > now()-interval '150 days'
  GROUP BY 1 ORDER BY 1`);
console.log('=== H12 · dia de semana Bogota (uniforme 14.29%) ===');
console.table(d.rows);
process.exit(0);

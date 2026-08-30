import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// Dia de semana sobre 5 meses. La exposicion por dia de semana es plana:
// la flota sondea 24/7 y cada dia aparece ~22 veces en la ventana.
const r = await db.execute(sql`
  SELECT b.locale, to_char(ds.appeared_at AT TIME ZONE 'UTC' AT TIME ZONE
      (CASE b.locale WHEN 'es-pe' THEN 'America/Lima' WHEN 'es-mx' THEN 'America/Mexico_City'
                     ELSE 'America/Bogota' END),'ID Dy') dia,
    count(*) n, round(100.0*count(*)/sum(count(*)) OVER (PARTITION BY b.locale),2) pct
  FROM date_sightings ds JOIN bots b ON b.id=ds.bot_id
  WHERE ds.appeared_at > now()-interval '155 days' AND b.locale IN ('es-co','es-pe')
  GROUP BY 1,2 ORDER BY 1,2`);
console.log('=== dia de semana, 5 meses, hora local (uniforme = 14.29%) ===');
console.table(r.rows);

// Tasa global por categoria: cuanto rinde un poll segun categoria
const c = await db.execute(sql`
  WITH ap AS (SELECT b.visa_category vc, count(*) n FROM date_sightings ds JOIN bots b ON b.id=ds.bot_id
    WHERE b.locale='es-co' AND ds.appeared_at > now()-interval '10 days' GROUP BY 1),
  ex AS (SELECT b.visa_category vc, sum(COALESCE(p.polls_since_prev,1)) polls, count(DISTINCT b.id) bots
    FROM poll_logs p JOIN bots b ON b.id=p.bot_id
    WHERE b.locale='es-co' AND p.created_at > now()-interval '10 days' GROUP BY 1)
  SELECT COALESCE(ex.vc,'(sin clasificar)') categoria, ex.bots, ex.polls,
    COALESCE(ap.n,0) apariciones,
    round((1000.0*COALESCE(ap.n,0)/ex.polls)::numeric,1) por_1000_polls
  FROM ex LEFT JOIN ap ON ap.vc IS NOT DISTINCT FROM ex.vc ORDER BY 5 DESC`);
console.log('=== rendimiento del poll por categoria (es-co, 10 dias) ===');
console.table(c.rows);
process.exit(0);

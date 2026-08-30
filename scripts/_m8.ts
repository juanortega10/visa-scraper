import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`
  SELECT date_trunc('day', created_at)::date dia,
    sum(COALESCE(polls_since_prev,1)) polls,
    round((sum(COALESCE(polls_since_prev,1))/NULLIF(EXTRACT(EPOCH FROM max(created_at)-min(created_at))/60,0))::numeric,2) polls_por_min,
    count(*) FILTER (WHERE status='soft_ban') soft_ban,
    count(*) FILTER (WHERE status='tcp_blocked') tcp,
    count(*) FILTER (WHERE status='ok') ok,
    round(avg(raw_dates_count) FILTER (WHERE status IN ('ok','filtered_out'))::numeric,1) fechas_medias
  FROM poll_logs WHERE bot_id IN (7,223) AND created_at > now()-interval '20 days'
  GROUP BY 1 ORDER BY 1`);
console.log('=== bots es-pe (7 y 223): velocidad contra bloqueos, dia a dia ===');
console.table(r.rows);
process.exit(0);

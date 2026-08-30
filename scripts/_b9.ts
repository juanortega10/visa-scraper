import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// 1. Que trae realmente una respuesta marcada soft_ban?
const a = await db.execute(sql`
  SELECT COALESCE(raw_dates_count,-1) fechas_crudas, count(*) n,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY response_time_ms)::numeric,0) ms_p50
  FROM poll_logs WHERE status='soft_ban' AND created_at > now()-interval '90 days'
  GROUP BY 1 ORDER BY 1`);
console.log('=== contenido de las respuestas marcadas soft_ban ===');
console.table(a.rows);

// 2. Aparecen fechas nuevas en polls marcados soft_ban?
const b = await db.execute(sql`
  SELECT status, count(*) filas,
    count(*) FILTER (WHERE jsonb_array_length(date_changes->'appeared')>0) con_apariciones,
    count(*) FILTER (WHERE jsonb_array_length(date_changes->'disappeared')>0) con_desapariciones
  FROM poll_logs WHERE created_at > now()-interval '90 days' AND date_changes IS NOT NULL
  GROUP BY 1 ORDER BY 2 DESC`);
console.log('=== cambios de fecha registrados por estado ===');
console.table(b.rows);

// 3. Tiempo de respuesta: un bloqueo real deberia responder distinto
const c = await db.execute(sql`
  SELECT status, count(*) n,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY response_time_ms)::numeric,0) ms_p50,
    round(percentile_cont(0.1) WITHIN GROUP (ORDER BY response_time_ms)::numeric,0) ms_p10
  FROM poll_logs WHERE created_at > now()-interval '90 days' AND response_time_ms IS NOT NULL
    AND status IN ('ok','filtered_out','soft_ban') GROUP BY 1 ORDER BY 1`);
console.log('=== tiempo de respuesta por estado ===');
console.table(c.rows);
process.exit(0);

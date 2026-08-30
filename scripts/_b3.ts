import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
// La duracion medida esta censurada: solo detectamos el fin del bloqueo cuando volvemos a pollear.
// Si el PRIMER sondeo tras el backoff casi siempre sale bien, esperamos de mas.
const r = await db.execute(sql`
  SELECT classification, recovery_context->>'recoveryStatus' recuperacion, count(*) n,
    round(100.0*count(*)/sum(count(*)) OVER (PARTITION BY classification),1) pct,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_min)::numeric,0) dur_p50_min
  FROM ban_episodes WHERE ended_at IS NOT NULL
  GROUP BY 1,2 ORDER BY 1, 3 DESC`);
console.log('=== estado del primer sondeo tras el bloqueo ===');
console.table(r.rows);

// Contexto de disparo: tasa instantanea al momento del ban
const t = await db.execute(sql`
  SELECT classification, count(*) n,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (trigger_context->>'pollRateRecentPerMin')::float)::numeric,2) tasa_p50,
    round(percentile_cont(0.9) WITHIN GROUP (ORDER BY (trigger_context->>'pollRateRecentPerMin')::float)::numeric,2) tasa_p90,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (trigger_context->>'sessionAgeMs')::float/60000)::numeric,0) edad_sesion_p50_min,
    mode() WITHIN GROUP (ORDER BY trigger_context->>'provider') proveedor
  FROM ban_episodes WHERE trigger_context IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`);
console.log('=== contexto al disparar el bloqueo ===');
console.table(t.rows);
process.exit(0);

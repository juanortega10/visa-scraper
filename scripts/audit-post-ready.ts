/**
 * Detecta bots que NO pueden postear un reagendamiento, aunque parezcan sanos.
 *
 * Nace del caso del bot 299 (2026-08-27): polleaba, veia fechas, y jamas habria
 * podido tomarlas. Su fila en `sessions` no tenia `authenticity_token`, porque la
 * pagina `/schedule/{id}/appointment` esta bloqueada para ese schedule. Sin ese
 * token el POST devuelve 302 a `sign_in`.
 *
 * CUIDADO con el falso positivo: tras un `performLogin()` que no trae tokens, el
 * codigo los deja en null A PROPOSITO para forzar `refreshTokens()` en el proximo
 * ciclo (ver CLAUDE.md, seccion de tokens). Entonces `auth = false` recien creada la
 * sesion es NORMAL. Por eso se exige una edad minima de sesion.
 *
 * Severidad:
 *   critico   sin token, sesion vieja, y CERO exitos historicos → nunca pudo postear
 *   revisar   sin token y sesion vieja, con exitos historicos  → regresion, mirar
 *
 * Solo lectura. Sale con codigo 1 si hay algo critico.
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/audit-post-ready.ts
 *   npx tsx --env-file=.env scripts/audit-post-ready.ts --min-edad 30
 *   npx tsx --env-file=.env scripts/audit-post-ready.ts --todos
 */
import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';

const ALL = process.argv.includes('--todos');
const argOf = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
/** Minutos que debe tener la sesion para que la falta de token cuente como real. */
const MIN_EDAD_MIN = Number(argOf('--min-edad') ?? 45);
const estado = ALL ? sql`` : sql`AND b.status = 'active'`;

const rows = (await db.execute(sql`
  SELECT b.id, b.status, b.locale, b.visa_email, b.schedule_id,
         b.current_consular_date, b.reschedule_count, b.max_reschedules,
         (s.bot_id IS NOT NULL) AS tiene_sesion,
         (s.authenticity_token IS NOT NULL AND s.authenticity_token <> '') AS tiene_auth,
         (s.csrf_token IS NOT NULL AND s.csrf_token <> '') AS tiene_csrf,
         to_char(s.created_at,'MM-DD HH24:MI') AS sesion_creada,
         round(extract(epoch FROM (now() AT TIME ZONE 'UTC') - s.created_at)/60) AS sesion_min,
         (SELECT count(*) FROM reschedule_logs x WHERE x.bot_id = b.id AND x.success) AS exitos_hist,
         (SELECT count(*) FROM poll_logs p
            WHERE p.bot_id = b.id AND p.created_at > now() - interval '48 hours'
              AND p.connection_info->>'blockClassification' IN ('account_ban','schedule_blocked')
         ) AS bloqueos_48h
  FROM bots b
  LEFT JOIN sessions s ON s.bot_id = b.id
  WHERE 1=1 ${estado}
  ORDER BY b.id
`)).rows as any[];

interface Hallazgo { id: number; severidad: 'critico' | 'revisar'; detalle: string; email: string }
const hallazgos: Hallazgo[] = [];

for (const b of rows) {
  const email = (() => { try { return decrypt(b.visa_email as string); } catch { return '(cifrado)'; } })();
  const cuotaAgotada = b.max_reschedules != null && Number(b.reschedule_count) >= Number(b.max_reschedules);
  if (cuotaAgotada) continue;   // no puede moverse igual, no es esta falla
  if (b.tiene_sesion && b.tiene_auth) continue;

  const edad = Number(b.sesion_min ?? 0);
  // Sesion joven sin token = estado normal tras un login. No es hallazgo.
  if (b.tiene_sesion && edad < MIN_EDAD_MIN) continue;

  const exitos = Number(b.exitos_hist ?? 0);
  const bloqueos = Number(b.bloqueos_48h ?? 0);
  const base = b.tiene_sesion
    ? `sesion de ${edad} min sin authenticity_token`
    : 'no hay fila en sessions';
  const extra = `${bloqueos > 0 ? ` · ${bloqueos} bloqueos 48h` : ''} · ${exitos} exitos historicos`;

  hallazgos.push({
    id: b.id,
    severidad: exitos === 0 ? 'critico' : 'revisar',
    detalle: base + extra,
    email,
  });
}

console.log(`AUDITORIA · pueden postear? · ${rows.length} bots revisados (${ALL ? 'todos' : 'solo activos'})`);
console.log(`edad minima de sesion para contar: ${MIN_EDAD_MIN} min\n`);

if (hallazgos.length === 0) {
  console.log('  Ningun bot esta ciego para el POST.');
  process.exit(0);
}

const pad = (v: unknown, n: number) => String(v ?? '').padEnd(n);
console.log(`${pad('bot', 6)}${pad('severidad', 11)}${pad('locale', 8)}${pad('detalle', 56)}correo`);
for (const h of hallazgos.sort((a, b) => a.severidad.localeCompare(b.severidad))) {
  const b = rows.find((r) => r.id === h.id)!;
  console.log(`${pad(h.id, 6)}${pad(h.severidad, 11)}${pad(b.locale, 8)}${pad(h.detalle, 56)}${h.email}`);
}

const criticos = hallazgos.filter((h) => h.severidad === 'critico');
console.log(`\n${criticos.length} critico(s), ${hallazgos.length - criticos.length} para revisar.`);
console.log('Un bot sin authenticity_token pollea, ve fechas y falla el POST con 302 hacia sign_in.');
console.log('\nSiguiente paso: ver que URL esta cerrada.');
console.log(`  npx tsx --env-file=.env scripts/probe-schedule-block.ts --bots ${hallazgos.map((h) => h.id).join(',')}`);
process.exit(criticos.length > 0 ? 1 : 0);

/**
 * Pagina /dashboard/peru — responde una sola pregunta: ¿por que perdemos la carrera?
 *
 * Peru es distinto de Colombia. Las fechas casi no aparecen, y cuando aparecen
 * duran segundos. La cuota de reagendamientos es de 1 o 2 y el bloqueo del portal
 * es irreversible. Entonces esta pagina no mide "cuanto polleamos". Mide **cuanto
 * tardamos desde que vemos el cupo hasta que lo pedimos**, que es lo que decide
 * si le ganamos a los otros bots.
 *
 * Lee `poll_logs`, `reschedule_logs` y `bots`. Nunca toca el portal: abrir esta
 * pagina no suma polls ni riesgo de bloqueo.
 *
 * Orden por valor: estado y cuota → el reloj → cada oportunidad perdida → cuando
 * aparecen → salud.
 *
 * Usa los tokens del dashboard (JetBrains Mono, fondo #0C0C0E, acento #A78BFA).
 */

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { decrypt } from '../services/encryption.js';

export const peruPageRouter = new Hono();

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Etiquetas humanas para los motivos de falla del portal. */
const REASONS: Record<string, { label: string; hint: string }> = {
  no_times: { label: 'llegamos tarde', hint: 'days.json mostro el dia y times.json ya no dio horas. Otro bot lo tomo primero.' },
  post_error: { label: 'el POST fallo', hint: 'la peticion de reserva no llego. Red o proxy.' },
  verification_failed: { label: 'el portal no lo guardo', hint: 'el POST parecio pasar y la cita no cambio. Cupo tomado en el ultimo instante.' },
  post_failed: { label: 'el portal rechazo', hint: 'el POST devolvio una pagina de error.' },
  no_cas_days: { label: 'muro CAS', hint: 'no habia biometria disponible antes de la cita.' },
  session_expired: { label: 'sesion vencida', hint: 'hubo que volver a entrar en mitad del intento.' },
};

interface Attempt { date?: string; failReason?: string; failStep?: string; durationMs?: number; timesFound?: string[] }
interface Phases { load?: number; fetch?: number; reschedule?: number }

const fmtMs = (ms: number | null | undefined) =>
  ms == null ? '-' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

peruPageRouter.get('/', async (c) => {
  const botId = parseInt(c.req.query('bot') ?? '299', 10) || 299;
  const days = Math.min(Math.max(parseInt(c.req.query('dias') ?? '30', 10) || 30, 1), 180);
  const since = sql.raw(`now() - interval '${days} days'`);

  // ── Bot ──────────────────────────────────────────────────────────────
  const botRows = await db.execute(sql`
    SELECT id, status, visa_email, schedule_id, locale,
           current_consular_date, current_consular_time, target_date_before,
           reschedule_count, max_reschedules,
           portal_max_reschedules, portal_remaining_reschedules,
           to_char(portal_limit_checked_at,'MM-DD HH24:MI') AS portal_visto,
           proxy_provider,
           to_char(updated_at,'YYYY-MM-DD HH24:MI:SS') AS updated,
           round(extract(epoch FROM (now() AT TIME ZONE 'UTC') - updated_at)/60) AS idle_min
    FROM bots WHERE id = ${botId}`);
  const bot = (botRows.rows as any[])[0];
  if (!bot) return c.html(shell(botId, days, `<section class="hero">
    <p class="eyebrow">sin datos</p><h1>No existe el bot ${botId}.</h1></section>`), 404);

  const email = (() => { try { return decrypt(bot.visa_email as string); } catch { return '(cifrado)'; } })();
  // Dos topes distintos. Manda el mas estricto.
  const ourLeft = bot.max_reschedules == null ? null : Number(bot.max_reschedules) - Number(bot.reschedule_count);
  const portalLeft = bot.portal_remaining_reschedules == null ? null : Number(bot.portal_remaining_reschedules);
  const quotaLeft = ourLeft == null ? portalLeft : portalLeft == null ? ourLeft : Math.min(ourLeft, portalLeft);
  const capBy = ourLeft == null && portalLeft == null ? 'sin tope'
    : portalLeft != null && (ourLeft == null || portalLeft <= ourLeft) ? 'portal' : 'tu presupuesto';

  // ── Embudo ───────────────────────────────────────────────────────────
  const funnel = (await db.execute(sql`
    SELECT coalesce(sum(coalesce(polls_since_prev,1)),0) AS polls,
           count(*) FILTER (WHERE earliest_date IS NOT NULL) AS detecciones
    FROM poll_logs WHERE bot_id = ${botId} AND created_at > ${since}`)).rows[0] as any;
  const tries = (await db.execute(sql`
    SELECT count(*) AS intentos, count(*) FILTER (WHERE success) AS exitos
    FROM reschedule_logs WHERE bot_id = ${botId} AND created_at > ${since}`)).rows[0] as any;

  // ── Oportunidades: cada deteccion con su desglose de tiempo ──────────
  const opps = (await db.execute(sql`
    SELECT to_char(created_at,'YYYY-MM-DD HH24:MI:SS') AS t_utc,
           to_char(created_at - interval '5 hours','MM-DD HH24:MI') AS t_local,
           earliest_date, raw_dates_count, top_dates, response_time_ms,
           phase_timings, reschedule_details, reschedule_result
    FROM poll_logs
    WHERE bot_id = ${botId} AND earliest_date IS NOT NULL AND created_at > ${since}
    ORDER BY created_at DESC LIMIT 40`)).rows as any[];

  const clocks = opps.map((o) => {
    const ph = (o.phase_timings ?? {}) as Phases;
    const at = (((o.reschedule_details ?? {}).attempts ?? [])[0] ?? {}) as Attempt;
    const load = ph.load ?? 0;
    const fetch = ph.fetch ?? 0;
    const resch = ph.reschedule ?? 0;
    const attempt = at.durationMs ?? 0;
    const prep = Math.max(0, resch - attempt);
    return {
      ...o, load, fetch, prep, attempt,
      // Lo que decide la carrera: desde que arranca el poll hasta que pedimos horarios.
      toAsk: load + fetch + prep,
      reason: at.failReason ?? o.reschedule_result ?? null,
      failStep: at.failStep ?? null,
      beats: o.earliest_date < bot.current_consular_date,
      meetsTarget: bot.target_date_before ? o.earliest_date < bot.target_date_before : null,
    };
  });

  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };
  const medToAsk = median(clocks.map((k) => k.toAsk).filter((n) => n > 0));

  // Latencia normal, para contraste.
  const normal = (await db.execute(sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY response_time_ms)::int AS p50
    FROM poll_logs WHERE bot_id = ${botId} AND earliest_date IS NULL
      AND response_time_ms IS NOT NULL AND created_at > ${since}`)).rows[0] as any;

  // ── Hora del dia ─────────────────────────────────────────────────────
  const hours = (await db.execute(sql`
    SELECT extract(hour FROM created_at - interval '5 hours')::int AS h, count(*) AS n
    FROM poll_logs WHERE bot_id = ${botId} AND earliest_date IS NOT NULL AND created_at > ${since}
    GROUP BY h ORDER BY h`)).rows as any[];

  // ── Salud ────────────────────────────────────────────────────────────
  const health = (await db.execute(sql`
    SELECT status, count(*) AS n, to_char(max(created_at),'MM-DD HH24:MI') AS ultimo
    FROM poll_logs WHERE bot_id = ${botId} AND created_at > now() - interval '24 hours'
    GROUP BY status ORDER BY n DESC`)).rows as any[];

  // ── Render ───────────────────────────────────────────────────────────
  const won = Number(tries.exitos) > 0;
  const idle = Number(bot.idle_min);
  const tone = won ? 'tone-good' : idle > 15 ? 'tone-stop' : 'tone-warn';
  const headline = won
    ? 'Ya agendamos.'
    : Number(funnel.detecciones) === 0
      ? `Ninguna fecha en ${days} dias.`
      : `${funnel.detecciones} oportunidades vistas. ${tries.exitos} tomadas.`;

  const sinToken = !(await db.execute(sql`
    SELECT 1 FROM sessions WHERE bot_id = ${botId}
      AND authenticity_token IS NOT NULL AND authenticity_token <> ''`)).rows.length;

  const heroNote = sinToken
    ? `<div class="blocker">La sesion guardada NO tiene <b>authenticity_token</b>. El bot puede ver
       fechas y no puede tomarlas: el POST devuelve 302 hacia sign_in.
       <span class="blocker-long">Arreglo: <code>npx tsx --env-file=.env scripts/login.ts --bot-id=${botId}</code></span></div>`
    : idle > 15
    ? `<div class="blocker">La cadena lleva <b>${idle} min</b> sin correr. El bot no esta vigilando.
       <span class="blocker-long">Revisalo con <code>npx tsx --env-file=.env scripts/set-bot-active.ts ${botId}</code></span></div>`
    : quotaLeft === 0
      ? `<div class="blocker">Sin movimientos disponibles (tope: ${capBy}). Este bot ya no puede reagendar.</div>`
      : quotaLeft === 1
        ? `<div class="blocker">Queda <b>1 solo</b> movimiento (tope: ${capBy}). En Peru el bloqueo del portal es irreversible.</div>`
        : '';

  const clockRows = clocks.map((k) => {
    const total = Math.max(1, k.load + k.fetch + k.prep + k.attempt);
    const seg = (v: number, cls: string, label: string) =>
      v > 0 ? `<span class="seg ${cls}" style="width:${((v / total) * 100).toFixed(1)}%" title="${label}: ${fmtMs(v)}"></span>` : '';
    const r = REASONS[k.reason ?? ''] ?? { label: k.reason ?? 'sin motivo', hint: '' };
    return `<div class="opp">
      <div class="opp-h">
        <b>${esc(k.earliest_date)}</b>
        ${k.beats ? '<span class="pill pill-win">adelanta</span>' : '<span class="pill pill-fade">no sirve</span>'}
        ${k.meetsTarget ? '<span class="pill pill-ok">cumple meta</span>' : ''}
        <span class="pill pill-stop">${esc(r.label)}</span>
        <span class="grow"></span>
        <span class="muted">${esc(k.t_local)} Lima</span>
      </div>
      <div class="clock">${seg(k.load, 's-load', 'cargar')}${seg(k.fetch, 's-fetch', 'ver el cupo')}${seg(k.prep, 's-prep', 'preparar tokens')}${seg(k.attempt, 's-ask', 'pedir horarios')}</div>
      <div class="legend">
        <span><i class="k s-load"></i>cargar ${fmtMs(k.load)}</span>
        <span><i class="k s-fetch"></i>ver ${fmtMs(k.fetch)}</span>
        <span><i class="k s-prep"></i>preparar ${fmtMs(k.prep)}</span>
        <span><i class="k s-ask"></i>pedir ${fmtMs(k.attempt)}</span>
        <span class="grow"></span>
        <b class="tone-stop">${fmtMs(k.toAsk)} hasta pedir</b>
      </div>
      ${r.hint ? `<div class="hint">${esc(r.hint)}</div>` : ''}
    </div>`;
  }).join('');

  const maxH = Math.max(1, ...hours.map((h) => Number(h.n)));
  const hourBars = hours.length
    ? hours.map((h) => `<div class="bar">
        <span class="bl">${String(h.h).padStart(2, '0')}:00 Lima</span>
        <span class="bt"><i class="bf" style="width:${((Number(h.n) / maxH) * 100).toFixed(0)}%"></i></span>
        <span class="bn">${h.n}</span></div>`).join('')
    : '<p class="sub">Sin detecciones en el periodo.</p>';

  const body = `
<section class="hero">
  <p class="eyebrow">bot ${botId} · ${esc(bot.locale)} · ${esc(email)}</p>
  <h1 class="${tone}">${esc(headline)}</h1>
  <p class="lede">Cita actual <b>${esc(bot.current_consular_date)} ${esc(bot.current_consular_time ?? '')}</b>.
     Meta: cualquier fecha antes de <b>${esc(bot.target_date_before ?? '(sin meta)')}</b>.</p>
  ${heroNote}
</section>

<div class="stats">
  <div class="stat"><span class="n">${Number(funnel.polls).toLocaleString('es')}</span><span class="l">polls</span></div>
  <div class="stat"><span class="n">${funnel.detecciones}</span><span class="l">fechas vistas</span></div>
  <div class="stat"><span class="n">${tries.intentos}</span><span class="l">intentos</span></div>
  <div class="stat"><span class="n ${won ? 'tone-good' : 'tone-stop'}">${tries.exitos}</span><span class="l">tomadas</span></div>
  <div class="stat"><span class="n ${quotaLeft === 0 ? 'tone-stop' : quotaLeft === 1 ? 'tone-warn' : ''}">${quotaLeft ?? '∞'}</span><span class="l">movimientos que quedan</span></div>
</div>

<section class="block">
  <h2>Cuota · dos topes distintos</h2>
  <p class="sub">El <b>portal</b> impone un tope duro: al agotarlo la cita se bloquea y no hay
     vuelta atras. Tu <b>presupuesto</b> puede ser menor a proposito. Manda el mas estricto.</p>
  <div class="scroll"><table>
    <tr><th>fuente</th><th>usados</th><th>tope</th><th>quedan</th><th>leido</th></tr>
    <tr>
      <td>portal</td>
      <td>${bot.portal_max_reschedules != null && portalLeft != null ? Number(bot.portal_max_reschedules) - portalLeft : '-'}</td>
      <td>${bot.portal_max_reschedules ?? '-'}</td>
      <td class="${portalLeft === 0 ? 'tone-stop' : ''}">${portalLeft ?? 'sin leer'}</td>
      <td class="muted">${esc(bot.portal_visto ?? '-')}</td>
    </tr>
    <tr>
      <td>tu presupuesto</td>
      <td>${bot.reschedule_count}</td>
      <td>${bot.max_reschedules ?? '∞'}</td>
      <td class="${ourLeft === 0 ? 'tone-stop' : ''}">${ourLeft ?? '∞'}</td>
      <td class="muted">-</td>
    </tr>
  </table></div>
  <p class="foot muted">manda: <b>${esc(capBy)}</b> · para releer el portal:
     <code>npx tsx --env-file=.env scripts/sync-portal-limits.ts --bots ${botId} --commit</code></p>
</section>

<section class="block">
  <h2>El reloj · por que perdemos</h2>
  <p class="sub">Un cupo de Peru dura segundos. Lo que decide la carrera es el tiempo entre
     <b>ver</b> la fecha y <b>pedir</b> los horarios. Todo lo que este a la izquierda de
     "pedir" es tiempo regalado a los otros bots.</p>
  ${medToAsk != null ? `<div class="near">
     <div class="near-date">${fmtMs(medToAsk)}</div>
     <div class="near-when">mediana hasta pedir horarios, contra ${fmtMs(normal?.p50)} que tarda un poll normal completo</div>
   </div>` : ''}
</section>

<section class="block">
  <h2>Cada oportunidad</h2>
  ${clocks.length ? clockRows : '<p class="sub">Ninguna fecha aparecio en el periodo.</p>'}
</section>

<section class="block">
  <h2>Cuando aparecen · hora de Lima</h2>
  <div class="bars">${hourBars}</div>
</section>

<section class="block">
  <h2>Salud · ultimas 24h</h2>
  <div class="scroll"><table>
    <tr><th>estado</th><th>filas</th><th>ultimo</th></tr>
    ${health.map((h) => `<tr><td>${esc(h.status)}</td><td>${h.n}</td><td class="muted">${esc(h.ultimo)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">sin polls</td></tr>'}
  </table></div>
  <p class="foot muted">cadena actualizada hace ${idle} min · proxy ${esc(bot.proxy_provider)} · schedule ${esc(bot.schedule_id)}</p>
</section>`;

  return c.html(shell(botId, days, body));
});

function shell(botId: number, days: number, body: string) {
  const link = (d: number) => `?bot=${botId}&dias=${d}`;
  return `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Peru · bot ${botId}</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0C0C0E; --surface:#161618; --line:rgba(255,255,255,.07);
  --text:#9E9EA9; --bright:#E8E8EE; --muted:#5C5C67;
  --accent:#A78BFA; --accent-soft:rgba(167,139,250,.12);
  --good:#4ADE80; --warn:#FCD34D; --stop:#F87171;
}
html{-webkit-text-size-adjust:100%}
body{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  background:var(--bg); color:var(--text); font-size:12px; line-height:1.6;
  max-width:680px; margin:0 auto; padding:20px 16px 64px;
  font-variant-numeric:tabular-nums; -webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
code{background:rgba(255,255,255,.05);padding:2px 6px;border-radius:4px;color:var(--bright);font-size:11px}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;padding-bottom:28px}
.brand{font-size:12px;font-weight:800;color:var(--bright);letter-spacing:1.5px;text-transform:uppercase}
.brand em{font-style:normal;color:var(--accent)}
.nav{display:flex;gap:4px;align-items:baseline}
.nav a{padding:4px 9px;border:1px solid var(--line);border-radius:6px;font-size:10px;color:var(--muted)}
.nav a.on{border-color:var(--accent);color:var(--bright);background:var(--accent-soft)}
.hero{padding-bottom:28px;border-bottom:1px solid var(--line);margin-bottom:24px}
.eyebrow{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
h1{font-size:34px;line-height:1.1;font-weight:800;letter-spacing:-1px;color:var(--bright);text-wrap:balance;margin-bottom:10px}
.lede{font-size:13px;color:var(--text);max-width:56ch}
.lede b,.blocker b{color:var(--bright)}
.blocker{margin-top:16px;padding:12px 14px;background:var(--surface);border:1px solid var(--line);
  border-left:2px solid var(--stop);border-radius:6px;font-size:11px;color:var(--text)}
.blocker-long{color:var(--muted);display:inline-block;margin-top:6px;max-width:60ch}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-bottom:32px}
.stat{background:var(--bg);padding:12px 14px;display:flex;flex-direction:column;gap:3px}
.stat .n{font-size:19px;font-weight:700;color:var(--bright);line-height:1.1}
.stat .l{font-size:10px;color:var(--muted);letter-spacing:.5px}
.tone-good{color:var(--good)} .tone-warn{color:var(--warn)} .tone-stop{color:var(--stop)}
.block{margin-bottom:32px}
h2{font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);
  padding-bottom:8px;margin-bottom:12px;border-bottom:1px solid var(--line)}
.sub{font-size:11px;color:var(--muted);margin-bottom:12px;max-width:60ch}
.sub b{color:var(--bright)}
.foot{font-size:11px;margin-top:10px}
.muted{color:var(--muted)}
.grow{flex:1}
.near{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:16px}
.near-date{font-size:28px;font-weight:800;color:var(--stop);letter-spacing:-.5px}
.near-when{margin-top:6px;font-size:10px;color:var(--muted)}
.opp{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:8px}
.opp-h{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px;margin-bottom:9px}
.opp-h b{font-size:15px;color:var(--bright)}
.clock{display:flex;height:9px;border-radius:5px;overflow:hidden;background:rgba(255,255,255,.05)}
.seg{display:block;height:100%}
.s-load{background:#3F3F52} .s-fetch{background:var(--accent)}
.s-prep{background:var(--stop)} .s-ask{background:var(--warn)}
.legend{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:8px;font-size:10px;color:var(--muted)}
.legend i.k{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:4px;vertical-align:middle}
.hint{margin-top:7px;font-size:10px;color:var(--muted);max-width:60ch}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:10px;color:var(--muted);white-space:nowrap}
.pill-ok{border-color:rgba(74,222,128,.35);color:var(--good)}
.pill-stop{border-color:rgba(248,113,113,.35);color:var(--stop)}
.pill-win{border-color:rgba(167,139,250,.35);color:var(--accent)}
.pill-fade{opacity:.55}
.bars{display:flex;flex-direction:column;gap:7px}
.bar{display:grid;grid-template-columns:96px 1fr 34px;gap:10px;align-items:center;font-size:11px}
.bl{color:var(--bright)}
.bt{height:6px;background:rgba(255,255,255,.05);border-radius:3px;overflow:hidden}
.bf{display:block;height:100%;background:var(--accent);opacity:.75}
.bn{text-align:right;color:var(--muted)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:11px}
th{text-align:left;font-weight:400;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;padding:0 10px 6px}
td{padding:9px 10px;border-top:1px solid var(--line)}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<div class="top">
  <div class="brand">peru <em>bot ${botId}</em></div>
  <nav class="nav">
    ${[7, 30, 90].map((d) => `<a href="${link(d)}" class="${d === days ? 'on' : ''}">${d}d</a>`).join('')}
    ${[299, 7, 223].map((b) => `<a href="?bot=${b}&dias=${days}" class="${b === botId ? 'on' : ''}">${b}</a>`).join('')}
    <a href="/dashboard">bots</a>
  </nav>
</div>
${body}
</body></html>`;
}

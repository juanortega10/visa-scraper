/**
 * Pagina /dashboard/sniper — responde una sola pregunta: ¿ya agendamos, y si no, por que?
 *
 * Lee `sniper_scans`, nunca el portal. El sniper es el unico que consulta a la embajada;
 * mirar esta pagina no suma polls ni riesgo de bloqueo.
 *
 * Orden por valor: estado → bloqueador → lo mas cerca que estuvimos → el mes que importa.
 * El detalle poll por poll vive en `?raw=1`, fuera del camino.
 *
 * Usa los tokens del dashboard (JetBrains Mono, fondo #0C0C0E, acento #A78BFA). El color
 * semantico (verde/ambar/rojo) es aparte del acento y solo marca estado.
 */

import { Hono } from 'hono';
import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sniperScans } from '../db/schema.js';

export const sniperPageRouter = new Hono();

const DEFAULT_HOURS = 72;
const MAX_ROWS = 600;

interface Observation {
  date: string;
  parentsTimes: string[] | null;
  childrenTimes: string[];
  pairs: Array<{ p: string; c: string; gapMin: number }>;
  source: 'window' | 'sample';
}

interface CasProbe {
  role: 'PARENTS' | 'CHILDREN';
  consularDate: string;
  consularTime: string;
  casDaysOffered: number;
  picked: { date: string; time: string; inWindow: boolean } | null;
}

interface GroupSnap {
  botId: number; scheduleId: string; applicants: number;
  consularDate: string | null; consularTime: string | null;
  casDate: string | null; casTime: string | null;
}

interface Payload {
  reason?: string;
  totalDays?: number;
  allDays?: string[];
  observeStart?: string;
  observeEnd?: string;
  windowDays?: string[];
  observations?: Observation[];
  best?: { date: string; parentsTime: string; childrenTime: string; gapMin: number } | null;
  blockers?: string[];
  fired?: boolean;
  casProbes?: CasProbe[];
  gapMaxMin?: number;
  gapIdealMin?: number;
  commit?: boolean;
  groups?: { parents: GroupSnap; children: GroupSnap };
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** La base guarda UTC sin zona. Bogota = UTC-5. */
function bogota(d: Date): string {
  return new Date(d.getTime() - 5 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
}
function hhmm(d: Date): string {
  return bogota(d).slice(11);
}
function since(d: Date): string {
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) return 'hace segundos';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `hace ${h}h ${min % 60}min` : `hace ${Math.floor(h / 24)}d`;
}

/** Traduce el codigo del verificador a una frase que se entiende sin leer el codigo. */
function explainBlocker(code: string): { short: string; long: string } {
  if (code.startsWith('V8')) return {
    short: 'muro CAS',
    long: 'El portal ofrece la cita consular pero cero dias de CAS para esa hora. Las dos citas se agendan en el mismo envio, entonces sin CAS no hay movimiento.',
  };
  if (code.startsWith('V1')) return { short: 'fuera de la ventana', long: 'La fecha del par no cae en la ventana permitida.' };
  if (code.startsWith('V3')) return { short: 'orden invertido', long: 'La hora de los padres quedaria despues que la de los ninos.' };
  if (code.startsWith('V4')) return { short: 'gap muy grande', long: 'La separacion entre las dos citas pasa el techo permitido.' };
  if (code.startsWith('V5')) return { short: 'seria mas tarde', long: 'El par propuesto es igual o posterior a la cita actual. La regla critica lo prohibe.' };
  if (code.startsWith('V6')) return { short: 'fecha pasada', long: 'La fecha ya paso.' };
  if (code.startsWith('V7')) return { short: 'sin reagendamientos', long: 'El grupo agoto los cambios que permite el portal.' };
  if (code.startsWith('V9')) return { short: 'CAS mal ubicada', long: 'La CAS quedaria despues del consular, o en el pasado.' };
  if (code.startsWith('gap0_sin_respaldo')) return {
    short: 'gap 0 sin respaldo',
    long: 'Ese dia manda a los 2 grupos a la misma hora y no ofrece ningun horario alterno. Si el segundo envio falla, la familia queda partida. El sniper prefiere esperar.',
  };
  if (code.startsWith('cas_cooldown')) return {
    short: 'CAS en pausa',
    long: 'Esa fecha fallo por falta de CAS varias veces seguidas. El sniper deja de consultarla unos minutos y despues reintenta, para no gastar consultas ni arriesgar un bloqueo.',
  };
  if (code.startsWith('LIVE')) return { short: 'cupo tomado', long: 'El cupo desaparecio entre que se leyo y se iba a enviar. Alguien lo tomo primero.' };
  if (code === 'sin_par_valido') return {
    short: 'sin par',
    long: 'Hay dias en la ventana, pero ninguna combinacion de horas sirve: hace falta que los padres queden antes o a la misma hora que los ninos, dentro del techo de gap.',
  };
  if (code === 'sin_dias_en_ventana') return { short: 'ventana vacia', long: 'El portal no ofrece ningun dia dentro de la ventana.' };
  if (code === 'dry_run') return { short: 'modo prueba', long: 'El par era valido. El sniper corria sin --commit, entonces no envio nada.' };
  return { short: code.slice(0, 24), long: code };
}

sniperPageRouter.get('/', async (c) => {
  const scanKey = c.req.query('key') ?? 'victoria-alvarez';
  const raw = c.req.query('raw') === '1';
  const hours = Math.min(Math.max(parseInt(c.req.query('hours') ?? String(DEFAULT_HOURS), 10) || DEFAULT_HOURS, 1), 24 * 30);
  const rows = await db.select().from(sniperScans)
    .where(and(eq(sniperScans.scanKey, scanKey), gte(sniperScans.scannedAt, new Date(Date.now() - hours * 3600_000))))
    .orderBy(desc(sniperScans.scannedAt))
    .limit(MAX_ROWS);

  if (rows.length === 0) {
    return c.html(shell(scanKey, hours, raw, `<section class="hero">
      <p class="eyebrow">sin datos</p>
      <h1>El sniper no ha guardado nada en ${hours}h.</h1>
      <p class="lede">Arrancalo con <code>npx tsx --env-file=.env scripts/dual-sniper-victoria.ts --loop --commit</code></p>
    </section>`));
  }

  const latest = rows[0]!;
  const p0 = latest.payload as Payload;
  const winStart = latest.windowStart;
  const winEnd = latest.windowEnd;
  const inWin = (d: string) => d >= winStart && d <= winEnd;
  const g = p0.groups;
  const done = latest.phase === 'DONE';

  // ── Que vimos, agregado sobre todos los escaneos ──
  const timesSeen = new Map<string, { parents: Set<string>; children: Set<string>; bestGap: number | null; lastSeen: Date }>();
  const daysSeen = new Map<string, { n: number; first: Date; last: Date }>();
  const blockerCount = new Map<string, number>();
  const casByDate = new Map<string, number>();   // dias de CAS que ofrecio el portal
  let pairSightings = 0;
  let firedCount = 0;
  let bestEver: { date: string; p: string; c: string; gapMin: number; at: Date } | null = null;

  for (const row of rows) {
    const p = row.payload as Payload;
    const at = new Date(row.scannedAt);

    for (const d of p.allDays ?? []) {
      const e = daysSeen.get(d);
      if (!e) daysSeen.set(d, { n: 1, first: at, last: at });
      else { e.n += 1; if (at < e.first) e.first = at; if (at > e.last) e.last = at; }
    }
    for (const o of p.observations ?? []) {
      let e = timesSeen.get(o.date);
      if (!e) { e = { parents: new Set(), children: new Set(), bestGap: null, lastSeen: at }; timesSeen.set(o.date, e); }
      for (const t of o.parentsTimes ?? []) e.parents.add(t);
      for (const t of o.childrenTimes) e.children.add(t);
      if (at > e.lastSeen) e.lastSeen = at;
      for (const pr of o.pairs) {
        pairSightings += 1;
        if (e.bestGap === null || pr.gapMin < e.bestGap) e.bestGap = pr.gapMin;
        if (!bestEver || pr.gapMin < bestEver.gapMin) bestEver = { date: o.date, p: pr.p, c: pr.c, gapMin: pr.gapMin, at };
      }
    }
    for (const b of p.blockers ?? []) {
      const k = explainBlocker(b).short;
      blockerCount.set(k, (blockerCount.get(k) ?? 0) + 1);
    }
    for (const probe of p.casProbes ?? []) {
      const prev = casByDate.get(probe.consularDate);
      casByDate.set(probe.consularDate, Math.max(prev ?? 0, probe.casDaysOffered));
    }
    if (p.fired) firedCount += 1;
  }

  const topBlockers = [...blockerCount.entries()].sort((a, b) => b[1] - a[1]);
  const dominant = topBlockers[0];
  const dominantCode = (rows[0]!.payload as Payload).blockers?.[0] ?? '';
  const dominantLong = dominant ? explainBlocker(dominantCode).long : '';

  // ── Estado ──
  const statusTone = done ? 'good' : pairSightings > 0 ? 'warn' : 'idle';
  const statusLine = done
    ? 'Las dos citas quedaron el mismo dia.'
    : pairSightings > 0
      ? 'Todavia no. El portal si mostro un par valido, y algo lo bloqueo.'
      : 'Todavia no. El portal no ha mostrado ningun par valido.';

  const hero = `<section class="hero">
  <p class="eyebrow">${esc(g?.parents.applicants ?? 2)} + ${esc(g?.children.applicants ?? 3)} personas · ventana ${esc(winStart)} a ${esc(winEnd)}</p>
  <h1 class="tone-${statusTone}">${done ? 'Agendado' : 'Sin agendar'}</h1>
  <p class="lede">${esc(statusLine)}</p>
  ${!done && dominant ? `<p class="blocker"><span class="pill pill-stop">${esc(dominant[0])}</span> freno ${esc(dominant[1])} de ${rows.length} escaneos.<br><span class="blocker-long">${esc(dominantLong)}</span></p>` : ''}
</section>`;

  const stats = `<section class="stats">
  <div class="stat"><span class="n">${rows.length}</span><span class="l">escaneos</span></div>
  <div class="stat"><span class="n ${pairSightings ? 'tone-warn' : ''}">${pairSightings}</span><span class="l">pares vistos</span></div>
  <div class="stat"><span class="n ${firedCount ? 'tone-good' : ''}">${firedCount}</span><span class="l">envios</span></div>
  <div class="stat"><span class="n">${esc(p0.totalDays ?? 0)}</span><span class="l">dias ofrecidos</span></div>
  <div class="stat"><span class="n">${hhmm(new Date(latest.scannedAt))}</span><span class="l">ultimo escaneo</span></div>
</section>`;

  const closest = bestEver ? `<section class="block">
  <h2>Lo mas cerca que estuvimos</h2>
  <div class="near">
    <div class="near-date">${esc(bestEver.date)}</div>
    <div class="near-times">
      <span class="who">padres</span><span class="time">${esc(bestEver.p)}</span>
      <span class="arrow">→</span>
      <span class="who">ninos</span><span class="time">${esc(bestEver.c)}</span>
      <span class="gap">${esc(bestEver.gapMin)} min</span>
    </div>
    <div class="near-when">${esc(since(bestEver.at))} · visto ${pairSightings} ${pairSightings === 1 ? 'vez' : 'veces'}</div>
  </div>
  ${casByDate.get(bestEver.date) === 0 ? '<p class="foot tone-stop">Ese dia el portal ofrece cero dias de CAS. Por eso no se envio.</p>' : ''}
</section>` : '';

  // ── El mes de la ventana ──
  const winMonth = winStart.slice(0, 7);
  const monthDates = [...daysSeen.keys()].filter((d) => d.startsWith(winMonth)).sort();
  const monthRows = monthDates.map((d) => {
    const t = timesSeen.get(d);
    const cas = casByDate.get(d);
    const chips = t && t.children.size
      ? [...t.children].sort().map((x) => `<span class="chip">${esc(x)}</span>`).join('')
      : '<span class="muted">no consultado</span>';
    const state = t?.bestGap !== null && t?.bestGap !== undefined
      ? `<span class="pill pill-warn">par ${t.bestGap} min</span>`
      : inWin(d) ? '<span class="pill">sin par</span>' : '';
    const casPill = cas === undefined ? '' : cas === 0
      ? '<span class="pill pill-stop">sin CAS</span>'
      : `<span class="pill pill-ok">${cas} dias CAS</span>`;
    const gone = daysSeen.get(d)!.n < rows.length;
    return `<tr class="${inWin(d) ? 'in' : ''}">
      <td class="date">${esc(d.slice(8))}<span class="dow">${esc(dow(d))}</span></td>
      <td class="chips">${chips}</td>
      <td class="state">${state}${casPill}${gone ? `<span class="pill pill-fade">visto ${daysSeen.get(d)!.n}/${rows.length}</span>` : ''}</td>
    </tr>`;
  }).join('');

  const monthBlock = `<section class="block">
  <h2>${esc(winMonth)}</h2>
  <p class="sub">Las filas con barra son la ventana (${esc(winStart)} a ${esc(winEnd)}). Las horas son las del grupo de 3.</p>
  <div class="scroll"><table class="month">${monthRows || '<tr><td class="muted">sin datos</td></tr>'}</table></div>
</section>`;

  // ── Resto de meses, una linea ──
  const other = new Map<string, number>();
  for (const d of daysSeen.keys()) {
    const m = d.slice(0, 7);
    if (m === winMonth) continue;
    other.set(m, (other.get(m) ?? 0) + 1);
  }
  const otherLine = other.size === 0 ? '' : `<section class="block">
  <h2>Fuera de septiembre</h2>
  <p class="sub">El portal no ofrece nada entre octubre y diciembre de 2026. El siguiente bloque es 2027.</p>
  <div class="months">${[...other].sort().map(([m, n]) => `<span class="mo"><b>${esc(m)}</b>${esc(n)} dias</span>`).join('')}</div>
</section>`;

  const groupsBlock = g ? `<section class="block">
  <h2>Citas de hoy</h2>
  <div class="scroll"><table class="groups">
    <tr><th></th><th>consular</th><th>CAS</th></tr>
    <tr><td class="who">padres <span class="muted">bot ${esc(g.parents.botId)}</span></td>
      <td class="${g.parents.consularDate && inWin(g.parents.consularDate) ? 'tone-good' : ''}">${esc(g.parents.consularDate)} ${esc(g.parents.consularTime)}</td>
      <td>${esc(g.parents.casDate)} ${esc(g.parents.casTime)}</td></tr>
    <tr><td class="who">ninos <span class="muted">bot ${esc(g.children.botId)}</span></td>
      <td class="${g.children.consularDate && inWin(g.children.consularDate) ? 'tone-good' : ''}">${esc(g.children.consularDate)} ${esc(g.children.consularTime)}</td>
      <td>${esc(g.children.casDate)} ${esc(g.children.casTime)}</td></tr>
  </table></div>
</section>` : '';

  const blockersBlock = topBlockers.length > 1 ? `<section class="block">
  <h2>Que freno cada escaneo</h2>
  <div class="bars">${topBlockers.map(([k, n]) => `<div class="bar">
    <span class="bl">${esc(k)}</span>
    <span class="bt"><span class="bf" style="width:${Math.round((n / rows.length) * 100)}%"></span></span>
    <span class="bn">${esc(n)}</span>
  </div>`).join('')}</div>
</section>` : '';

  const rawBlock = raw ? renderRaw(rows) : '';

  return c.html(shell(scanKey, hours, raw,
    hero + stats + closest + monthBlock + blockersBlock + groupsBlock + otherLine + rawBlock));
});

const DOW = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];
function dow(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return DOW[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
}

function renderRaw(rows: Array<{ scannedAt: Date | string; phase: string; payload: unknown }>): string {
  const blocks = rows.slice(0, 120).map((r) => {
    const p = r.payload as Payload;
    const obs = p.observations ?? [];
    const lines = obs.map((o) => `<div class="rl">
      <span class="pill ${o.source === 'window' ? 'pill-win' : 'pill-fade'}">${o.source === 'window' ? 'ventana' : 'muestra'}</span>
      <span class="rd">${esc(o.date)}</span>
      ${(o.parentsTimes ?? []).length ? `<span class="who">padres</span>${(o.parentsTimes ?? []).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}` : ''}
      <span class="who">ninos</span>${o.childrenTimes.length ? o.childrenTimes.map((t) => `<span class="chip">${esc(t)}</span>`).join('') : '<span class="muted">-</span>'}
      ${o.pairs.length ? `<span class="pill pill-warn">${o.pairs.length} par(es)</span>` : ''}
    </div>`).join('');
    return `<div class="scan">
      <div class="scan-h"><b>${esc(bogota(new Date(r.scannedAt)))}</b>
        <span class="pill pill-fade">${esc(r.phase)}</span>
        <span class="muted">${esc(p.totalDays ?? 0)} dias</span>
        ${(p.blockers ?? []).map((b) => `<span class="pill pill-stop">${esc(explainBlocker(b).short)}</span>`).join('')}
      </div>${lines}</div>`;
  }).join('');
  return `<section class="block">
    <h2>Crudo, poll por poll</h2>
    <p class="sub">Lo que devolvio el portal en cada consulta, sin agregar.</p>
    ${blocks}
  </section>`;
}

function shell(scanKey: string, hours: number, raw: boolean, body: string): string {
  const link = (h: number) => `?key=${encodeURIComponent(scanKey)}&hours=${h}${raw ? '&raw=1' : ''}`;
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0C0C0E">
<title>Sniper ${esc(scanKey)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0C0C0E; --surface:#161618; --line:rgba(255,255,255,.07);
  --text:#9E9EA9; --bright:#E8E8EE; --muted:#5C5C67;
  --accent:#A78BFA; --accent-soft:rgba(167,139,250,.12);
  --good:#4ADE80; --warn:#FCD34D; --stop:#F87171;
  --step:1.25rem;
}
html{-webkit-text-size-adjust:100%}
body{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  background:var(--bg); color:var(--text); font-size:12px; line-height:1.6;
  max-width:680px; margin:0 auto; padding:20px 16px 64px;
  font-variant-numeric:tabular-nums; -webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
code{background:rgba(255,255,255,.05);padding:2px 6px;border-radius:4px;color:var(--bright);font-size:11px}

.top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;
  padding-bottom:28px}
.brand{font-size:12px;font-weight:800;color:var(--bright);letter-spacing:1.5px;text-transform:uppercase}
.brand em{font-style:normal;color:var(--accent)}
.nav{display:flex;gap:4px;align-items:baseline}
.nav a{padding:4px 9px;border:1px solid var(--line);border-radius:6px;font-size:10px;color:var(--muted)}
.nav a.on{border-color:var(--accent);color:var(--bright);background:var(--accent-soft)}

.hero{padding-bottom:28px;border-bottom:1px solid var(--line);margin-bottom:24px}
.eyebrow{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
h1{font-size:34px;line-height:1.1;font-weight:800;letter-spacing:-1px;color:var(--bright);
  text-wrap:balance;margin-bottom:10px}
h1.tone-good{color:var(--good)} h1.tone-warn{color:var(--warn)} h1.tone-idle{color:var(--bright)}
.lede{font-size:13px;color:var(--text);max-width:56ch}
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
.foot{font-size:11px;margin-top:10px}
.muted{color:var(--muted)}

.near{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:16px}
.near-date{font-size:22px;font-weight:800;color:var(--bright);letter-spacing:-.5px}
.near-times{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;margin-top:8px}
.near-times .time{font-size:16px;font-weight:700;color:var(--bright)}
.near-times .arrow{color:var(--muted)}
.near-times .gap{margin-left:4px;color:var(--warn);font-weight:700}
.who{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted)}
.near-when{margin-top:8px;font-size:10px;color:var(--muted)}

.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:11px}
th{text-align:left;font-weight:400;font-size:10px;color:var(--muted);text-transform:uppercase;
  letter-spacing:1px;padding:0 10px 6px}
td{padding:9px 10px;border-top:1px solid var(--line);vertical-align:middle}
.month tr.in td{background:var(--accent-soft)}
.month tr.in td:first-child{box-shadow:inset 2px 0 0 var(--accent)}
.month .date{font-size:15px;font-weight:700;color:var(--bright);white-space:nowrap;width:1%}
.month .dow{display:block;font-size:9px;font-weight:400;color:var(--muted);letter-spacing:1px;text-transform:uppercase}
.month .chips{width:99%}
.month .state{white-space:nowrap;text-align:right}
.groups .who{font-size:11px;color:var(--bright);text-transform:none;letter-spacing:0}

.chip{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:1px 6px;
  margin:2px 4px 2px 0;color:var(--bright);background:rgba(255,255,255,.03)}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 8px;
  margin-left:5px;font-size:10px;color:var(--muted);white-space:nowrap}
.pill-ok{border-color:rgba(74,222,128,.35);color:var(--good)}
.pill-warn{border-color:rgba(252,211,77,.35);color:var(--warn)}
.pill-stop{border-color:rgba(248,113,113,.35);color:var(--stop)}
.pill-win{border-color:rgba(167,139,250,.35);color:var(--accent)}
.pill-fade{opacity:.55}

.bars{display:flex;flex-direction:column;gap:7px}
.bar{display:grid;grid-template-columns:120px 1fr 40px;gap:10px;align-items:center;font-size:11px}
.bl{color:var(--bright);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt{height:6px;background:rgba(255,255,255,.05);border-radius:3px;overflow:hidden}
.bf{display:block;height:100%;background:var(--stop);opacity:.65}
.bn{text-align:right;color:var(--muted)}

.months{display:flex;flex-wrap:wrap;gap:6px}
.mo{display:flex;gap:6px;border:1px solid var(--line);border-radius:6px;padding:5px 9px;font-size:10px;color:var(--muted)}
.mo b{color:var(--bright);font-weight:700}

.scan{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:9px 11px;margin-bottom:5px}
.scan-h{display:flex;flex-wrap:wrap;gap:7px;align-items:center;font-size:10px;color:var(--muted);
  padding-bottom:6px;margin-bottom:5px;border-bottom:1px solid var(--line)}
.scan-h b{color:var(--bright);font-size:11px}
.rl{display:flex;flex-wrap:wrap;gap:5px;align-items:center;padding:2px 0}
.rd{color:var(--bright);font-weight:700}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="top">
  <div class="brand">sniper <em>${esc(scanKey)}</em></div>
  <nav class="nav">
    ${[6, 24, 72, 168].map((h) => `<a href="${link(h)}" class="${h === hours ? 'on' : ''}">${h}h</a>`).join('')}
    <a href="?key=${encodeURIComponent(scanKey)}&hours=${hours}${raw ? '' : '&raw=1'}" class="${raw ? 'on' : ''}">crudo</a>
    <a href="/dashboard">bots</a>
  </nav>
</div>
${body}
</body>
</html>`;
}

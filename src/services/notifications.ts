import { Resend } from 'resend';
import { createHmac } from 'node:crypto';
import { getCurrentPhase } from './scheduling.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let resendClient: Resend | null = null;

function getResend(): Resend {
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const resend = getResend();
  const recipients = to.includes(',') ? to.split(',').map(e => e.trim()) : to;
  await resend.emails.send({
    from: 'Visa Bot <onboarding@resend.dev>',
    to: recipients,
    subject,
    html,
  });
}

export async function sendWebhook(
  url: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify(payload);
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error('WEBHOOK_SECRET env var required for webhook signing');
  const signature = createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature': signature,
    },
    body,
  });
}

// ── Shared styles ──────────────────────────────────────

const STYLES = `
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 16px; }
  h2 { margin: 0 0 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
  .badge-green { background: #dcfce7; color: #166534; }
  .badge-red { background: #fee2e2; color: #991b1b; }
  .badge-orange { background: #ffedd5; color: #9a3412; }
  .badge-blue { background: #dbeafe; color: #1e40af; }
  .badge-gray { background: #f3f4f6; color: #374151; }
  .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 12px 0; background: #fafafa; }
  .row { display: flex; justify-content: space-between; padding: 4px 0; }
  .label { color: #6b7280; font-size: 14px; }
  .value { font-weight: 600; font-size: 14px; }
  .big { font-size: 20px; font-weight: 700; }
  .dim { color: #9ca3af; }
  .green { color: #16a34a; }
  .red { color: #dc2626; }
  .orange { color: #ea580c; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 13px; }
  th { background: #f3f4f6; text-align: left; padding: 6px 8px; border: 1px solid #e5e7eb; }
  td { padding: 6px 8px; border: 1px solid #e5e7eb; }
  code { background: #f3f4f6; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
  .arrow { font-size: 20px; color: #16a34a; }
  .footer { margin-top: 16px; padding-top: 12px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af; }
</style>`;

function wrap(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${STYLES}</head><body>${body}<div class="footer">Visa Bot &mdash; ${new Date().toISOString()}</div></body></html>`;
}

function daysImproved(oldDate: string | undefined, newDate: string | undefined): number | null {
  if (!oldDate || !newDate) return null;
  return Math.round((new Date(oldDate).getTime() - new Date(newDate).getTime()) / 86400000);
}

// ── Email templates ────────────────────────────────────

function buildEmail(event: string, data: Record<string, unknown>): { subject: string; html: string } {
  if (event === 'reschedule_success') {
    const isDry = !!data.dryRun;
    const days = daysImproved(data.oldConsularDate as string, data.newConsularDate as string);
    const subject = isDry
      ? '[DRY RUN] Reschedule simulado'
      : `Cita adelantada${days ? ` ${days} dias` : ''}!`;
    const html = wrap(`
<h2 style="color:#16a34a">${esc(subject)}</h2>
${isDry ? '<p><span class="badge badge-blue">DRY RUN</span> Simulacion &mdash; no se hizo cambio real.</p>' : ''}
<div class="card">
  <table>
    <tr><th></th><th>Consular</th><th>CAS</th></tr>
    <tr>
      <td class="label">Anterior</td>
      <td><s class="dim">${esc(String(data.oldConsularDate ?? '?'))} ${esc(String(data.oldConsularTime ?? ''))}</s></td>
      <td><s class="dim">${esc(String(data.oldCasDate ?? '?'))} ${esc(String(data.oldCasTime ?? ''))}</s></td>
    </tr>
    <tr>
      <td class="label">Nueva</td>
      <td class="green big">${esc(String(data.newConsularDate ?? '?'))} ${esc(String(data.newConsularTime ?? ''))}</td>
      <td class="green">${esc(String(data.newCasDate ?? '?'))} ${esc(String(data.newCasTime ?? ''))}</td>
    </tr>
  </table>
</div>
${days ? `<p class="big green">&uarr; ${days} dias antes</p>` : ''}
${data.selectionStrategy ? `<div class="card" style="font-size:12px">
  <b>Estrategia:</b> <code>${esc(String(data.selectionStrategy))}</code>
  ${data.attempt ? ` &middot; intento ${data.attempt}` : ''}
  ${data.candidateIdx !== undefined ? ` &middot; candidato #${Number(data.candidateIdx) + 1}/${data.totalCandidates ?? '?'}` : ''}
</div>` : ''}
<p>El bot seguira monitoreando cada <b>${getCurrentPhase().label}</b> por si aparecen fechas aun mejores.</p>`);
    return { subject, html };
  }

  if (event === 'reschedule_failed') {
    const subject = 'Fecha encontrada pero no agendada';
    const attempts = (data.attempts as Array<{ date: string; consularTime?: string; casDate?: string; casTime?: string; failReason: string; failStep?: string; error?: string; cause?: string; durationMs: number }>) || [];
    const rows = attempts.map((a) => {
      const errorDetail = a.error ? `<br><span class="dim" style="font-size:11px">${esc(a.error)}${a.cause ? ` (${esc(a.cause)})` : ''}</span>` : '';
      return `<tr><td>${esc(a.date)}</td><td>${esc(a.consularTime ?? '-')}</td><td><code>${esc(a.failReason)}</code>${a.failStep ? `<br><span class="dim" style="font-size:11px">@ ${esc(a.failStep)}</span>` : ''}${errorDetail}</td><td>${a.durationMs}ms</td></tr>`;
    }).join('');
    const html = wrap(`
<h2 style="color:#ea580c">${esc(subject)}</h2>
<p>Se encontraron fechas mejores que <b>${esc(String(data.currentDate ?? '?'))}</b> pero no se pudieron agendar.</p>
<div class="card">
  <p><b>Tiempo total:</b> ${data.totalDurationMs ?? '?'}ms &nbsp; <b>Intentos:</b> ${attempts.length}</p>
  <table>
    <tr><th>Fecha</th><th>Hora</th><th>Error</th><th>Duracion</th></tr>
    ${rows}
  </table>
</div>
<p>El bot seguira monitoreando cada <b>${getCurrentPhase().label}</b>.</p>`);
    return { subject, html };
  }

  if (event === 'tcp_blocked') {
    const backoff = data.tcpBackoff as number | undefined;
    const delayMin = backoff ? Math.min(backoff * 5, 30) : 5;
    const subject = 'TCP BLOCK — conexion rechazada';
    const html = wrap(`
<h2 style="color:#dc2626">${esc(subject)}</h2>
<p><span class="badge badge-red">SITIO CAIDO</span> El servidor esta rechazando conexiones TCP (sitio caido o rate-limit severo).</p>
<div class="card">
  <p><b>Error:</b> <code>${esc(String(data.error ?? ''))}</code></p>
  ${data.window ? `<p><b>Ventana:</b> ${esc(String(data.window))}</p>` : ''}
  ${data.fetchNumber ? `<p><b>Fetch #:</b> ${data.fetchNumber}</p>` : ''}
  <p><b>Proximo reintento:</b> ${delayMin} min (backoff escalado)</p>
</div>
<p>El bot <b>no se detendra</b> por errores TCP &mdash; seguira reintentando con backoff escalado (5, 10, 15... hasta 30 min).</p>
<p><b>No se requiere accion.</b> El bot se recuperara automaticamente cuando el sitio vuelva.</p>`);
    return { subject, html };
  }

  if (event === 'server_throttled') {
    const backoff = data.tcpBackoff as number | undefined;
    const delayMin = backoff ? Math.min(backoff * 5, 30) : 5;
    const subject = 'Servidor devolviendo 502 — backoff activado';
    const html = wrap(`
<h2 style="color:#ea580c">${esc(subject)}</h2>
<p><span class="badge badge-orange">SERVIDOR SATURADO</span> Errores HTTP 5xx repetidos. Precursor de soft ban o bloqueo TCP.</p>
<div class="card">
  <p><b>Error:</b> <code>${esc(String(data.error ?? ''))}</code></p>
  <p><b>5xx consecutivos:</b> ${data.consecutive5xx ?? '?'}</p>
  ${data.window ? `<p><b>Ventana:</b> ${esc(String(data.window))}</p>` : ''}
  <p><b>Proximo reintento:</b> ${delayMin} min (backoff escalado)</p>
</div>
<p>El bot <b>no se detendra</b> por errores 5xx &mdash; seguira reintentando con backoff escalado.</p>`);
    return { subject, html };
  }

  if (event === 'soft_ban_suspected') {
    const subject = 'Soft ban — fechas cayeron a casi cero';
    const html = wrap(`
<h2 style="color:#ea580c">${esc(subject)}</h2>
<p><span class="badge badge-orange">ADVERTENCIA</span> La API paso de devolver <b>${data.previousCount ?? '?'}</b> fechas a <b>${data.currentCount ?? '?'}</b>.</p>
<div class="card">
  ${data.window ? `<p><b>Ventana:</b> ${esc(String(data.window))}</p>` : ''}
  <p><b>Duracion tipica:</b> 5-20 horas (reset a medianoche EST)</p>
</div>
<p>El bot seguira monitoreando, pero las respuestas no seran confiables hasta que se levante.</p>`);
    return { subject, html };
  }

  if (event === 'session_expired') {
    const subject = 'Sesion expirada — re-login fallido';
    const html = wrap(`
<h2 style="color:#ea580c">${esc(subject)}</h2>
<p><span class="badge badge-orange">ACCION</span> La sesion expiro y el re-login automatico inline fallo.</p>
<div class="card">
  ${data.scheduleId ? `<p><b>Schedule:</b> ${esc(String(data.scheduleId))}</p>` : ''}
  <p><b>Mensaje:</b> ${esc(String(data.message ?? ''))}</p>
</div>
<p>El bot reintentara login automaticamente. Si persiste, reactiva con <code>POST /api/bots/:id/activate</code>.</p>`);
    return { subject, html };
  }

  if (event === 'bot_error') {
    const subject = 'Bot en error — reintentara en 30min';
    const html = wrap(`
<h2 style="color:#dc2626">${esc(subject)}</h2>
<p><span class="badge badge-red">ERROR</span> El bot alcanzo 5 errores consecutivos de sesion/logica.</p>
<div class="card">
  <p><b>Razon:</b> ${esc(String(data.message ?? ''))}</p>
  <p><b>Ultimo error:</b> <code>${esc(String(data.lastError ?? ''))}</code></p>
</div>
<p><b>Auto-recovery:</b> El bot reintentara automaticamente cada 30 min. Si el problema se resuelve solo, volvera a <code>active</code> sin intervencion.</p>
<p class="dim">Nota: errores TCP y 5xx (sitio caido) NO cuentan para este limite &mdash; solo errores de sesion o logica.</p>
<p>Si el error persiste, revisa las credenciales y reactiva con <code>POST /api/bots/:id/activate</code>.</p>`);
    return { subject, html };
  }

  if (event === 'cas_slots_changed') {
    const changes = (data.changes as Array<{ date: string; type: string; oldSlots: number; newSlots: number; addedTimes?: string[]; removedTimes?: string[]; confidence?: string }>) || [];
    const reliability = data.reliability as { reliable?: boolean; failureRate?: number; failedCalls?: number; totalApiCalls?: number } | undefined;
    const appeared = changes.filter((c) => c.type === 'appeared');
    const wentFull = changes.filter((c) => c.type === 'went_full');
    const disappeared = changes.filter((c) => c.type === 'disappeared');
    const slotsChanged = changes.filter((c) => c.type === 'slots_changed');

    const parts: string[] = [];
    if (appeared.length > 0) parts.push(`${appeared.length} aparecieron`);
    if (wentFull.length > 0) parts.push(`${wentFull.length} FULL`);
    if (disappeared.length > 0) parts.push(`${disappeared.length} desaparecieron`);
    if (slotsChanged.length > 0) parts.push(`${slotsChanged.length} cambiaron`);
    const subject = `CAS slots cambiaron — ${parts.join(', ')}`;

    const dayName = (d: string) => {
      const dt = new Date(d + 'T12:00:00');
      return dt.toLocaleDateString('es-CO', { weekday: 'short' });
    };

    const fmtTimes = (times: string[], max: number, cls: string, prefix: string) => {
      if (times.length === 0) return '';
      const show = times.slice(0, max);
      const extra = times.length > max ? ` <span class="${cls}">+${times.length - max} mas</span>` : '';
      return show.map((t) => `<span class="${cls}">${esc(prefix + t)}</span>`).join(' ') + extra;
    };

    const confBadge = (c: { confidence?: string }) => {
      if (c.confidence === 'low') return ' <span class="badge badge-orange" style="font-size:10px">?</span>';
      if (c.confidence === 'error') return ' <span class="badge badge-red" style="font-size:10px">ERR</span>';
      return '';
    };

    const changeRow = (c: typeof changes[number]) => {
      const day = dayName(c.date);
      const added = c.addedTimes || [];
      const removed = c.removedTimes || [];
      const timeDiffRow = (added.length > 0 || removed.length > 0)
        ? `<tr><td colspan="4" style="font-size:11px;color:#6b7280;padding-left:16px">${fmtTimes(added, 8, 'green', '+')} ${fmtTimes(removed, 8, 'red', '-')}</td></tr>`
        : '';

      if (c.type === 'appeared') {
        const from = c.oldSlots === -1 ? 'nuevo' : c.oldSlots === 0 ? 'FULL' : `${c.oldSlots}`;
        return `<tr><td>${esc(c.date)}</td><td>${esc(day)}</td><td><span class="badge badge-green">APARECIO</span>${confBadge(c)}</td><td>${esc(from)} &rarr; <b class="green">${c.newSlots}</b></td></tr>${timeDiffRow}`;
      }
      if (c.type === 'went_full') {
        return `<tr><td>${esc(c.date)}</td><td>${esc(day)}</td><td><span class="badge badge-red">FULL</span>${confBadge(c)}</td><td>${c.oldSlots} &rarr; <b class="red">0</b></td></tr>${timeDiffRow}`;
      }
      if (c.type === 'slots_changed') {
        const color = c.newSlots > c.oldSlots ? 'green' : 'orange';
        return `<tr><td>${esc(c.date)}</td><td>${esc(day)}</td><td><span class="badge badge-blue">CAMBIO</span>${confBadge(c)}</td><td>${c.oldSlots} &rarr; <b class="${color}">${c.newSlots}</b></td></tr>${timeDiffRow}`;
      }
      // disappeared
      return `<tr><td>${esc(c.date)}</td><td>${esc(day)}</td><td><span class="badge badge-gray">DESAPARECIO</span>${confBadge(c)}</td><td>${c.oldSlots} &rarr; <span class="dim">-</span></td></tr>${timeDiffRow}`;
    };

    const rows = changes.map(changeRow).join('');
    const total = data.totalDates as number;
    const full = data.fullDates as number;

    const reliabilityWarning = reliability && !reliability.reliable
      ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:#92400e"><b>Confiabilidad baja</b> &mdash; ${reliability.failedCalls}/${reliability.totalApiCalls} llamadas fallaron (${Math.round((reliability.failureRate ?? 0) * 100)}%). Algunos cambios pueden ser falsos positivos.</div>`
      : '';

    const html = wrap(`
<h2>${esc(subject)}</h2>
${reliabilityWarning}
<p>Se detectaron <b>${changes.length}</b> cambios en slots CAS (ventana 30 dias).</p>
<div class="card">
  <div class="row"><span class="label">Total fechas</span><span class="value">${total}</span></div>
  <div class="row"><span class="label">FULL</span><span class="value ${full > 0 ? 'red' : ''}">${full}</span></div>
  <div class="row"><span class="label">Cambios</span><span class="value">${changes.length}</span></div>
</div>
${appeared.length > 0 ? `<p class="green"><b>${appeared.length} fecha(s) con slots nuevos</b> &mdash; posibles cancelaciones liberaron cupo.</p>` : ''}
${wentFull.length > 0 ? `<p class="red"><b>${wentFull.length} fecha(s) se llenaron</b> &mdash; ya no tienen slots.</p>` : ''}
${disappeared.length > 0 ? `<p class="dim"><b>${disappeared.length} fecha(s) desaparecieron</b> del rango CAS.</p>` : ''}
${slotsChanged.length > 0 ? `<p style="color:#2563eb"><b>${slotsChanged.length} fecha(s) cambiaron slots</b> &mdash; horarios agregados/removidos.</p>` : ''}
<table>
  <tr><th>Fecha</th><th>Dia</th><th>Cambio</th><th>Slots</th></tr>
  ${rows}
</table>
<p class="dim">Proxima verificacion en ~30 min (cron cloud).</p>`);
    return { subject, html };
  }

  if (event === 'cas_prefetch_complete') {
    const total = data.totalDates as number;
    const full = data.fullDates as number;
    const low = data.lowDates as number;
    const available = total - full;
    const filling = !!data.casFillingUp;
    const isFirst = !!data.isFirstRun;

    const badgeClass = full === 0 ? 'badge-green' : full > total / 2 ? 'badge-red' : 'badge-orange';
    const badgeText = full === 0 ? 'OK' : filling ? 'LLENANDOSE' : `${full} FULL`;
    const subject = filling
      ? `CAS llenandose — ${full} fechas FULL`
      : isFirst
        ? `CAS Cache activado — ${available}/${total} disponibles`
        : `CAS Cache — ${available}/${total} disponibles`;

    const dangerEntries = (data.dangerEntries as Array<{ date: string; slots: number; times: string[] }>) || [];
    const rows = dangerEntries.map((e) => {
      const d = new Date(e.date + 'T12:00:00');
      const dayName = d.toLocaleDateString('es-CO', { weekday: 'short' });
      const color = e.slots === 0 ? 'color:#dc2626;font-weight:bold' : 'color:#ea580c';
      const slotsText = e.slots === 0 ? 'FULL' : `${e.slots} slots`;
      const timeRange = e.times.length > 0 ? `${e.times[0]} - ${e.times[e.times.length - 1]}` : '-';
      return `<tr><td>${esc(e.date)}</td><td>${esc(dayName)}</td><td style="${color}">${slotsText}</td><td class="dim">${esc(timeRange)}</td></tr>`;
    }).join('');

    const html = wrap(`
<h2>${esc(subject)}</h2>
<p><span class="badge ${badgeClass}">${badgeText}</span>
${isFirst ? ' <span class="badge badge-blue">PRIMERA VEZ</span>' : ''}
${filling ? ' &mdash; Fechas que tenian slots ahora estan FULL.' : ''}</p>
<div class="card">
  <div class="row"><span class="label">Disponibles</span><span class="value green">${available}/${total}</span></div>
  <div class="row"><span class="label">FULL (0 slots)</span><span class="value ${full > 0 ? 'red' : ''}">${full}</span></div>
  <div class="row"><span class="label">Bajas (1-10)</span><span class="value ${low > 0 ? 'orange' : ''}">${low}</span></div>
  <div class="row"><span class="label">Duracion</span><span class="value">${data.durationMs ?? '?'}ms</span></div>
</div>
${dangerEntries.length > 0 ? `
<p><b>Fechas en peligro:</b></p>
<table>
  <tr><th>Fecha</th><th>Dia</th><th>Slots</th><th>Rango</th></tr>
  ${rows}
</table>` : ''}
<p class="dim">Proxima actualizacion en ~30 min (cron cloud).</p>`);
    return { subject, html };
  }

  if (event === 'cas_prefetch_failed') {
    const ageMin = data.cacheAgeMin as number;
    const reason = data.reason as string;
    const subject = `CAS Cache stale (${ageMin}min) — prefetch fallando`;
    const html = wrap(`
<h2 style="color:#ea580c">${esc(subject)}</h2>
<p><span class="badge badge-orange">CACHE STALE</span> El cron de CAS prefetch no ha podido actualizar el cache en ${ageMin} minutos.</p>
<div class="card">
  <div class="row"><span class="label">Edad del cache</span><span class="value orange">${ageMin} min</span></div>
  <div class="row"><span class="label">Razon del fallo</span><span class="value"><code>${esc(reason)}</code></span></div>
  <div class="row"><span class="label">Frecuencia cron</span><span class="value">cada 30 min</span></div>
</div>
<p>Posibles causas: sesion expirada, sitio caido, rate limiting desde cloud.</p>
<p class="dim">Esta alerta se envia maximo 1 vez por hora mientras el cache este stale. El cron seguira reintentando cada 30 min.</p>`);
    return { subject, html };
  }

  if (event === 'invalid_credentials') {
    const subject = 'Credenciales invalidas — bot detenido';
    const html = wrap(`
<h2 style="color:#dc2626">${esc(subject)}</h2>
<p><span class="badge badge-red">ACCION</span> ${esc(String(data.message ?? ''))}</p>
<p>Actualiza las credenciales y reactiva con <code>POST /api/bots/:id/activate</code>.</p>`);
    return { subject, html };
  }

  // Generic fallback
  const subject = `Visa bot: ${event}`;
  const html = wrap(`
<h2>${esc(subject)}</h2>
<div class="card">
  <pre style="white-space:pre-wrap;word-break:break-all;margin:0;font-size:13px;">${esc(JSON.stringify(data, null, 2))}</pre>
</div>`);
  return { subject, html };
}

export async function notifyUser(
  bot: { notificationEmail: string | null; ownerEmail?: string | null; webhookUrl: string | null },
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  const payload = { event, data, timestamp: new Date().toISOString() };

  const promises: Promise<void>[] = [];

  if (bot.notificationEmail) {
    const { subject, html } = buildEmail(event, data);
    promises.push(sendEmail(bot.notificationEmail, subject, html));
  }

  // Owner only gets reschedule_success — no operational spam
  if (bot.ownerEmail && event === 'reschedule_success') {
    const { subject, html } = buildEmail(event, data);
    promises.push(sendEmail(bot.ownerEmail, subject, html));
  }

  if (bot.webhookUrl) {
    promises.push(sendWebhook(bot.webhookUrl, payload));
  }

  await Promise.allSettled(promises);
}

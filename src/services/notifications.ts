import { Resend } from 'resend';
import { createHmac } from 'node:crypto';
import { DEFAULT_POLL_INTERVAL_S } from './scheduling.js';
import { db } from '../db/client.js';
import { notificationLogs } from '../db/schema.js';

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

async function logNotification(
  botId: number,
  event: string,
  channel: 'email' | 'webhook',
  recipient: string,
  status: 'sent' | 'failed',
  opts?: { externalId?: string; error?: string },
): Promise<void> {
  try {
    await db.insert(notificationLogs).values({ botId, event, channel, recipient, status, externalId: opts?.externalId, error: opts?.error });
  } catch (e) {
    console.error(`[notify] failed to persist notification_log bot=${botId} event=${event} error=${e instanceof Error ? e.message : String(e)}`);
  }
}

async function sendEmail(
  botId: number,
  event: string,
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const resend = getResend();
  const recipients = to.includes(',') ? to.split(',').map(e => e.trim()) : to;
  try {
    const result = await resend.emails.send({
      from: 'Agente R <notificaciones@notifications.visagente.com>',
      to: recipients,
      subject,
      html,
    });
    const externalId = result.data?.id ?? undefined;
    console.log(`[notify] email sent bot=${botId} event=${event} to=${to} id=${externalId ?? 'unknown'}`);
    await logNotification(botId, event, 'email', to, 'sent', { externalId });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[notify] email FAILED bot=${botId} event=${event} to=${to} error=${error}`);
    await logNotification(botId, event, 'email', to, 'failed', { error });
    throw e;
  }
}

async function sendWebhook(
  botId: number,
  event: string,
  url: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify(payload);
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error('WEBHOOK_SECRET env var required for webhook signing');
  const signature = createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    console.log(`[notify] webhook sent bot=${botId} event=${event} url=${url} status=${res.status}`);
    await logNotification(botId, event, 'webhook', url, 'sent');
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[notify] webhook FAILED bot=${botId} event=${event} url=${url} error=${error}`);
    await logNotification(botId, event, 'webhook', url, 'failed', { error });
    throw e;
  }
}

// ── Shared styles ──────────────────────────────────────

// Shared inline style constants
const F_SYNE = `font-family:'Outfit',Arial,sans-serif`;
const F_BODY = `font-family:'Plus Jakarta Sans',Arial,sans-serif`;
const C_DARK  = `#0f172a`;
const C_NAVY  = `#111827`;   // visagente dark hero bg
const C_MID   = `#64748b`;
const C_DIM   = `#94a3b8`;
const C_TEAL  = `#22d3a7`;
const C_TEAL_BG = `#f0fdf9`; // subtle mint tint
const C_RED   = `#dc2626`;
const C_ORANGE= `#ea580c`;
const C_BG    = `#f8fafc`;
const C_BORDER= `#e2e8f0`;

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  const months = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const parts = d.split('-');
  return `${parseInt(parts[2]!)} ${months[parseInt(parts[1]!) - 1]} ${parts[0]}`;
}

function fmtDateTime(date: string | null | undefined, time: string | null | undefined): string {
  if (!date) return '—';
  return time ? `${fmtDate(date)} · ${time}` : fmtDate(date);
}

function badge(text: string, bg: string, color: string): string {
  return `<span style="display:inline-block;padding:3px 10px;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;background:${bg};color:${color}">${text}</span>`;
}

function kvTable(rows: Array<[string, string]>): string {
  const trs = rows.map(([label, val]) =>
    `<tr><td style="${F_BODY};font-size:14px;color:${C_MID};padding:8px 0;border-bottom:1px solid ${C_BORDER};width:50%">${label}</td><td style="${F_BODY};font-size:14px;font-weight:600;color:${C_DARK};text-align:right;padding:8px 0;border-bottom:1px solid ${C_BORDER}">${val}</td></tr>`
  ).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${trs}</table>`;
}

function dataTable(headers: string[], rows: string[]): string {
  const ths = headers.map(h => `<th style="${F_BODY};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:${C_MID};background:${C_BG};padding:8px 10px;border:1px solid ${C_BORDER};text-align:left">${h}</th>`).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;margin:12px 0"><tr>${ths}</tr>${rows.join('')}</table>`;
}

function card(content: string, opts?: { teal?: boolean }): string {
  const border = opts?.teal ? `border-left:3px solid ${C_TEAL};border-top:1px solid ${C_BORDER};border-right:1px solid ${C_BORDER};border-bottom:1px solid ${C_BORDER}` : `border:1px solid ${C_BORDER}`;
  return `<table width="100%" cellpadding="0" cellspacing="0" style="${border};border-radius:12px;margin:16px 0"><tr><td style="padding:20px;background:#ffffff;border-radius:12px">${content}</td></tr></table>`;
}

function wrap(body: string): string {
  const footer = `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:32px;border-top:1px solid ${C_BORDER}"><tr><td style="${F_BODY};font-size:12px;color:${C_MID};padding-top:16px">Agente R &mdash; <a href="https://visagente.com" style="color:#0d9488;text-decoration:none">visagente.com</a> &mdash; ${new Date().toISOString()}</td></tr></table>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@700;800&family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:${C_BG}">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="${C_BG}">
  <tr><td align="center" style="padding:32px 16px">
    <!-- Dark header bar — matches visagente landing (grid overlay) -->
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;border-radius:16px 16px 0 0;overflow:hidden">
      <tr><td style="padding:28px 32px;background-color:${C_NAVY};background-image:linear-gradient(rgba(255,255,255,0.045) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.045) 1px,transparent 1px);background-size:28px 28px;border-radius:16px 16px 0 0">
        <table cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:middle;padding-right:14px">
            <img src="https://www.visagente.com/glasses.png" alt="" style="display:block;border:0;height:1.6em;width:auto">
          </td>
          <td style="vertical-align:middle">
            <span style="${F_SYNE};font-size:22px;font-weight:800;letter-spacing:-0.02em;color:#ffffff;line-height:1">vis<span style="color:${C_TEAL}">agente</span></span>
          </td>
        </tr></table>
      </td></tr>
    </table>
    <!-- White body card -->
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:0 0 16px 16px;border:1px solid ${C_BORDER};border-top:none">
      <tr><td style="padding:32px 36px 0">
        ${body}
        ${footer}
      </td></tr>
      <tr><td style="height:32px"></td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
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

    const oldConsularFmt = fmtDateTime(data.oldConsularDate as string, data.oldConsularTime as string);
    const newConsularFmt = fmtDateTime(data.newConsularDate as string, data.newConsularTime as string);
    const oldCasFmt = data.oldCasDate ? fmtDateTime(data.oldCasDate as string, data.oldCasTime as string) : null;
    const newCasFmt = data.newCasDate ? fmtDateTime(data.newCasDate as string, data.newCasTime as string) : null;

    const daysHtml = days
      ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;background:${C_TEAL_BG};border-radius:12px">
  <tr><td style="padding:20px 24px">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="${F_SYNE};font-size:80px;font-weight:800;color:#0d9488;line-height:1;vertical-align:middle">${days}</td>
      <td style="${F_BODY};font-size:15px;color:${C_MID};padding-left:16px;vertical-align:middle;line-height:1.4">días<br>antes</td>
    </tr></table>
  </td></tr>
</table>`
      : '';

    const casTagStyle = `display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;letter-spacing:0.05em;background:${C_BG};color:${C_MID};border:1px solid ${C_BORDER};margin-right:5px;vertical-align:middle`;

    const oldRowContent = `<table width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td style="${F_BODY};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${C_MID};padding-bottom:6px">Anterior</td>
  </tr>
  <tr>
    <td style="${F_BODY};font-size:17px;color:${C_MID};text-decoration:line-through">${oldConsularFmt}</td>
  </tr>
  ${oldCasFmt ? `<tr><td style="${F_BODY};font-size:13px;color:${C_MID};padding-top:4px"><span style="${casTagStyle}">ASC</span><span style="text-decoration:line-through">${oldCasFmt}</span></td></tr>` : ''}
</table>`;

    const newRowContent = `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;padding-top:14px;border-top:1px solid ${C_BORDER}">
  <tr>
    <td style="${F_BODY};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${C_MID};padding-bottom:6px">Nueva</td>
  </tr>
  <tr>
    <td style="${F_SYNE};font-size:22px;font-weight:800;color:${C_DARK}">${newConsularFmt}</td>
  </tr>
  ${newCasFmt ? `<tr><td style="${F_BODY};font-size:13px;color:${C_MID};padding-top:6px"><span style="${casTagStyle}">ASC</span><span style="${F_BODY};font-weight:600;color:#0d9488">${newCasFmt}</span></td></tr>` : ''}
</table>`;

    const html = wrap(`
${isDry ? `<p style="margin-bottom:16px">${badge('DRY RUN', '#dbeafe', '#1e40af')} &nbsp;<span style="${F_BODY};font-size:15px;color:${C_MID}">Simulacion &mdash; no se hizo cambio real.</span></p>` : ''}
<p style="${F_SYNE};font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#0d9488;margin:0 0 8px">MISIÓN COMPLETADA</p>
<h2 style="${F_SYNE};font-size:26px;font-weight:800;color:${C_DARK};margin:0 0 4px">Movimos tu cita${days ? ` <span style="color:#0d9488">${days} días</span> antes` : ''}</h2>
${daysHtml}
${card(oldRowContent + newRowContent, { teal: true })}
<p style="${F_BODY};font-size:15px;color:${C_MID};margin-top:20px">Seguimos buscando. Si aparece algo mejor, lo movemos.</p>`);
    return { subject, html };
  }

  if (event === 'reschedule_failed') {
    const subject = 'Fecha encontrada pero no agendada';
    const attempts = (data.attempts as Array<{ date: string; consularTime?: string; casDate?: string; casTime?: string; failReason: string; failStep?: string; error?: string; cause?: string; durationMs: number }>) || [];
    const tdStyle = `${F_BODY};font-size:14px;color:${C_DARK};padding:8px 10px;border:1px solid ${C_BORDER};vertical-align:top`;
    const tdDimStyle = `${F_BODY};font-size:14px;color:${C_MID};padding:8px 10px;border:1px solid ${C_BORDER};vertical-align:top`;
    const rows = attempts.map((a) => {
      const errorDetail = a.error
        ? `<br><span style="${F_BODY};font-size:11px;color:${C_MID}">${esc(a.error)}${a.cause ? ` (${esc(a.cause)})` : ''}</span>`
        : '';
      return `<tr>
  <td style="${tdStyle}">${fmtDate(a.date)}</td>
  <td style="${tdStyle}">${esc(a.consularTime ?? '-')}</td>
  <td style="${tdStyle}"><code style="${F_BODY};font-size:13px">${esc(a.failReason)}</code>${a.failStep ? `<br><span style="${F_BODY};font-size:11px;color:${C_MID}">@ ${esc(a.failStep)}</span>` : ''}${errorDetail}</td>
  <td style="${tdDimStyle}">${a.durationMs}ms</td>
</tr>`;
    }).join('');
    const html = wrap(`
<h2 style="${F_SYNE};font-size:24px;font-weight:800;color:${C_DARK};margin:0 0 12px"><span style="color:${C_ORANGE}">Fecha encontrada</span> pero no agendada</h2>
<p style="${F_BODY};font-size:15px;color:${C_MID};margin:0 0 16px">Se encontraron fechas mejores que <strong style="color:${C_DARK}">${fmtDate(data.currentDate as string)}</strong> pero no se pudieron agendar.</p>
${card(kvTable([
  ['Tiempo total', `${data.totalDurationMs ?? '?'}ms`],
  ['Intentos', String(attempts.length)],
]))}
${dataTable(['Fecha', 'Hora', 'Error', 'Dur.'], rows.split('\n').filter(Boolean).length > 0 ? [rows] : [])}
<p style="${F_BODY};font-size:15px;color:${C_MID};margin-top:20px">El bot sigue monitoreando cada <strong style="color:${C_DARK}">${DEFAULT_POLL_INTERVAL_S}s</strong>.</p>`);
    return { subject, html };
  }

  if (event === 'tcp_blocked') {
    const backoff = data.tcpBackoff as number | undefined;
    const delayMin = backoff ? Math.min(backoff * 5, 30) : 5;
    const subject = 'TCP BLOCK — conexion rechazada';
    const kvRows: Array<[string, string]> = [];
    if (data.error) kvRows.push(['Error', `<code style="${F_BODY};font-size:13px">${esc(String(data.error))}</code>`]);
    if (data.window) kvRows.push(['Ventana', esc(String(data.window))]);
    if (data.fetchNumber) kvRows.push(['Fetch #', String(data.fetchNumber)]);
    kvRows.push(['Próximo reintento', `<span style="color:#0d9488;font-weight:600">${delayMin} min</span>`]);
    const html = wrap(`
<h2 style="${F_SYNE};font-size:24px;font-weight:800;color:${C_DARK};margin:0 0 12px"><span style="color:${C_RED}">TCP Block</span> — conexión rechazada</h2>
<p style="${F_BODY};font-size:15px;color:${C_MID};margin:0 0 16px">${badge('SITIO CAIDO', '#fee2e2', C_RED)} &nbsp;El servidor rechaza conexiones TCP. Sitio caído o rate-limit severo.</p>
${card(kvTable(kvRows))}
<p style="${F_BODY};font-size:15px;color:${C_MID};margin-top:20px">El bot no se detendrá — backoff escalado hasta 30 min. No se requiere acción.</p>`);
    return { subject, html };
  }

  if (event === 'server_throttled') {
    const backoff = data.tcpBackoff as number | undefined;
    const delayMin = backoff ? Math.min(backoff * 5, 30) : 5;
    const subject = 'Servidor 502 — backoff activado';
    const kvRows: Array<[string, string]> = [];
    if (data.error) kvRows.push(['Error', `<code style="${F_BODY};font-size:13px">${esc(String(data.error))}</code>`]);
    kvRows.push(['5xx consecutivos', `<span style="color:${C_ORANGE};font-weight:600">${data.consecutive5xx ?? '?'}</span>`]);
    if (data.window) kvRows.push(['Ventana', esc(String(data.window))]);
    kvRows.push(['Próximo reintento', `<span style="color:#0d9488;font-weight:600">${delayMin} min</span>`]);
    const html = wrap(`
<h2 style="${F_SYNE};font-size:24px;font-weight:800;color:${C_DARK};margin:0 0 12px"><span style="color:${C_ORANGE}">Servidor saturado</span> — 502 repetido</h2>
<p style="${F_BODY};font-size:15px;color:${C_MID};margin:0 0 16px">${badge('SERVIDOR SATURADO', '#ffedd5', C_ORANGE)} &nbsp;Errores HTTP 5xx repetidos. Precursor de soft ban.</p>
${card(kvTable(kvRows))}
<p style="${F_BODY};font-size:15px;color:${C_MID};margin-top:20px">El bot sigue con backoff escalado.</p>`);
    return { subject, html };
  }

  if (event === 'soft_ban_suspected') {
    const subject = 'Soft ban — fechas cayeron a casi cero';
    const kvRows: Array<[string, string]> = [];
    if (data.window) kvRows.push(['Ventana', esc(String(data.window))]);
    kvRows.push(['Duración típica', '5–20 horas']);
    const html = wrap(`
<h2 style="${F_SYNE};font-size:24px;font-weight:800;color:${C_DARK};margin:0 0 12px"><span style="color:${C_ORANGE}">Soft ban</span> — fechas a cero</h2>
<p style="${F_BODY};font-size:15px;color:${C_MID};margin:0 0 16px">${badge('ADVERTENCIA', '#ffedd5', C_ORANGE)} &nbsp;La API pasó de devolver <strong style="color:${C_DARK}">${data.previousCount ?? '?'}</strong> fechas a <strong style="color:${C_RED}">${data.currentCount ?? '?'}</strong>.</p>
${card(kvTable(kvRows))}
<p style="${F_BODY};font-size:15px;color:${C_MID};margin-top:20px">Las respuestas no serán confiables hasta que se levante el ban.</p>`);
    return { subject, html };
  }

  if (event === 'session_expired') {
    const subject = 'Sesión expirada — re-login fallido';
    const kvRows: Array<[string, string]> = [];
    if (data.scheduleId) kvRows.push(['Schedule', esc(String(data.scheduleId))]);
    kvRows.push(['Mensaje', esc(String(data.message ?? ''))]);
    const html = wrap(`
<h2 style="${F_SYNE};font-size:24px;font-weight:800;color:${C_DARK};margin:0 0 12px"><span style="color:${C_ORANGE}">Sesión expirada</span></h2>
<p style="${F_BODY};font-size:15px;color:${C_MID};margin:0 0 16px">${badge('ACCIÓN', '#ffedd5', C_ORANGE)} &nbsp;La sesión expiró y el re-login automático falló.</p>
${card(kvTable(kvRows))}
<p style="${F_BODY};font-size:15px;color:${C_MID};margin-top:20px">El bot reintentará login automáticamente. Si persiste, reactiva con <code style="${F_BODY};font-size:13px">POST /api/bots/:id/activate</code>.</p>`);
    return { subject, html };
  }

  if (event === 'bot_error') {
    const subject = 'Bot en error — reintentará en 30min';
    const html = wrap(`
<h2 style="${F_SYNE};font-size:24px;font-weight:800;color:${C_DARK};margin:0 0 12px"><span style="color:${C_RED}">Bot en error</span></h2>
<p style="${F_BODY};font-size:15px;color:${C_MID};margin:0 0 16px">${badge('ERROR', '#fee2e2', C_RED)} &nbsp;El bot alcanzó 5 errores consecutivos de sesión/lógica.</p>
${card(kvTable([
  ['Razón', esc(String(data.message ?? ''))],
  ['Último error', `<code style="${F_BODY};font-size:13px">${esc(String(data.lastError ?? ''))}</code>`],
]))}
<p style="${F_BODY};font-size:15px;color:${C_MID};margin-top:20px">Auto-recovery cada 30 min. Errores TCP/5xx no cuentan — solo sesión/lógica. Si persiste, reactiva con <code style="${F_BODY};font-size:13px">POST /api/bots/:id/activate</code>.</p>`);
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

    const fmtTimes = (times: string[], max: number, color: string, prefix: string) => {
      if (times.length === 0) return '';
      const show = times.slice(0, max);
      const extra = times.length > max ? ` <span style="${F_BODY};font-size:11px;color:${color};font-weight:600">+${times.length - max} mas</span>` : '';
      return show.map((t) => `<span style="${F_BODY};font-size:11px;color:${color};font-weight:600">${esc(prefix + t)}</span>`).join(' ') + extra;
    };

    const confBadge = (c: { confidence?: string }) => {
      if (c.confidence === 'low') return ` ${badge('?', '#ffedd5', C_ORANGE)}`;
      if (c.confidence === 'error') return ` ${badge('ERR', '#fee2e2', C_RED)}`;
      return '';
    };

    const tdCas = `${F_BODY};font-size:14px;color:${C_DARK};padding:8px 10px;border:1px solid ${C_BORDER};vertical-align:top`;

    const changeRow = (c: typeof changes[number]) => {
      const day = dayName(c.date);
      const added = c.addedTimes || [];
      const removed = c.removedTimes || [];
      const timeDiffRow = (added.length > 0 || removed.length > 0)
        ? `<tr><td colspan="4" style="${F_BODY};font-size:11px;color:${C_MID};padding:4px 10px 8px 24px;border:1px solid ${C_BORDER};border-top:none">${fmtTimes(added, 8, '#16a34a', '+')} ${fmtTimes(removed, 8, C_RED, '-')}</td></tr>`
        : '';

      if (c.type === 'appeared') {
        const from = c.oldSlots === -1 ? 'nuevo' : c.oldSlots === 0 ? 'FULL' : `${c.oldSlots}`;
        return `<tr><td style="${tdCas}">${fmtDate(c.date)}</td><td style="${tdCas}">${esc(day)}</td><td style="${tdCas}">${badge('APARECIO', '#dcfce7', '#16a34a')}${confBadge(c)}</td><td style="${tdCas}">${esc(from)} &rarr; <b style="color:#16a34a">${c.newSlots}</b></td></tr>${timeDiffRow}`;
      }
      if (c.type === 'went_full') {
        return `<tr><td style="${tdCas}">${fmtDate(c.date)}</td><td style="${tdCas}">${esc(day)}</td><td style="${tdCas}">${badge('FULL', '#fee2e2', C_RED)}${confBadge(c)}</td><td style="${tdCas}">${c.oldSlots} &rarr; <b style="color:${C_RED}">0</b></td></tr>${timeDiffRow}`;
      }
      if (c.type === 'slots_changed') {
        const slotColor = c.newSlots > c.oldSlots ? '#16a34a' : C_ORANGE;
        return `<tr><td style="${tdCas}">${fmtDate(c.date)}</td><td style="${tdCas}">${esc(day)}</td><td style="${tdCas}">${badge('CAMBIO', '#dbeafe', '#1e40af')}${confBadge(c)}</td><td style="${tdCas}">${c.oldSlots} &rarr; <b style="color:${slotColor}">${c.newSlots}</b></td></tr>${timeDiffRow}`;
      }
      // disappeared
      return `<tr><td style="${tdCas}">${fmtDate(c.date)}</td><td style="${tdCas}">${esc(day)}</td><td style="${tdCas}">${badge('DESAPARECIO', C_BG, C_MID)}${confBadge(c)}</td><td style="${tdCas}">${c.oldSlots} &rarr; <span style="color:${C_MID}">-</span></td></tr>${timeDiffRow}`;
    };

    const rows = changes.map(changeRow).join('');
    const total = data.totalDates as number;
    const full = data.fullDates as number;

    const reliabilityWarning = reliability && !reliability.reliable
      ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:10px 14px;margin-bottom:12px;${F_BODY};font-size:13px;color:#92400e"><b>Confiabilidad baja</b> &mdash; ${reliability.failedCalls}/${reliability.totalApiCalls} llamadas fallaron (${Math.round((reliability.failureRate ?? 0) * 100)}%). Algunos cambios pueden ser falsos positivos.</div>`
      : '';

    const ths = ['Fecha', 'Dia', 'Cambio', 'Slots'].map(h =>
      `<th style="${F_BODY};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:${C_MID};background:${C_BG};padding:8px 10px;border:1px solid ${C_BORDER};text-align:left">${h}</th>`
    ).join('');
    const table = `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;margin:12px 0"><tr>${ths}</tr>${rows}</table>`;

    const html = wrap(`
<h2 style="${F_SYNE};font-size:24px;font-weight:800;color:${C_DARK};margin:0 0 12px">CAS slots cambiaron</h2>
${reliabilityWarning}
${card(kvTable([
  ['Cambios detectados', String(changes.length)],
  ['Total fechas', String(total)],
  ['FULL', `<span style="color:${full > 0 ? C_RED : '#0d9488'};font-weight:600">${full}</span>`],
]))}
${appeared.length > 0 ? `<p style="${F_BODY};font-size:15px;color:${C_MID}"><span style="color:#0d9488">&#x25B2;</span> <strong style="color:${C_DARK}">${appeared.length} fecha(s)</strong> con slots nuevos — posibles cancelaciones.</p>` : ''}
${wentFull.length > 0 ? `<p style="${F_BODY};font-size:15px;color:${C_MID}"><span style="color:${C_RED}">&#x25BC;</span> <strong style="color:${C_DARK}">${wentFull.length} fecha(s)</strong> se llenaron.</p>` : ''}
${disappeared.length > 0 ? `<p style="${F_BODY};font-size:15px;color:${C_MID}">${disappeared.length} fecha(s) desaparecieron del rango CAS.</p>` : ''}
${slotsChanged.length > 0 ? `<p style="${F_BODY};font-size:15px;color:${C_MID}"><strong style="color:${C_DARK}">${slotsChanged.length} fecha(s)</strong> cambiaron slots.</p>` : ''}
${table}
<p style="${F_BODY};font-size:15px;color:${C_MID};margin-top:20px">Próxima verificación en ~30 min.</p>`);
    return { subject, html };
  }

  if (event === 'cas_prefetch_complete') {
    const total = data.totalDates as number;
    const full = data.fullDates as number;
    const low = data.lowDates as number;
    const available = total - full;
    const filling = !!data.casFillingUp;
    const isFirst = !!data.isFirstRun;

    const statusBadge = full === 0
      ? badge('OK', '#dcfce7', '#16a34a')
      : full > total / 2
        ? badge(filling ? 'LLENANDOSE' : `${full} FULL`, '#fee2e2', C_RED)
        : badge(filling ? 'LLENANDOSE' : `${full} FULL`, '#ffedd5', C_ORANGE);
    const subject = filling
      ? `CAS llenandose — ${full} fechas FULL`
      : isFirst
        ? `CAS Cache activado — ${available}/${total} disponibles`
        : `CAS Cache — ${available}/${total} disponibles`;

    const dangerEntries = (data.dangerEntries as Array<{ date: string; slots: number; times: string[] }>) || [];
    const tdPre = `${F_BODY};font-size:14px;color:${C_DARK};padding:8px 10px;border:1px solid ${C_BORDER};vertical-align:top`;
    const dangerRows = dangerEntries.map((e) => {
      const d = new Date(e.date + 'T12:00:00');
      const dayLabel = d.toLocaleDateString('es-CO', { weekday: 'short' });
      const slotColor = e.slots === 0 ? `color:${C_RED};font-weight:700` : `color:${C_ORANGE}`;
      const slotsText = e.slots === 0 ? 'FULL' : `${e.slots} slots`;
      const timeRange = e.times.length > 0 ? `${e.times[0]} - ${e.times[e.times.length - 1]}` : '-';
      return `<tr><td style="${tdPre}">${fmtDate(e.date)}</td><td style="${tdPre}">${esc(dayLabel)}</td><td style="${tdPre};${slotColor}">${slotsText}</td><td style="${tdPre};color:${C_MID}">${esc(timeRange)}</td></tr>`;
    }).join('');

    const dangerTable = dangerEntries.length > 0
      ? `<p style="${F_SYNE};font-size:14px;font-weight:700;color:${C_DARK};margin:16px 0 8px">Fechas en peligro</p>
${dataTable(['Fecha', 'Dia', 'Slots', 'Rango'], [dangerRows])}`
      : '';

    const html = wrap(`
<h2 style="${F_SYNE};font-size:24px;font-weight:800;color:${C_DARK};margin:0 0 12px">CAS Cache${isFirst ? ' activado' : ''}</h2>
<p style="${F_BODY};font-size:15px;color:${C_MID};margin:0 0 16px">${statusBadge}${isFirst ? ` &nbsp;${badge('PRIMERA VEZ', '#dbeafe', '#1e40af')}` : ''}${filling ? ` &nbsp;<span style="${F_BODY};font-size:14px;color:${C_MID}">Fechas con slots ahora FULL.</span>` : ''}</p>
${card(kvTable([
  ['Disponibles', `<span style="color:#0d9488;font-weight:600">${available}/${total}</span>`],
  ['FULL (0 slots)', `<span style="${full > 0 ? `color:${C_RED};font-weight:600` : `color:${C_MID}`}">${full}</span>`],
  ['Bajas (1–10 slots)', `<span style="${low > 0 ? `color:${C_ORANGE};font-weight:600` : `color:${C_MID}`}">${low}</span>`],
  ['Duración', `<span style="color:${C_MID}">${data.durationMs ?? '?'}ms</span>`],
]))}
${dangerTable}
<p style="${F_BODY};font-size:15px;color:${C_MID};margin-top:20px">Próxima actualización en ~30 min.</p>`);
    return { subject, html };
  }

  if (event === 'cas_prefetch_failed') {
    const ageMin = data.cacheAgeMin as number;
    const reason = data.reason as string;
    const subject = `CAS Cache stale (${ageMin}min)`;
    const html = wrap(`
<h2 style="${F_SYNE};font-size:24px;font-weight:800;color:${C_DARK};margin:0 0 12px"><span style="color:${C_ORANGE}">CAS Cache stale</span> — ${ageMin} min</h2>
<p style="${F_BODY};font-size:15px;color:${C_MID};margin:0 0 16px">${badge('CACHE STALE', '#ffedd5', C_ORANGE)} &nbsp;El cron no ha podido actualizar el cache en ${ageMin} minutos.</p>
${card(kvTable([
  ['Edad del cache', `<span style="color:${C_ORANGE};font-weight:600">${ageMin} min</span>`],
  ['Razón', `<code style="${F_BODY};font-size:13px">${esc(reason)}</code>`],
  ['Frecuencia cron', `<span style="color:${C_MID}">cada 30 min</span>`],
]))}
<p style="${F_BODY};font-size:15px;color:${C_MID};margin-top:20px">Posibles causas: sesión expirada, sitio caído, rate limit desde cloud. Alerta máx. 1x/hora.</p>`);
    return { subject, html };
  }

  if (event === 'bot_paused') {
    const subject = `Bot #${data.botId} pausado — ${data.reason ?? 'manual'}`;
    const kvRows: Array<[string, string]> = [
      ['Bot ID', `#${data.botId}`],
      ['Razón', esc(String(data.reason ?? 'manual'))],
    ];
    if (data.scheduleId) kvRows.push(['Schedule', esc(String(data.scheduleId))]);
    if (data.locale) kvRows.push(['País', esc(String(data.locale))]);
    const html = wrap(`
<h2 style="${F_SYNE};font-size:24px;font-weight:800;color:${C_DARK};margin:0 0 12px"><span style="color:${C_ORANGE}">Bot pausado</span></h2>
<p style="${F_BODY};font-size:15px;color:${C_MID};margin:0 0 16px">${badge('PAUSADO', '#ffedd5', C_ORANGE)} &nbsp;El bot dejó de monitorear.</p>
${card(kvTable(kvRows))}
<p style="${F_BODY};font-size:15px;color:${C_MID};margin-top:20px">Reactiva con <code style="${F_BODY};font-size:13px">POST /api/bots/${data.botId}/activate</code> o desde el dashboard.</p>`);
    return { subject, html };
  }

  if (event === 'account_locked') {
    const subject = 'Cuenta bloqueada — reintentos pausados ~1h';
    const html = wrap(`
<h2 style="${F_SYNE};font-size:24px;font-weight:800;color:${C_DARK};margin:0 0 12px"><span style="color:${C_RED}">Cuenta bloqueada</span></h2>
<p style="${F_BODY};font-size:15px;color:${C_MID};margin:0 0 16px">${badge('AUTO-RETRY', '#fef3c7', '#92400e')} &nbsp;${esc(String(data.message ?? ''))}</p>
<p style="${F_BODY};font-size:15px;color:${C_MID};margin-top:20px">El lockout dura ~1h. El cron reintentará automáticamente.</p>`);
    return { subject, html };
  }

  if (event === 'invalid_credentials') {
    const subject = 'Credenciales inválidas — bot detenido';
    const html = wrap(`
<h2 style="${F_SYNE};font-size:24px;font-weight:800;color:${C_DARK};margin:0 0 12px"><span style="color:${C_RED}">Credenciales inválidas</span></h2>
<p style="${F_BODY};font-size:15px;color:${C_MID};margin:0 0 16px">${badge('ACCIÓN', '#fee2e2', C_RED)} &nbsp;${esc(String(data.message ?? ''))}</p>
<p style="${F_BODY};font-size:15px;color:${C_MID};margin-top:20px">Actualiza las credenciales y reactiva con <code style="${F_BODY};font-size:13px">POST /api/bots/:id/activate</code>.</p>`);
    return { subject, html };
  }

  // Generic fallback
  const subject = `Visa bot: ${event}`;
  const html = wrap(`
<h2 style="${F_SYNE};font-size:24px;font-weight:800;color:${C_DARK};margin:0 0 12px">${esc(subject)}</h2>
${card(`<pre style="${F_BODY};font-size:13px;color:${C_MID};white-space:pre-wrap;word-break:break-all;margin:0">${esc(JSON.stringify(data, null, 2))}</pre>`)}`);
  return { subject, html };
}

// Events sent to notificationEmail (dev/admin) — operational noise excluded
const NOTIFICATION_EMAIL_EVENTS = new Set(['reschedule_success', 'reschedule_failed', 'bot_paused']);

// Always receives reschedule_success regardless of bot owner
const ADMIN_RESCHEDULE_EMAIL = process.env.ADMIN_RESCHEDULE_EMAIL;

export async function notifyUser(
  bot: { id: number; notificationEmail: string | null; ownerEmail?: string | null; webhookUrl: string | null },
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  const payload = { event, data, timestamp: new Date().toISOString() };

  const promises: Promise<void>[] = [];

  if (bot.notificationEmail && NOTIFICATION_EMAIL_EVENTS.has(event)) {
    const { subject, html } = buildEmail(event, data);
    promises.push(sendEmail(bot.id, event, bot.notificationEmail, subject, html));
  }

  // Owner only gets reschedule_success — no operational spam
  if (bot.ownerEmail && event === 'reschedule_success') {
    const { subject, html } = buildEmail(event, data);
    promises.push(sendEmail(bot.id, event, bot.ownerEmail, subject, html));
  }

  // Admin always gets reschedule_success, deduplicated
  if (ADMIN_RESCHEDULE_EMAIL && event === 'reschedule_success') {
    const alreadySent = [bot.notificationEmail, bot.ownerEmail].includes(ADMIN_RESCHEDULE_EMAIL);
    if (!alreadySent) {
      const { subject, html } = buildEmail(event, data);
      promises.push(sendEmail(bot.id, event, ADMIN_RESCHEDULE_EMAIL, subject, html));
    }
  }

  if (bot.webhookUrl) {
    promises.push(sendWebhook(bot.id, event, bot.webhookUrl, payload));
  }

  if (!(bot.notificationEmail && NOTIFICATION_EMAIL_EVENTS.has(event)) && !(bot.ownerEmail && event === 'reschedule_success') && !bot.webhookUrl) {
    console.log(`[notify] no recipients configured bot=${bot.id} event=${event} — skipping`);
  }

  await Promise.allSettled(promises);
}

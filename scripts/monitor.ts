/**
 * Live poll monitor — responsive ASCII dashboard with live countdown.
 *
 * Uses a screen buffer to update clock & countdown every 1s
 * without cursor positioning issues. Full repaint every 30s or on resize.
 *
 * Usage:
 *   npm run monitor                    # bot 6, refresh every 30s
 *   npm run monitor -- --bot-id=6      # specific bot
 *   npm run monitor -- --interval=10   # full refresh interval
 *   npm run monitor -- --rows=50       # max poll rows
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots, sessions, pollLogs, rescheduleLogs, casPrefetchLogs, type CasCacheData, type CasCacheEntry } from '../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { toBogotaDate } from '../src/utils/date-helpers.js';
import { getCurrentPhase } from '../src/services/scheduling.js';
import * as readline from 'readline';

const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const a = args.find((a) => a.startsWith(`--${name}=`));
  return a ? a.split('=')[1]! : def;
};
const botId = parseInt(getArg('bot-id', '6'), 10);
const intervalSec = parseInt(getArg('interval', '30'), 10);
const maxRowsArg = parseInt(getArg('rows', '50'), 10);

// ── Terminal ────────────────────────────────────────────
const tw = () => process.stdout.columns || 80;
const th = () => process.stdout.rows || 24;

// ── Colors ──────────────────────────────────────────────
const RST = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const WHITE = '\x1b[37m';
const BG_GREEN = '\x1b[42m';
const BG_RED = '\x1b[41m';
const BG_YELLOW = '\x1b[43m';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ── Helpers ─────────────────────────────────────────────

function toBogota(d: Date): string {
  return d.toLocaleString('en-US', {
    timeZone: 'America/Bogota', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}
function toBogotaShort(d: Date): string {
  return d.toLocaleString('en-US', {
    timeZone: 'America/Bogota',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}
function padLeft(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s;
}
function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function statusBadge(status: string): string {
  if (status === 'ok') return `${GREEN}  ok  ${RST}`;
  if (status === 'no_dates') return `${YELLOW}no_dat${RST}`;
  if (status === 'soft_ban') return `${BG_YELLOW}${BOLD}S.BAN ${RST}`;
  if (status === 'tcp_blocked') return `${BG_RED}${BOLD}TCP BL${RST}`;
  if (status === 'error') return `${RED} err  ${RST}`;
  return pad(status, 6);
}

function rescheduleBadge(result: string | null): string {
  if (!result) return '';
  switch (result) {
    case 'success': return ` ${GREEN}✓ reagendado${RST}`;
    case 'no_cas_days': return ` ${YELLOW}⚠ sin CAS${RST}`;
    case 'no_times': return ` ${YELLOW}⚠ sin horarios${RST}`;
    case 'no_cas_times': return ` ${YELLOW}⚠ sin hora CAS${RST}`;
    case 'post_failed': case 'post_error': return ` ${RED}✗ POST falló${RST}`;
    case 'stale_data': return ` ${DIM}⚠ ya cambiada${RST}`;
    case 'fetch_error': return ` ${RED}✗ fetch err${RST}`;
    default: return ` ${DIM}⚠ ${result}${RST}`;
  }
}

function casSlotBadge(slots: number): string {
  if (slots === -1) return `${RED} ERR ${RST}`;
  if (slots === 0) return `${BG_RED}${BOLD} FULL${RST}`;
  if (slots <= 5) return `${RED}${BOLD}${padLeft(String(slots), 4)}${RST}`;
  if (slots <= 10) return `${YELLOW}${padLeft(String(slots), 4)}${RST}`;
  return `${GREEN}${padLeft(String(slots), 4)}${RST}`;
}

function dayOfWeek(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'][d.getDay()]!;
}

type ViewType = 'polls' | 'cas' | 'experiments';
const VIEW_ORDER: ViewType[] = ['polls', 'cas', 'experiments'];

function buildTabBar(active: ViewType, I: string): string {
  const tab = (name: string, key: ViewType) =>
    active === key ? `${BG_GREEN}${BOLD} ${name} ${RST}` : `${DIM} ${name} ${RST}`;
  return `${I}${tab('Polls', 'polls')}  ${tab('CAS Cache', 'cas')}  ${tab('Experiment', 'experiments')}  ${DIM}(TAB to switch)${RST}`;
}

function daysUntil(dateStr: string): number {
  return Math.round((new Date(dateStr + 'T00:00:00').getTime() - Date.now()) / 86400000);
}

function formatDateDiff(dateStr: string | null, currentDate: string | null): string {
  if (!dateStr) return `${DIM}--${RST}`;
  if (!currentDate) return dateStr;
  const diff = Math.round((new Date(currentDate).getTime() - new Date(dateStr).getTime()) / 86400000);
  const diffStr = diff > 0 ? `(-${diff}d)` : diff === 0 ? '(=)' : `(+${Math.abs(diff)}d)`;
  if (diff > 0) return `${GREEN}${BOLD}${dateStr} ${diffStr}${RST}`;
  if (diff === 0) return `${YELLOW}${dateStr} ${diffStr}${RST}`;
  return `${DIM}${dateStr} ${diffStr}${RST}`;
}

/** Flush screen buffer — rewrite all lines from cursor home, clearing each. */
function flushBuffer() {
  process.stdout.write('\x1b[H' + screenBuffer.map(l => `\x1b[2K${l}`).join('\n') + '\n');
}

/** Update only specific lines using ANSI cursor positioning (no flicker). */
function updateLines(...indices: number[]) {
  let out = '';
  for (const i of indices) {
    if (i >= 0 && i < screenBuffer.length) {
      out += `\x1b[${i + 1};1H\x1b[2K${screenBuffer[i]}`;
    }
  }
  if (out) process.stdout.write(out);
}

// ── State ────────────────────────────────────────────────
let lastPollMs = 0;
let intervalInfo = getCurrentPhase();
let state: 'countdown' | 'executing' | 'result' = 'countdown';
let execStartMs = 0;
let resultAt = 0;

// Screen buffer — avoids line-position issues from wrapped unicode lines
let screenBuffer: string[] = [];
let clockBufIdx = 1;
let countdownBufIdx = 0;
let cachedW = 80;

let currentView: ViewType = 'polls';

let busy = false;

// ── Full render ──────────────────────────────────────────
async function render() {
  if (currentView === 'cas') return renderCasView();
  if (currentView === 'experiments') return renderExperimentsView();
  return renderPollsView();
}

async function renderSharedHeader(bot: any, session: any, W: number): Promise<string[]> {
  const I = '  ';
  const out: string[] = [];

  const sessionAgeMin = session ? Math.round((Date.now() - session.createdAt.getTime()) / 60000) : 0;
  const sessionColor = sessionAgeMin > 80 ? RED : sessionAgeMin > 50 ? YELLOW : GREEN;
  const currentDaysUntil = bot.currentConsularDate ? daysUntil(bot.currentConsularDate) : null;

  // Header box
  const boxW = Math.max(30, W - 3);
  out.push(`${BOLD}${CYAN}╔${'═'.repeat(boxW)}╗${RST}`);
  out.push(buildClockLine(boxW));
  out.push(`${BOLD}${CYAN}╚${'═'.repeat(boxW)}╝${RST}`);
  out.push('');

  // Status bar
  const stColor = bot.status === 'active' ? GREEN : bot.status === 'error' ? RED : YELLOW;
  const errColor = bot.consecutiveErrors > 0 ? RED : DIM;
  if (W >= 80) {
    out.push(`${I}${BOLD}Status${RST}  ${stColor}${BOLD}${bot.status.toUpperCase()}${RST}    ${BOLD}Provider${RST}  ${bot.proxyProvider}    ${BOLD}Session${RST}  ${sessionColor}${sessionAgeMin}min${RST}    ${BOLD}Errors${RST}  ${errColor}${bot.consecutiveErrors}${RST}`);
  } else {
    out.push(`${I}${stColor}${BOLD}${bot.status.toUpperCase()}${RST}  ${DIM}${bot.proxyProvider}${RST}  ${BOLD}Ses${RST} ${sessionColor}${sessionAgeMin}m${RST}  ${BOLD}Err${RST} ${errColor}${bot.consecutiveErrors}${RST}`);
  }
  out.push('');

  // Appointment
  out.push(`${I}${BOLD}Cita actual${RST}`);
  out.push(`${I}  Consular  ${CYAN}${bot.currentConsularDate ?? '?'} ${bot.currentConsularTime ?? '?'}${RST}  ${DIM}(${currentDaysUntil !== null ? currentDaysUntil + 'd' : '?'})${RST}`);
  out.push(`${I}  CAS       ${CYAN}${bot.currentCasDate ?? '?'} ${bot.currentCasTime ?? '?'}${RST}`);
  out.push('');

  // Tab bar
  out.push(buildTabBar(currentView, I));
  out.push('');

  return out;
}

async function renderPollsView() {
  const W = tw();
  const H = th();
  cachedW = W;
  const I = '  ';
  const G = '  ';

  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) { console.error(`Bot ${botId} not found`); process.exit(1); }
  const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));
  const allPolls = await db.select().from(pollLogs).where(eq(pollLogs.botId, botId))
    .orderBy(desc(pollLogs.createdAt)).limit(maxRowsArg);
  const reschedules = await db.select().from(rescheduleLogs).where(eq(rescheduleLogs.botId, botId))
    .orderBy(desc(rescheduleLogs.createdAt)).limit(5);

  // Detect TCP backoff: count recent consecutive tcp_blocked/error(5xx) polls
  let tcpBackoffCount = 0;
  for (const p of allPolls) {
    if (p.status === 'tcp_blocked') { tcpBackoffCount++; }
    else { break; }
  }

  lastPollMs = allPolls[0]?.createdAt.getTime() ?? 0;
  intervalInfo = getCurrentPhase();

  const out = await renderSharedHeader(bot, session, W);

  // TCP backoff banner
  if (tcpBackoffCount > 0) {
    const backoffMin = Math.min(tcpBackoffCount * 5, 30);
    out.push(`${I}${BG_RED}${BOLD} TCP BACKOFF ${RST}  ${RED}Sitio caido — ${tcpBackoffCount} polls fallidos${RST}  ${DIM}Reintentando cada ${backoffMin}min (auto-recovery)${RST}`);
    out.push('');
  }

  const fixedLines = out.length + 6 + 2 + 1 + 1;
  const rescheduleLines = reschedules.length > 0 ? (2 + reschedules.length + 1) : 0;
  const pollRowLimit = Math.max(3, H - fixedLines - rescheduleLines);
  const polls = allPolls.slice(0, pollRowLimit);

  const okPolls = polls.filter(p => p.status === 'ok');
  const noDatesPolls = polls.filter(p => p.status === 'no_dates');
  const errorPolls = polls.filter(p => p.status === 'error');
  const avgMs = okPolls.length > 0
    ? Math.round(okPolls.reduce((s, p) => s + (p.responseTimeMs ?? 0), 0) / okPolls.length) : 0;

  const showLatency = W >= 75;
  const showDates = W >= 60;

  const COL_TIME = 8;
  const COL_STATUS = 6;
  const COL_DATES = 6;
  const COL_LATENCY = 8;
  let usedW = 2 + COL_TIME + 2 + COL_STATUS + 2;
  if (showDates) usedW += COL_DATES + 2;
  if (showLatency) usedW += 2 + COL_LATENCY;
  const colBest = Math.min(28, Math.max(14, W - usedW));

  const sep = `${I}${DIM}${'─'.repeat(Math.max(20, Math.min(W - 4, usedW + colBest - 2)))}${RST}`;

  // Top 3 dates (latest poll)
  const latestWithDates = polls.find(p => p.topDates && (p.topDates as string[]).length > 0);
  const topDates = latestWithDates ? (latestWithDates.topDates as string[]).slice(0, 3) : [];
  if (topDates.length > 0) {
    out.push(`${I}${BOLD}Top 3 fechas${RST}  ${DIM}@ ${toBogotaShort(latestWithDates!.createdAt)}${RST}`);
    for (let i = 0; i < topDates.length; i++) {
      const d = topDates[i]!;
      const diff = bot.currentConsularDate
        ? Math.round((new Date(bot.currentConsularDate).getTime() - new Date(d).getTime()) / 86400000)
        : null;
      const wouldReschedule = diff !== null && diff >= 1;
      const diffStr = diff !== null ? (diff > 0 ? `(-${diff}d)` : diff === 0 ? '(=)' : `(+${Math.abs(diff)}d)`) : '';
      const color = wouldReschedule ? GREEN + BOLD : diff === 0 ? YELLOW : DIM;
      const arrow = wouldReschedule ? `${BG_GREEN}${BOLD} REAGENDAR ${RST}` : '';
      out.push(`${I}  ${DIM}${i + 1}.${RST} ${color}${d} ${diffStr}${RST} ${arrow}`);
    }
  } else {
    out.push(`${I}${BOLD}Top 3 fechas${RST}  ${DIM}sin datos en ultimos ${polls.length} polls${RST}`);
  }
  out.push('');

  // Stats
  out.push(`${I}${BOLD}Stats${RST} ${DIM}(${polls.length})${RST}  ${GREEN}ok:${okPolls.length}${RST}  ${YELLOW}no_dates:${noDatesPolls.length}${RST}  ${RED}err:${errorPolls.length}${RST}  ${DIM}avg:${avgMs}ms${RST}`);

  // Next poll
  const nextPollIdx = out.length;
  out.push(buildCountdownLine());
  out.push('');

  // Poll table
  let hdr = `${I}${BOLD}${WHITE}${pad('Hora', COL_TIME)}${G}${pad('Status', COL_STATUS)}`;
  if (showDates) hdr += `${G}${padLeft('Fechas', COL_DATES)}`;
  hdr += `${G}${pad('Mejor fecha', colBest)}`;
  if (showLatency) hdr += `${G}${padLeft('Latencia', COL_LATENCY)}`;
  hdr += RST;
  out.push(hdr);
  out.push(sep);

  for (const p of polls) {
    const time = pad(toBogotaShort(p.createdAt), COL_TIME);
    const badge = statusBadge(p.status);
    const earliest = formatDateDiff(p.earliestDate, bot.currentConsularDate);
    const resBadge = rescheduleBadge(p.rescheduleResult);
    const plainLen = strip(earliest).length + strip(resBadge).length;
    const bestPad = Math.max(0, colBest - plainLen);

    let row = `${I}${DIM}${time}${RST}${G}${badge}`;
    if (showDates) row += `${G}${padLeft(String(p.datesCount ?? 0), COL_DATES)}`;
    row += `${G}${earliest}${resBadge}${' '.repeat(bestPad)}`;
    if (showLatency) {
      const ms = padLeft(p.responseTimeMs ? `${p.responseTimeMs}ms` : '--', COL_LATENCY);
      const lc = (p.responseTimeMs ?? 0) > 5000 ? RED : (p.responseTimeMs ?? 0) > 2000 ? YELLOW : DIM;
      row += `${G}${lc}${ms}${RST}`;
    }
    out.push(row);
  }
  if (polls.length === 0) out.push(`${I}${DIM}  No polls yet${RST}`);
  out.push('');

  // Reschedules
  if (reschedules.length > 0) {
    out.push(`${I}${BOLD}${MAGENTA}Reschedules${RST} ${DIM}(ultimos ${reschedules.length})${RST}`);
    out.push(sep);
    for (const r of reschedules) {
      const time = toBogota(r.createdAt);
      const ok = r.success;
      const badge = ok ? `${BG_GREEN}${BOLD} OK ${RST}` : `${BG_RED}${BOLD}FAIL${RST}`;
      out.push(`${I}${DIM}${time}${RST}  ${badge}  ${DIM}${r.oldConsularDate}→${RST}${ok ? GREEN + BOLD : RED}${r.newConsularDate} ${r.newConsularTime}${RST}`);
    }
    out.push('');
  }

  out.push(`${I}${DIM}Ctrl+C to exit  TAB=switch view  ${W}×${H}${RST}`);

  screenBuffer = out;
  clockBufIdx = 1;
  countdownBufIdx = nextPollIdx;
  state = 'countdown';

  process.stdout.write('\x1b[?25l\x1b[2J');
  flushBuffer();
}

async function renderCasView() {
  const W = tw();
  const H = th();
  cachedW = W;
  const I = '  ';
  const G = '  ';

  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) { console.error(`Bot ${botId} not found`); process.exit(1); }
  const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));

  const out = await renderSharedHeader(bot, session, W);

  const cache = bot.casCacheJson as CasCacheData | null;

  if (!cache || !cache.entries || cache.entries.length === 0) {
    out.push(`${I}${BOLD}CAS Cache${RST}  ${DIM}sin datos — prefetch-cas no ha corrido${RST}`);
    out.push('');
    out.push(`${I}${DIM}Ctrl+C to exit  TAB=switch view  ${W}×${H}${RST}`);

    screenBuffer = out;
    clockBufIdx = 1;
    countdownBufIdx = -1;
    process.stdout.write('\x1b[?25l\x1b[2J');
    flushBuffer();
    return;
  }

  // Cache summary
  const refreshedAt = new Date(cache.refreshedAt);
  const ageMin = Math.round((Date.now() - refreshedAt.getTime()) / 60000);
  const ageColor = ageMin > 60 ? RED : ageMin > 30 ? YELLOW : GREEN;
  const okEntries = cache.entries.filter(e => e.slots > 0);
  const fullEntries = cache.entries.filter(e => e.slots === 0);
  const lowEntries = cache.entries.filter(e => e.slots > 0 && e.slots <= 10);
  const errEntries = cache.entries.filter(e => e.slots === -1);

  out.push(`${I}${BOLD}CAS Cache${RST}  ${DIM}refreshed${RST} ${ageColor}${ageMin}m ago${RST}  ${DIM}@ ${toBogota(refreshedAt)}${RST}`);
  out.push(`${I}  ${GREEN}ok:${okEntries.length}${RST}  ${YELLOW}low:${lowEntries.length}${RST}  ${RED}full:${fullEntries.length}${RST}  ${DIM}err:${errEntries.length}${RST}  ${DIM}total:${cache.totalDates}${RST}  ${DIM}window:${cache.windowDays}d${RST}`);
  out.push('');

  // Prefetch log history
  const prefetchLogs = await db.select().from(casPrefetchLogs).where(eq(casPrefetchLogs.botId, botId))
    .orderBy(desc(casPrefetchLogs.createdAt)).limit(3);
  if (prefetchLogs.length > 0) {
    out.push(`${I}${BOLD}Prefetch history${RST}`);
    for (const log of prefetchLogs) {
      const time = toBogota(log.createdAt);
      const dur = `${(log.durationMs / 1000).toFixed(1)}s`;
      const errStr = log.error ? `  ${RED}${log.error}${RST}` : '';
      out.push(`${I}  ${DIM}${time}${RST}  ${log.totalDates} dates  ${RED}${log.fullDates} full${RST}  ${YELLOW}${log.lowDates} low${RST}  ${DIM}${log.requestCount} req  ${dur}${RST}${errStr}`);
    }
    out.push('');
  }

  // CAS date table
  const showTimes = W >= 90;
  const sep = `${I}${DIM}${'─'.repeat(Math.max(20, W - 4))}${RST}`;

  let hdr = `${I}${BOLD}${WHITE}${pad('Fecha', 12)}${G}${pad('Dia', 3)}${G}${pad('Slots', 5)}${G}${pad('Status', 6)}`;
  if (showTimes) hdr += `${G}Horarios`;
  hdr += RST;
  out.push(hdr);
  out.push(sep);

  const maxRows = Math.max(3, H - out.length - 2);
  const entries = cache.entries.slice(0, maxRows);

  for (const e of entries) {
    const dow = dayOfWeek(e.date);
    const dowColor = dow === 'Sab' ? MAGENTA : '';
    const badge = casSlotBadge(e.slots);
    const statusTxt = e.slots === -1 ? `${RED} ERR ${RST}`
      : e.slots === 0 ? `${BG_RED}${BOLD} FULL ${RST}`
      : e.slots <= 5 ? `${RED}${BOLD} LOW  ${RST}`
      : e.slots <= 10 ? `${YELLOW} low  ${RST}`
      : `${GREEN}  ok  ${RST}`;

    let row = `${I}${DIM}${pad(e.date, 12)}${RST}${G}${dowColor}${pad(dow, 3)}${RST}${G}${badge} ${G}${statusTxt}`;
    if (showTimes && e.times.length > 0) {
      const maxTimesToShow = Math.max(1, Math.floor((W - 45) / 6));
      const timesStr = e.times.slice(0, maxTimesToShow).join(' ');
      const more = e.times.length > maxTimesToShow ? ` ${DIM}+${e.times.length - maxTimesToShow}${RST}` : '';
      row += `${G}${DIM}${timesStr}${RST}${more}`;
    }
    out.push(row);
  }

  if (entries.length < cache.entries.length) {
    out.push(`${I}${DIM}  ... ${cache.entries.length - entries.length} more dates${RST}`);
  }
  out.push('');

  out.push(`${I}${DIM}Ctrl+C to exit  TAB=switch view  ${W}×${H}${RST}`);

  screenBuffer = out;
  clockBufIdx = 1;
  countdownBufIdx = -1; // No countdown in CAS view
  state = 'countdown';

  process.stdout.write('\x1b[?25l\x1b[2J');
  flushBuffer();
}

// ── Experiments view ─────────────────────────────────────
const BG_MAGENTA = '\x1b[45m';
const BG_CYAN = '\x1b[46m';
const BLUE = '\x1b[34m';

async function renderExperimentsView() {
  const W = tw();
  const H = th();
  cachedW = W;
  const I = '  ';
  const G = '  ';

  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) { console.error(`Bot ${botId} not found`); process.exit(1); }
  const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));

  const out = await renderSharedHeader(bot, session, W);

  // Load probe logs (both sources, interleaved by time)
  const probeRows = await db.select().from(pollLogs)
    .where(eq(pollLogs.botId, botId))
    .orderBy(desc(pollLogs.createdAt))
    .limit(200);

  const probes = probeRows.filter(p => p.pollPhase?.startsWith('probe-'));
  const cloudProbes = probes.filter(p => p.pollPhase === 'probe-cloud');
  const localProbes = probes.filter(p => p.pollPhase === 'probe-local');

  // Experiment runtime
  const firstProbe = probes.length > 0 ? probes[probes.length - 1]! : null;
  const lastProbe = probes.length > 0 ? probes[0]! : null;
  const elapsedMs = firstProbe && lastProbe ? lastProbe.createdAt.getTime() - firstProbe.createdAt.getTime() : 0;
  const elapsedH = (elapsedMs / 3600000).toFixed(1);
  const totalBudget = 300; // req per 5h
  const reqPer5h = elapsedMs > 0 ? Math.round(probes.length / (elapsedMs / (5 * 3600000))) : 0;

  // Experiment banner
  const isRunning = lastProbe && (Date.now() - lastProbe.createdAt.getTime()) < 5 * 60000;
  const statusTag = isRunning
    ? `${BG_CYAN}${BOLD} RUNNING ${RST}`
    : probes.length > 0
      ? `${BG_YELLOW}${BOLD} STOPPED ${RST}`
      : `${DIM} NOT STARTED ${RST}`;

  const sep = `${I}${DIM}${'─'.repeat(Math.max(20, W - 4))}${RST}`;

  out.push(`${I}${MAGENTA}${BOLD}▓▓${RST} ${BOLD}PROBE-DATES EXPERIMENT${RST}  ${statusTag}  ${DIM}resolución 1min${RST}`);
  out.push(`${I}${DIM}Mide duración real de cancelaciones cercanas (<60d) con 2 crons intercalados${RST}`);
  out.push('');

  // Stats row
  const cloudOk = cloudProbes.filter(p => p.status === 'ok').length;
  const localOk = localProbes.filter(p => p.status === 'ok').length;
  const cloudErr = cloudProbes.length - cloudOk;
  const localErr = localProbes.length - localOk;
  const budgetColor = reqPer5h > totalBudget ? RED : reqPer5h > 250 ? YELLOW : GREEN;

  out.push(`${I}${BOLD}Runtime${RST} ${CYAN}${elapsedH}h${RST}  ${BOLD}Total${RST} ${probes.length}  ${BOLD}Budget${RST} ${budgetColor}${reqPer5h}/${totalBudget} req/5h${RST}`);
  out.push(`${I}  ${CYAN}☁ Cloud${RST}  ${GREEN}${cloudOk} ok${RST}  ${cloudErr > 0 ? `${RED}${cloudErr} err${RST}` : `${DIM}0 err${RST}`}    ${MAGENTA}⌂ Local${RST}  ${GREEN}${localOk} ok${RST}  ${localErr > 0 ? `${RED}${localErr} err${RST}` : `${DIM}0 err${RST}`}`);
  out.push('');

  // Flash dates analysis — dates that appeared and then disappeared
  // Build a timeline of all dates across all probes
  const dateTimeline = new Map<string, { firstSeen: Date, lastSeen: Date, sightings: number }>();
  // Process probes in chronological order (oldest first)
  for (let i = probes.length - 1; i >= 0; i--) {
    const p = probes[i]!;
    const allDates = p.allDates as Array<{date: string, business_day: boolean}> | null;
    if (!allDates) continue;
    for (const d of allDates) {
      const entry = dateTimeline.get(d.date);
      if (!entry) {
        dateTimeline.set(d.date, { firstSeen: p.createdAt, lastSeen: p.createdAt, sightings: 1 });
      } else {
        entry.lastSeen = p.createdAt;
        entry.sightings++;
      }
    }
  }

  // Flash = appeared and disappeared (not in latest probe), duration = lastSeen - firstSeen
  const latestDates = new Set(
    (lastProbe?.allDates as Array<{date: string, business_day: boolean}> | null)?.map(d => d.date) ?? []
  );

  // Also include dates that are still present but have been seen intermittently
  const flashDates: Array<{ date: string, firstSeen: Date, lastSeen: Date, durationMin: number, sightings: number, gone: boolean, daysUntilDate: number }> = [];

  const now = new Date();
  for (const [date, info] of dateTimeline) {
    const daysUntilDate = Math.round((new Date(date + 'T00:00:00').getTime() - now.getTime()) / 86400000);
    if (daysUntilDate > 60) continue; // Only interested in close dates
    const gone = !latestDates.has(date);
    const durationMin = Math.round((info.lastSeen.getTime() - info.firstSeen.getTime()) / 60000);
    flashDates.push({ date, firstSeen: info.firstSeen, lastSeen: info.lastSeen, durationMin, sightings: info.sightings, gone, daysUntilDate });
  }

  // Sort: gone dates first (most interesting), then by duration ascending
  flashDates.sort((a, b) => {
    if (a.gone !== b.gone) return a.gone ? -1 : 1;
    return a.durationMin - b.durationMin;
  });

  const flashGone = flashDates.filter(f => f.gone);
  const flashPresent = flashDates.filter(f => !f.gone);

  out.push(`${I}${MAGENTA}${BOLD}▓▓${RST} ${BOLD}FLASH DATES${RST}  ${DIM}(<60d, appeared then gone)${RST}  ${YELLOW}${flashGone.length} gone${RST}  ${GREEN}${flashPresent.length} still present${RST}`);
  out.push(sep);

  if (flashGone.length > 0) {
    const showCount = Math.min(flashGone.length, Math.max(5, Math.floor((H - out.length - 20) / 2)));
    let hdr = `${I}${BOLD}${WHITE}${pad('Fecha', 12)}${G}${pad('D-day', 5)}${G}${pad('Duración', 10)}${G}${pad('Visto', 5)}${G}${pad('Primera vez', 10)}${G}Última vez${RST}`;
    out.push(hdr);
    for (let i = 0; i < showCount; i++) {
      const f = flashGone[i]!;
      const durStr = f.durationMin < 60
        ? `${f.durationMin}min`
        : `${(f.durationMin / 60).toFixed(1)}h`;
      const durColor = f.durationMin <= 2 ? RED + BOLD : f.durationMin <= 5 ? YELLOW : GREEN;
      const dayColor = f.daysUntilDate <= 7 ? RED + BOLD : f.daysUntilDate <= 30 ? YELLOW : DIM;
      out.push(`${I}${RED}${pad(f.date, 12)}${RST}${G}${dayColor}${padLeft(String(f.daysUntilDate) + 'd', 5)}${RST}${G}${durColor}${pad(durStr, 10)}${RST}${G}${padLeft(String(f.sightings) + '×', 5)}${G}${DIM}${pad(toBogotaShort(f.firstSeen), 10)}${RST}${G}${DIM}${toBogotaShort(f.lastSeen)}${RST}`);
    }
    if (flashGone.length > showCount) {
      out.push(`${I}${DIM}  ... ${flashGone.length - showCount} more${RST}`);
    }
  } else if (probes.length > 0) {
    out.push(`${I}${DIM}  No flash dates detected yet — waiting for cancellations...${RST}`);
  } else {
    out.push(`${I}${DIM}  Experiment not started${RST}`);
  }
  out.push('');

  // Interleaved probe timeline (recent)
  const timelineLimit = Math.max(5, H - out.length - 4);
  const timeline = probes.slice(0, timelineLimit);

  out.push(`${I}${MAGENTA}${BOLD}▓▓${RST} ${BOLD}PROBE TIMELINE${RST}  ${DIM}(latest ${timeline.length} of ${probes.length})${RST}`);
  out.push(sep);

  const showChanges = W >= 70;
  let thdr = `${I}${BOLD}${WHITE}${pad('Hora', 8)}${G}${pad('Source', 6)}${G}${pad('Status', 6)}${G}${padLeft('Dates', 5)}`;
  if (showChanges) thdr += `${G}Changes`;
  thdr += RST;
  out.push(thdr);

  for (const p of timeline) {
    const time = toBogotaShort(p.createdAt);
    const isCloud = p.pollPhase === 'probe-cloud';
    const srcTag = isCloud ? `${CYAN}☁ clou${RST}` : `${MAGENTA}⌂ locl${RST}`;
    const badge = statusBadge(p.status);
    const dc = p.dateChanges as { appeared: string[], disappeared: string[] } | null;

    let row = `${I}${DIM}${pad(time, 8)}${RST}${G}${srcTag}${G}${badge}${G}${padLeft(String(p.datesCount ?? 0), 5)}`;

    if (showChanges && dc) {
      const parts: string[] = [];
      if (dc.appeared.length > 0) {
        const close = dc.appeared.filter(d => daysUntil(d) <= 60);
        if (close.length > 0) {
          parts.push(`${GREEN}+${close.length} (${close.slice(0, 2).join(', ')}${close.length > 2 ? '...' : ''})${RST}`);
        } else if (dc.appeared.length > 0) {
          parts.push(`${DIM}+${dc.appeared.length}${RST}`);
        }
      }
      if (dc.disappeared.length > 0) {
        const close = dc.disappeared.filter(d => daysUntil(d) <= 60);
        if (close.length > 0) {
          parts.push(`${RED}-${close.length} (${close.slice(0, 2).join(', ')}${close.length > 2 ? '...' : ''})${RST}`);
        } else if (dc.disappeared.length > 0) {
          parts.push(`${DIM}-${dc.disappeared.length}${RST}`);
        }
      }
      if (parts.length > 0) row += `${G}${parts.join(' ')}`;
    }

    out.push(row);
  }

  if (timeline.length === 0) out.push(`${I}${DIM}  No probe data yet${RST}`);
  out.push('');

  out.push(`${I}${DIM}Ctrl+C to exit  TAB=switch view  ${W}×${H}${RST}`);

  screenBuffer = out;
  clockBufIdx = 1;
  countdownBufIdx = -1;
  state = 'countdown';

  process.stdout.write('\x1b[?25l\x1b[2J');
  flushBuffer();
}

// ── Line builders ────────────────────────────────────────
function buildClockLine(boxW?: number): string {
  const bw = boxW ?? Math.max(30, cachedW - 3);
  const txt = `  ${BOLD}VISA BOT MONITOR${RST}  ${DIM}Bot #${botId}${RST}  ${DIM}│${RST}  ${toBogota(new Date())} Bogota  ${DIM}│${RST}  ${DIM}Every ${intervalSec}s${RST}`;
  const pLen = strip(txt).length;
  const hPad = Math.max(0, bw - pLen);
  return `${BOLD}${CYAN}║${RST}${txt}${' '.repeat(hPad)}${BOLD}${CYAN}║${RST}`;
}

function buildCountdownLine(): string {
  const I = '  ';
  if (lastPollMs === 0) {
    return `${I}${BOLD}Proximo poll${RST}  ${DIM}sin datos${RST}  ${DIM}cada ${intervalInfo.label} [${intervalInfo.phase}]${RST}`;
  }
  const nextRunMs = lastPollMs + intervalInfo.seconds * 1000;
  const now = Date.now();
  const nextRun = new Date(Math.max(nextRunMs, now));
  const secsUntil = Math.max(0, Math.round((nextRunMs - now) / 1000));
  const cdColor = secsUntil <= 10 ? GREEN : secsUntil <= 60 ? YELLOW : DIM;
  const cd = secsUntil >= 60 ? `${Math.floor(secsUntil / 60)}m ${(secsUntil % 60).toString().padStart(2, '0')}s` : `${secsUntil}s`;

  if (cachedW >= 80) {
    return `${I}${BOLD}Proximo poll${RST}  ~${toBogotaShort(nextRun)} Bogota  ${cdColor}(en ${cd})${RST}  ${DIM}cada ${intervalInfo.label} [${intervalInfo.phase}]${RST}`;
  }
  return `${I}${BOLD}Proximo${RST} ~${toBogotaShort(nextRun)}  ${cdColor}(${cd})${RST}  ${DIM}${intervalInfo.label} [${intervalInfo.phase}]${RST}`;
}

function buildExecutingLine(elapsedS: number): string {
  const I = '  ';
  const spin = SPINNER[elapsedS % SPINNER.length];
  return `${I}${BOLD}Ejecutando${RST}   ${CYAN}${spin} Consultando...${RST}  ${DIM}cada ${intervalInfo.label} [${intervalInfo.phase}]${RST}`;
}

// ── Tick (1s) — updates clock + countdown via screen buffer ──
async function tick() {
  if (busy) return;
  busy = true;
  try {
    // Update clock in buffer (both views)
    screenBuffer[clockBufIdx] = buildClockLine();

    // CAS view: only update clock
    if (countdownBufIdx <= 0) {
      updateLines(clockBufIdx);
      return;
    }

    const now = Date.now();

    if (state === 'countdown') {
      const nextRunMs = lastPollMs > 0 ? lastPollMs + intervalInfo.seconds * 1000 : 0;
      const secsUntil = lastPollMs > 0 ? Math.max(0, Math.round((nextRunMs - now) / 1000)) : -1;

      if (secsUntil === 0) {
        state = 'executing';
        execStartMs = now;
        screenBuffer[countdownBufIdx] = buildExecutingLine(0);
      } else {
        screenBuffer[countdownBufIdx] = buildCountdownLine();
      }
    } else if (state === 'executing') {
      const elapsedS = Math.floor((now - execStartMs) / 1000);
      screenBuffer[countdownBufIdx] = buildExecutingLine(elapsedS);

      // Check DB for new poll every 2s
      if (elapsedS > 0 && elapsedS % 2 === 0) {
        const [newest] = await db.select({
          createdAt: pollLogs.createdAt,
          status: pollLogs.status,
          datesCount: pollLogs.datesCount,
          earliestDate: pollLogs.earliestDate,
          responseTimeMs: pollLogs.responseTimeMs,
        }).from(pollLogs).where(eq(pollLogs.botId, botId))
          .orderBy(desc(pollLogs.createdAt)).limit(1);

        if (newest && newest.createdAt.getTime() > lastPollMs) {
          state = 'result';
          resultAt = now;
          lastPollMs = newest.createdAt.getTime();
          const ok = newest.status === 'ok';
          const stC = ok ? GREEN : RED;
          const sym = ok ? '✓' : '✗';
          const dateInfo = newest.earliestDate ?? 'sin fechas';
          const I = '  ';
          screenBuffer[countdownBufIdx] =
            `${I}${stC}${BOLD}${sym} ${newest.status}${RST}  ${newest.datesCount ?? 0} fechas  ${dateInfo}  ${DIM}${newest.responseTimeMs}ms${RST}`;
        }
      }

      if (elapsedS > 60) {
        state = 'countdown';
        await render();
        return;
      }
    } else if (state === 'result') {
      if (now - resultAt > 3000) {
        state = 'countdown';
        await render();
        return;
      }
    }

    updateLines(clockBufIdx, countdownBufIdx);
  } catch {
    // Swallow tick errors
  } finally {
    busy = false;
  }
}

// ── Main ─────────────────────────────────────────────────
async function safeRender() {
  if (busy) return;
  busy = true;
  try { await render(); } catch { /* swallow */ }
  busy = false;
}

async function main() {
  // Enable raw mode for keypress detection
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', (_str, key) => {
      if (key.ctrl && key.name === 'c') { cleanup(); return; }
      if (key.name === 'tab') {
        const idx = VIEW_ORDER.indexOf(currentView);
        currentView = VIEW_ORDER[(idx + 1) % VIEW_ORDER.length]!;
        safeRender();
      }
    });
    process.stdin.resume();
  }

  await render();
  setInterval(tick, 1000);
  setInterval(safeRender, intervalSec * 1000);
  process.stdout.on('resize', () => { safeRender(); });
}

function cleanup() {
  process.stdout.write('\x1b[?25h\n');
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

main().catch((e) => { console.error(e); process.exit(1); });

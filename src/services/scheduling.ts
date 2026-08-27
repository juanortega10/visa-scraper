/** Default polling interval (20s = 3 polls/min).
 * Lowered from 9s (6.67/min) to 3/min fleet-wide (2026-07-06) to reduce ban/cost surface;
 * es-pe keeps its own 6s override below. Per-bot faster rates set via targetPollsPerMin.
 * Response: 791ms direct, 1608ms webshare. Start-to-start timing subtracts elapsed. */
export const DEFAULT_POLL_INTERVAL_S = 20;

/** Per-locale override for the normal polling interval. */
const LOCALE_POLL_INTERVALS: Record<string, number> = {
  'es-pe': 6, // test: 10 polls/min (was 9s ~6.7/min) — monitoring TCP blocks for 1h
};

export function getNormalInterval(locale?: string, override?: number): number {
  if (override != null && override > 0) return override;
  return LOCALE_POLL_INTERVALS[locale ?? ''] ?? DEFAULT_POLL_INTERVAL_S;
}

/**
 * Resolves the effective poll interval seconds, giving priority to:
 * 1. targetPollsPerMin (raw conversion: 60/rate)
 * 2. pollIntervalSeconds (direct override)
 * 3. locale default (DEFAULT_POLL_INTERVAL_S)
 */
export function getEffectiveInterval(locale?: string, pollIntervalSeconds?: number | null, targetPollsPerMin?: number | null): number {
  if (targetPollsPerMin != null && targetPollsPerMin > 0) return Math.max(2, Math.round(60 / targetPollsPerMin));
  return getNormalInterval(locale, pollIntervalSeconds ?? undefined);
}

// ── Drop schedule per locale ──────────────────────────────────

export interface DropSchedule {
  day: number;       // 0=Sun, 1=Mon, 2=Tue, 3=Wed...
  hour: number;      // Local hour of the drop
  minute: number;    // Usually 0
  timezone: string;  // IANA timezone
}

const DROP_SCHEDULES: Record<string, DropSchedule> = {
  'es-co': { day: 2, hour: 9, minute: 0, timezone: 'America/Bogota' },
  'es-pe': { day: 3, hour: 12, minute: 0, timezone: 'America/Lima' },
};
const DEFAULT_DROP: DropSchedule = { day: 2, hour: 9, minute: 0, timezone: 'America/Bogota' };

export function getDropSchedule(locale?: string): DropSchedule {
  return DROP_SCHEDULES[locale ?? 'es-co'] ?? DEFAULT_DROP;
}

/** Get current time in the locale's drop timezone as a Date. */
function toLocalDate(timezone: string, date: Date = new Date()): Date {
  return new Date(date.toLocaleString('en-US', { timeZone: timezone }));
}

/** Minutes since midnight in the locale's timezone. */
function localMinutes(timezone: string): { day: number; t: number } {
  const d = toLocalDate(timezone);
  const day = d.getDay();
  const t = d.getHours() * 60 + d.getMinutes();
  return { day, t };
}

/** Returns true during the super-critical window (drop - 2min → drop + 8min). */
export function isInSuperCriticalWindow(locale?: string): boolean {
  const drop = getDropSchedule(locale);
  const { day, t } = localMinutes(drop.timezone);
  if (day !== drop.day) return false;
  const dropMin = drop.hour * 60 + drop.minute;
  const rel = t - dropMin;
  return rel >= -2 && rel < 8;
}

/**
 * Resolves the self-trigger delay between runs (start-to-start timing).
 * override: effective interval in seconds (from getEffectiveInterval or bot.pollIntervalSeconds).
 * elapsedMs: time already spent in this run (subtracted to keep uniform spacing).
 * Falls back to LOCALE_POLL_INTERVALS lookup → DEFAULT_POLL_INTERVAL_S.
 */
export function getPollingDelay(locale?: string, override?: number, elapsedMs?: number): string {
  const base = (override != null && override > 0) ? override
    : (LOCALE_POLL_INTERVALS[locale ?? ''] ?? DEFAULT_POLL_INTERVAL_S);
  // Subtract elapsed time to achieve start-to-start interval (min 1s to avoid hammering)
  const adjustedSeconds = elapsedMs != null
    ? Math.max(1, base - elapsedMs / 1000)
    : base;
  return jitter(adjustedSeconds);
}

/** Adds ±5% jitter to a base delay in seconds, returns Trigger.dev delay string. */
function jitter(baseSeconds: number): string {
  const factor = 0.95 + Math.random() * 0.1; // 0.95–1.05
  const seconds = Math.round(baseSeconds * factor);
  return `${seconds}s`;
}


// ── Ventana de liberacion del portal ─────────────────────────────────────────

/** Tramo del minuto donde el portal libera cupos, en segundos [inicio, fin). */
export interface ReleaseWindow { startSec: number; endSec: number }

/**
 * Medido con `scripts/analyze-release-clock.ts` el 2026-08-27, contando SOLO
 * fechas a menos de 6 meses y normalizando por cuantos polls caen en cada tramo.
 *
 *   es-pe  cercanas: s15-19 al 6,2% (5,15x la media), s20-24 al 3,2%.
 *          Fuera de s15-24 la tasa cae a 0,1-0,5%.
 *   es-co  cercanas: meseta s20-34, pico s25-29 al 23,8% (2,74x).
 *
 * Se agrega ~2 s de margen por delante, porque la deteccion llega despues de la
 * liberacion real (el poll tarda en pedir y en responder).
 */
const RELEASE_WINDOWS: Record<string, ReleaseWindow> = {
  'es-pe': { startSec: 13, endSec: 26 },
  'es-co': { startSec: 18, endSec: 36 },
};

export function getReleaseWindow(locale?: string): ReleaseWindow | null {
  return RELEASE_WINDOWS[locale ?? ''] ?? null;
}

/**
 * Corre el proximo poll para que caiga DENTRO de la ventana de liberacion.
 *
 * Si el poll natural ya cae dentro, no toca nada. Si cae fuera, salta al inicio
 * de la proxima ventana. El efecto es concentrar los polls donde de verdad
 * aparecen cupos, en vez de repartirlos parejo por todo el minuto.
 *
 * Perder el tramo muerto cuesta poco: la duracion mediana de un cupo es ~2 min,
 * entonces una fecha que aparece en s40 sigue ahi en la ventana siguiente.
 *
 * Devuelve segundos de espera. Nunca menos de 1 s.
 */
export function alignToReleaseWindow(args: {
  locale?: string;
  baseSeconds: number;
  nowMs: number;
}): { seconds: number; aligned: boolean } {
  const w = getReleaseWindow(args.locale);
  const base = Math.max(1, args.baseSeconds);
  if (!w) return { seconds: base, aligned: false };

  const naturalMs = args.nowMs + base * 1000;
  const sec = Math.floor(naturalMs / 1000) % 60;
  if (sec >= w.startSec && sec < w.endSec) return { seconds: base, aligned: false };

  const minuteStart = Math.floor(naturalMs / 60_000) * 60_000;
  let targetMs = minuteStart + w.startSec * 1000;
  if (targetMs < naturalMs) targetMs += 60_000;
  const seconds = Math.max(1, (targetMs - args.nowMs) / 1000);
  return { seconds, aligned: true };
}

/**
 * Account-level ban backoff — SINGLE SOURCE OF TRUTH.
 *
 * An account ban lasts 6h+ and rotating the proxy IP does NOT help (the ban is on
 * the account, not the IP), so webshare and direct share ONE aggressive curve.
 * Keyed on `count` = consecutive account_ban polls in the last 5 poll_logs
 * (saturates at 5 under a sustained ban).
 *
 * Imported by BOTH poll-visa.ts (picks the self-trigger delay) and ensure-chain.ts
 * (gates whether the guardian may resurrect a dead chain). They MUST agree, so any
 * tier edit happens HERE only — never inline in a caller.
 *
 * Curve: pure "2x" doubling from a 30m base — 30m → 60m → 120m → 240m → 480m (cap).
 * `count` saturates at 5 (the last-5 poll_logs window), so 480m (8h) is the natural
 * ceiling. Starts at 30m (not the old 10m, which just kept the ban warm) so a transient
 * misclassified as a ban recovers fast; only a fully-confirmed sustained ban reaches 480m.
 *
 * The bot is NEVER paused for a sustained ban — it holds at the 480m cap and keeps
 * probing every ~8h forever, so a lifted ban recovers automatically (the next `ok`
 * poll returns to normal cadence) with NO manual reactivation. Wasted work on a dead
 * account is bounded to ~3 probes/day, the price of hands-off self-healing.
 */
export function accountBanBackoffMs(count: number): number {
  const step = Math.min(Math.max(count, 1), 5) - 1; // 0..4
  return 30 * 60_000 * 2 ** step; // 30m,60m,120m,240m,480m
}


/** Fila reciente de `poll_logs`, reducida a lo que necesita el contador de rachas. */
export interface RecentBlockRow {
  status: string;
  blockCls: string | null;
}

/**
 * Cuenta los bloqueos de cuenta SEGUIDOS al frente de la ventana de `poll_logs`.
 *
 * Corta la racha cualquier fila que no sea un `tcp_blocked` de tipo `account_ban`.
 * Eso incluye una fila sana (`ok`/`filtered_out`), que trae `blockClassification`
 * en null. La version anterior usaba `blockCls !== null && blockCls !== 'account_ban'`,
 * entonces las filas sanas no cortaban nada: dos bloqueos con polls buenos en medio
 * contaban como cinco y el backoff saltaba de un golpe al tope de 480m.
 */
export function countSustainedAccountBans(rows: RecentBlockRow[]): number {
  const firstBreak = rows.findIndex(
    (r) => !(r.status === 'tcp_blocked' && r.blockCls === 'account_ban'),
  );
  return firstBreak === -1 ? rows.length : firstBreak;
}

/** Trigger.dev delay string form of {@link accountBanBackoffMs}. */
export function accountBanBackoffDelay(count: number): string {
  return `${Math.round(accountBanBackoffMs(count) / 60_000)}m`;
}

/**
 * Calculates priority offset in seconds based on user tenure.
 * Longer-active users get higher priority (dequeue sooner).
 * Max 3600s (1 hour ahead).
 */
export function calculatePriority(activatedAt: Date | null): number {
  if (!activatedAt) return 0;
  const daysActive = (Date.now() - activatedAt.getTime()) / (1000 * 60 * 60 * 24);
  return Math.min(Math.floor(daysActive * 60), 3600);
}

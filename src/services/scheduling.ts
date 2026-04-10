/** Default polling interval (7s).
 * 9s (0.135% ban-trigger) → 5s (0.578% ban-trigger, 4x increase after 3h A/B).
 * 7s = middle ground: ~7.5/min effective (+35% vs 9s) within safe 5-8/min bucket.
 * Response: 791ms direct, 1608ms webshare. Start-to-start timing subtracts elapsed. */
export const DEFAULT_POLL_INTERVAL_S = 9;

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

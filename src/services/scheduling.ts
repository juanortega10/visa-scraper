/** Default polling interval outside drop windows (2 min). */
export const DEFAULT_POLL_INTERVAL_S = 120;

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
function localMinutes(timezone: string): { day: number; t: number; secondsInDay: number } {
  const d = toLocalDate(timezone);
  const day = d.getDay();
  const t = d.getHours() * 60 + d.getMinutes();
  const secondsInDay = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  return { day, t, secondsInDay };
}

// ── Phase computation ──────────────────────────────────────────

/**
 * Budget-aware polling schedule anchored to the locale's drop time.
 *
 * Windows are relative to drop time (D):
 *   D - 4h  → D - 10m  : early (10 min interval)
 *   D - 10m → D - 2m   : pre-warm (30s)
 *   D - 2m  → D + 8m   : super-critical (1s, continuous loop)
 *   D + 8m  → D + 60m  : burst (10s)
 *   D + 60m → D + 2h   : tail (5 min)
 *   rest                : normal (2 min)
 *
 * All intervals include ±5% jitter except super-critical.
 */
export function getCurrentPhase(locale?: string): { seconds: number; label: string; phase: string } {
  const drop = getDropSchedule(locale);
  const { day, t } = localMinutes(drop.timezone);

  if (day === drop.day) {
    const dropMin = drop.hour * 60 + drop.minute;
    const rel = t - dropMin; // minutes relative to drop

    if (rel >= -2  && rel < 8)   return { seconds: 1,   label: '1s',  phase: 'super-critical' };
    if (rel >= 8   && rel < 60)  return { seconds: 10,  label: '10s', phase: 'burst' };
    if (rel >= -10 && rel < -2)  return { seconds: 30,  label: '30s', phase: 'pre-warm' };
    if (rel >= 60  && rel < 120) return { seconds: 300, label: '5m',  phase: 'tail' };
    if (rel >= -240 && rel < -10) return { seconds: 600, label: '10m', phase: 'early' };
  }

  return { seconds: DEFAULT_POLL_INTERVAL_S, label: '2m', phase: 'normal' };
}

export function getPollingDelay(locale?: string): string {
  const { seconds, phase } = getCurrentPhase(locale);
  if (phase === 'super-critical') return '1s';
  return jitter(seconds);
}

/** Adds ±5% jitter to a base delay in seconds, returns Trigger.dev delay string. */
function jitter(baseSeconds: number): string {
  const factor = 0.95 + Math.random() * 0.1; // 0.95–1.05
  const seconds = Math.round(baseSeconds * factor);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

/** Returns true during the burst window (drop - 2min → drop + 60min). */
export function isInBurstWindow(locale?: string): boolean {
  const drop = getDropSchedule(locale);
  const { day, t } = localMinutes(drop.timezone);
  if (day !== drop.day) return false;
  const dropMin = drop.hour * 60 + drop.minute;
  const rel = t - dropMin;
  return rel >= -2 && rel < 60;
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
 * Returns ms to wait until the exact drop second.
 * Active within 30s before the drop. Returns 0 outside the sniper window.
 */
export function getSniperWaitMs(locale?: string): number {
  const drop = getDropSchedule(locale);
  const { day, secondsInDay } = localMinutes(drop.timezone);
  if (day !== drop.day) return 0;
  const dropSeconds = drop.hour * 3600 + drop.minute * 60;
  if (secondsInDay >= dropSeconds - 30 && secondsInDay < dropSeconds) {
    return (dropSeconds - secondsInDay) * 1000;
  }
  return 0;
}

/**
 * Returns true during pre-drop warmup (drop - 4min → drop - 2min).
 * Forces a session refresh to guarantee fresh session for super-critical.
 */
export function isPreDropWarmup(locale?: string): boolean {
  const drop = getDropSchedule(locale);
  const { day, t } = localMinutes(drop.timezone);
  if (day !== drop.day) return false;
  const dropMin = drop.hour * 60 + drop.minute;
  const rel = t - dropMin;
  return rel >= -4 && rel < -2;
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

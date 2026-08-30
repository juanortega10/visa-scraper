import { MIN_DAYS_FROM_TODAY } from './constants.js';

export interface DateRange {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
}

export interface TimeRange {
  date: string | null; // null = applies to all dates
  timeStart: string;   // HH:MM
  timeEnd: string;     // HH:MM
}

export function isDateExcluded(date: string, exclusions: DateRange[]): boolean {
  return exclusions.some((ex) => date >= ex.startDate && date <= ex.endDate);
}

export function isTimeExcluded(
  date: string,
  time: string,
  exclusions: TimeRange[],
): boolean {
  return exclusions.some((ex) => {
    if (ex.date !== null && ex.date !== date) return false;
    return time >= ex.timeStart && time <= ex.timeEnd;
  });
}

/** Dia de la semana de un YYYY-MM-DD. 0 = domingo … 6 = sabado. Usa UTC para evitar el corrimiento por zona horaria. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** True si el dia de la semana de `date` esta en la lista de dias bloqueados del bot. */
export function isWeekdayExcluded(date: string, excludedWeekdays?: number[] | null): boolean {
  if (!excludedWeekdays || excludedWeekdays.length === 0) return false;
  return excludedWeekdays.includes(weekdayOf(date));
}

export function filterDates(
  dates: Array<{ date: string }>,
  excludedDates: DateRange[],
  targetDateBefore?: string | null,
  minDate?: string | null,
  targetDateAfter?: string | null,
  excludedWeekdays?: number[] | null,
): Array<{ date: string }> {
  return dates.filter((d) => {
    if (isDateExcluded(d.date, excludedDates)) return false;
    if (isWeekdayExcluded(d.date, excludedWeekdays)) return false;
    if (targetDateBefore && d.date >= targetDateBefore) return false;
    if (targetDateAfter && d.date < targetDateAfter) return false; // sniper window lower bound (inclusive)
    if (minDate && d.date < minDate) return false;
    return true;
  });
}

/** Adds n calendar days to a YYYY-MM-DD string. Uses UTC arithmetic to avoid DST issues. */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d! + n));
  return date.toISOString().split('T')[0]!;
}

export function filterTimes(
  date: string,
  times: string[],
  excludedTimes: TimeRange[],
): string[] {
  return times.filter((t) => !isTimeExcluded(date, t, excludedTimes));
}

export function isEarlierDate(candidate: string, current: string): boolean {
  return candidate < current;
}

/**
 * Returns true if the candidate date is at least `minDays` days earlier than the current date.
 * Both dates must be YYYY-MM-DD strings.
 */
export function isAtLeastNDaysEarlier(candidate: string, current: string, minDays: number): boolean {
  const candidateMs = new Date(candidate).getTime();
  const currentMs = new Date(current).getTime();
  const diffDays = (currentMs - candidateMs) / (1000 * 60 * 60 * 24);
  return diffDays >= minDays;
}

/** Should the bot act on `candidate`? Non-sniper: only if it's an initial booking (no current) or strictly >=1 day earlier than current. Sniper: the window check is applied separately by the caller, so sniper short-circuits to true here. */
export function isActionableDate(candidate: string | null | undefined, currentConsularDate: string | null | undefined, sniperMode: boolean): boolean {
  if (!candidate) return false;
  if (sniperMode) return true;
  if (currentConsularDate === null || currentConsularDate === undefined) return true;
  return isAtLeastNDaysEarlier(candidate, currentConsularDate, 1);
}

export function toBogotaDate(date: Date = new Date()): Date {
  return new Date(date.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
}

export function computeDaysImprovement(candidate: string, current: string | null | undefined): number | null {
  if (!current) return null;
  return Math.round((new Date(current).getTime() - new Date(candidate).getTime()) / 86_400_000);
}

/** Earliest bookable date = today (Bogota) + N days. N defaults to MIN_DAYS_FROM_TODAY when null/undefined. */
export function computeMinDate(minDaysFromToday?: number | null): string {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Bogota' });
  return addDays(today, minDaysFromToday ?? MIN_DAYS_FROM_TODAY);
}

/** Sniper mode is active only when explicitly enabled AND both window bounds are set. */
export function isSniperActive(
  sniperMode?: boolean | null,
  targetDateAfter?: string | null,
  targetDateBefore?: string | null,
): boolean {
  return !!sniperMode && !!targetDateAfter && !!targetDateBefore;
}

/** True if `date` falls inside the sniper window [targetDateAfter, targetDateBefore) — lower inclusive, upper exclusive. */
export function isWithinWindow(
  date: string | null | undefined,
  targetDateAfter?: string | null,
  targetDateBefore?: string | null,
): boolean {
  return !!date
    && (!targetDateAfter || date >= targetDateAfter)
    && (!targetDateBefore || date < targetDateBefore);
}

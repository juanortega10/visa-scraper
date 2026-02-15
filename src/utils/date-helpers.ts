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

export function filterDates(
  dates: Array<{ date: string }>,
  excludedDates: DateRange[],
  targetDateBefore?: string | null,
): Array<{ date: string }> {
  return dates.filter((d) => {
    if (isDateExcluded(d.date, excludedDates)) return false;
    if (targetDateBefore && d.date >= targetDateBefore) return false;
    return true;
  });
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

export function toBogotaDate(date: Date = new Date()): Date {
  return new Date(date.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
}

/**
 * Pure cross-poll date failure tracker.
 *
 * Owns the semantics of the persistent counter that lives at
 * `bots.casCacheJson.dateFailureTracking`. NO I/O, NO wall-clock reads —
 * caller injects `now: number` so unit tests run synchronously without
 * fake timers (Pitfall 9).
 *
 * Persistence and orchestration live in `poll-visa.ts`. The reschedule
 * loop produces deltas via `RescheduleResult.dateFailureTrackingDelta`.
 *
 * Locked decisions (see .planning/phases/01-cross-poll-failure-tracker-migration/01-CONTEXT.md):
 * - Threshold: 5 fails in a 1h sliding window → 2h block.
 * - Window restart drops `blockedUntil`. The poll-visa pruning step is
 *   responsible for keeping a still-blocked entry alive across window
 *   expiry; this pure module trusts whatever `entry` the caller passes.
 * - `blockedUntil` is set ONCE on threshold crossing and preserved on
 *   subsequent same-window calls (do not extend).
 */

import type { DateFailureEntry, FailureDimension } from '../db/schema.js';

export const CROSS_POLL_THRESHOLD = 5;
export const CROSS_POLL_BLOCK_MS = 2 * 60 * 60 * 1000; // 2h
export const CROSS_POLL_WINDOW_MS = 60 * 60 * 1000;    // 1h

/**
 * Increment a tracker entry. Pure: returns a new entry, never mutates input.
 *
 * - undefined entry OR window expired → fresh entry { totalCount: 1 }
 * - otherwise → totalCount + 1, byDimension[dimension] + 1
 * - if post-increment totalCount >= threshold AND no existing block → set blockedUntil
 * - if blockedUntil already set → preserve as-is (do NOT extend)
 */
export function recordFailure(
  entry: DateFailureEntry | undefined,
  dimension: FailureDimension,
  now: number,
): DateFailureEntry {
  const nowIso = new Date(now).toISOString();
  const windowExpired =
    !!entry && (now - new Date(entry.windowStartedAt).getTime()) > CROSS_POLL_WINDOW_MS;

  if (!entry || windowExpired) {
    return {
      windowStartedAt: nowIso,
      totalCount: 1,
      byDimension: { [dimension]: 1 },
      lastFailureAt: nowIso,
    };
  }

  const totalCount = entry.totalCount + 1;
  const byDimension: Partial<Record<FailureDimension, number>> = {
    ...entry.byDimension,
    [dimension]: (entry.byDimension[dimension] ?? 0) + 1,
  };

  const updated: DateFailureEntry = {
    windowStartedAt: entry.windowStartedAt,
    totalCount,
    byDimension,
    lastFailureAt: nowIso,
    ...(entry.blockedUntil ? { blockedUntil: entry.blockedUntil } : {}),
  };

  if (totalCount >= CROSS_POLL_THRESHOLD && !updated.blockedUntil) {
    updated.blockedUntil = new Date(now + CROSS_POLL_BLOCK_MS).toISOString();
  }

  return updated;
}

/** True iff entry has a `blockedUntil` strictly in the future. */
export function isBlocked(entry: DateFailureEntry | undefined, now: number): boolean {
  return !!entry?.blockedUntil && new Date(entry.blockedUntil).getTime() > now;
}

/**
 * Return a new tracking object containing only entries whose date is in
 * `currentDates`. Pure (no mutation). Used by poll-visa to drop dates that
 * disappeared from days.json — but NOTE: caller must NOT prune entries that
 * are actively blocked or whose window has not expired (per 01-CONTEXT.md
 * §Flapping date handling). This function is the raw set-intersection;
 * caller composes the policy.
 */
export function pruneDisappeared(
  tracking: Record<string, DateFailureEntry>,
  currentDates: Set<string>,
): Record<string, DateFailureEntry> {
  const out: Record<string, DateFailureEntry> = {};
  for (const [date, entry] of Object.entries(tracking)) {
    if (currentDates.has(date)) out[date] = entry;
  }
  return out;
}

/**
 * Drop the entry for a date that was just successfully booked. Mirrors the
 * old `updateDateCooldowns:1699` clear-on-success behavior, but scoped to
 * the single booked date (not the entire tracker).
 */
export function clearOnSuccess(
  tracking: Record<string, DateFailureEntry>,
  bookedDate: string,
): Record<string, DateFailureEntry> {
  if (!(bookedDate in tracking)) return tracking;
  const { [bookedDate]: _removed, ...rest } = tracking;
  return rest;
}

/**
 * Drop the entry for a consular date whose CAS just became available.
 * The escape hatch from Pitfall 4 — protects Core Value (never lose a
 * better bookable date because the tracker said "no").
 */
export function clearOnCasAvailable(
  tracking: Record<string, DateFailureEntry>,
  dateWithCas: string,
): Record<string, DateFailureEntry> {
  if (!(dateWithCas in tracking)) return tracking;
  const { [dateWithCas]: _removed, ...rest } = tracking;
  return rest;
}

// Re-export the dimension type for convenient single-import sites.
export type { FailureDimension };

/**
 * Poll-log write-reduction policy ("change + heartbeat").
 *
 * Steady-state polling writes one ~875-byte poll_logs row on every poll (~167K/day across
 * the fleet), which drove most of the Neon compute/storage bill. The vast majority are
 * boring "ok, nothing changed" rows. This module decides when a normal-path poll can skip
 * the INSERT without losing dashboard insight:
 *
 *   ALWAYS log: errors / soft_ban / tcp_blocked / session_expired, ban phases, date changes,
 *               reschedule attempts, relogin, and ALL super-critical/burst fetches.
 *   HEARTBEAT:  for boring 'ok'/'filtered_out' normal polls, keep at most one row per
 *               HEARTBEAT_MS per bot. This guarantees ≥1 row per 5-min uptime bucket and
 *               feeds the 30-min date-trend buckets, so uptime % and trends are unaffected.
 *
 * Trigger.dev runs are stateless, so "last logged" state lives in the DB: the caller passes
 * the createdAt of the bot's most recent poll_logs row (already read each run for rate/backoff).
 */

export const HEARTBEAT_MS = 5 * 60_000;

export interface HeartbeatInput {
  status: string;
  pollPhase?: string | null;
  rescheduleResult?: string | null;
  reloginHappened?: boolean | null;
  banPhase?: string | null;
  dateChanges?: { appeared?: string[]; disappeared?: string[] } | null;
}

/** A poll worth logging unconditionally (anything other than a quiet successful poll). */
export function isInterestingPoll(i: HeartbeatInput): boolean {
  if (i.status !== 'ok' && i.status !== 'filtered_out') return true; // error, soft_ban, tcp_blocked, session_expired...
  if (i.rescheduleResult) return true;
  if (i.reloginHappened) return true;
  if (i.banPhase) return true; // null = normal; 'trigger'/'sustained'/'recovery' = keep
  const dc = i.dateChanges;
  if (dc && ((dc.appeared?.length ?? 0) > 0 || (dc.disappeared?.length ?? 0) > 0)) return true;
  return false;
}

/**
 * True → skip the poll_logs INSERT for this poll.
 * Only normal-path boring polls within the heartbeat window are skipped; super-critical/burst
 * (pollPhase !== 'normal') and anything interesting always log.
 */
export function shouldSkipHeartbeatPoll(
  i: HeartbeatInput,
  lastLoggedAt: Date | null,
  nowMs: number,
): boolean {
  if (i.pollPhase !== 'normal') return false;
  if (isInterestingPoll(i)) return false;
  if (!lastLoggedAt) return false; // no prior row → always log the first one
  return nowMs - lastLoggedAt.getTime() < HEARTBEAT_MS;
}

/**
 * Mutable per-run heartbeat state, seeded from the DB each run (Trigger.dev runs are stateless).
 * `lastLoggedAt` is the time of the most recent written row; `skipped` is the count of quiet polls
 * skipped since that row (carried across runs via bots.skipped_polls_since_log). When a row is
 * written, polls_since_prev = 1 + skipped — an EXACT count (not a time estimate), so batch bursts
 * and idle gaps are both handled correctly.
 */
export interface HeartbeatState {
  lastLoggedAt: Date | null;
  skipped: number;
  /**
   * Ultima vez que MIRAMOS el portal, aunque no se haya escrito fila.
   *
   * `lastLoggedAt` no sirve para medir ceguera: en regimen normal se saltan
   * hasta el 94% de las filas, entonces usarlo diria que estuvimos ciegos
   * minutos cuando polleamos cada 6 segundos. Este campo se actualiza en cada
   * llamada a logPoll, se escriba o no. Se siembra con la ultima fila escrita,
   * que en un hueco largo de verdad ES el ultimo poll, porque un poll bloqueado
   * siempre escribe.
   */
  lastPolledAt: Date | null;
}

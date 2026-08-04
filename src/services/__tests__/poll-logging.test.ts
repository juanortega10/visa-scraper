import { describe, it, expect } from 'vitest';
import { isInterestingPoll, shouldSkipHeartbeatPoll, HEARTBEAT_MS } from '../poll-logging.js';

describe('isInterestingPoll', () => {
  it('quiet ok / filtered_out polls are not interesting', () => {
    expect(isInterestingPoll({ status: 'ok' })).toBe(false);
    expect(isInterestingPoll({ status: 'filtered_out' })).toBe(false);
  });

  it('any non-ok status is interesting (errors, bans)', () => {
    for (const status of ['error', 'soft_ban', 'tcp_blocked', 'session_expired']) {
      expect(isInterestingPoll({ status })).toBe(true);
    }
  });

  it('reschedule attempts, relogin, ban phases are interesting', () => {
    expect(isInterestingPoll({ status: 'ok', rescheduleResult: 'success' })).toBe(true);
    expect(isInterestingPoll({ status: 'ok', reloginHappened: true })).toBe(true);
    expect(isInterestingPoll({ status: 'ok', banPhase: 'recovery' })).toBe(true);
    expect(isInterestingPoll({ status: 'ok', banPhase: 'trigger' })).toBe(true);
  });

  it('date changes are interesting (the cancellation signal)', () => {
    expect(isInterestingPoll({ status: 'ok', dateChanges: { appeared: ['2026-08-01'] } })).toBe(true);
    expect(isInterestingPoll({ status: 'ok', dateChanges: { disappeared: ['2026-08-01'] } })).toBe(true);
    expect(isInterestingPoll({ status: 'ok', dateChanges: { appeared: [], disappeared: [] } })).toBe(false);
  });
});

describe('shouldSkipHeartbeatPoll', () => {
  const now = 1_000_000_000_000;

  it('skips a boring normal poll within the heartbeat window', () => {
    const last = new Date(now - 60_000); // 1 min ago
    expect(shouldSkipHeartbeatPoll({ status: 'ok', pollPhase: 'normal' }, last, now)).toBe(true);
  });

  it('logs a boring normal poll once the heartbeat window elapses', () => {
    const last = new Date(now - HEARTBEAT_MS - 1);
    expect(shouldSkipHeartbeatPoll({ status: 'ok', pollPhase: 'normal' }, last, now)).toBe(false);
  });

  it('never skips when there is no prior row', () => {
    expect(shouldSkipHeartbeatPoll({ status: 'ok', pollPhase: 'normal' }, null, now)).toBe(false);
  });

  it('never skips interesting polls even within the window', () => {
    const last = new Date(now - 10_000);
    expect(shouldSkipHeartbeatPoll({ status: 'error', pollPhase: 'normal' }, last, now)).toBe(false);
    expect(shouldSkipHeartbeatPoll(
      { status: 'ok', pollPhase: 'normal', dateChanges: { appeared: ['2026-08-01'] } }, last, now,
    )).toBe(false);
  });

  it('never skips super-critical / burst polls (only normal path is gated)', () => {
    const last = new Date(now - 1_000);
    expect(shouldSkipHeartbeatPoll({ status: 'ok', pollPhase: 'super-critical' }, last, now)).toBe(false);
    expect(shouldSkipHeartbeatPoll({ status: 'ok', pollPhase: undefined }, last, now)).toBe(false);
  });
});

// The skip/flush counter logic lives in logPoll (poll-visa.ts); here we model it against
// HeartbeatState to lock in the exact-count semantics that replace the old time estimate.
describe('heartbeat skip counter (polls_since_prev semantics)', () => {
  const now = 2_000_000_000_000;
  // Mirror of logPoll's heartbeat branch: returns the row's polls_since_prev, or null if skipped.
  function step(hb: { lastLoggedAt: Date | null; skipped: number }, input: any, atMs: number): number | null {
    if (shouldSkipHeartbeatPoll(input, hb.lastLoggedAt, atMs)) { hb.skipped++; return null; }
    const psp = 1 + hb.skipped;
    hb.skipped = 0;
    hb.lastLoggedAt = new Date(atMs);
    return psp;
  }

  it('a batch burst writes one row whose count = all real polls in it', () => {
    const hb = { lastLoggedAt: new Date(now - 6 * 60_000), skipped: 0 }; // last row 6min ago
    const ok = { status: 'ok', pollPhase: 'normal' };
    // fetch 1 (gap > heartbeat) writes psp=1; fetches 2..8 (9s apart) are skipped+counted
    expect(step(hb, ok, now)).toBe(1);
    for (let i = 1; i <= 7; i++) expect(step(hb, ok, now + i * 9_000)).toBeNull();
    expect(hb.skipped).toBe(7); // 7 skips carried for the next written row
  });

  it('carries skips across runs (cron 1-poll/run) — no poll lost', () => {
    // run A: one quiet poll, <5min since last row → skipped, carried out
    const carried = { lastLoggedAt: new Date(now - 2 * 60_000), skipped: 0 };
    expect(step(carried, { status: 'ok', pollPhase: 'normal' }, now)).toBeNull();
    expect(carried.skipped).toBe(1);
    // run B seeds skipped from the persisted value; next write flushes it
    const hb = { lastLoggedAt: new Date(now - 6 * 60_000), skipped: carried.skipped };
    expect(step(hb, { status: 'ok', pollPhase: 'normal' }, now)).toBe(2); // 1 self + 1 carried
  });

  it('an interesting poll flushes accumulated skips into its row', () => {
    const hb = { lastLoggedAt: new Date(now - 60_000), skipped: 4 };
    // a date change is interesting → not skipped → writes with psp = 1 + 4
    expect(step(hb, { status: 'ok', pollPhase: 'normal', dateChanges: { appeared: ['2026-09-01'] } }, now)).toBe(5);
  });
});

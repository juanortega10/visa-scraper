import { describe, it, expect, vi, beforeEach } from 'vitest';

// Rows the mocked db returns for the /billing query.
const { rowsRef } = vi.hoisted(() => ({ rowsRef: { current: [] as unknown[] } }));

vi.mock('../db/client.js', () => {
  function chain(rows: unknown[]) {
    const c: any = {};
    for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'offset', 'groupBy', 'innerJoin', 'leftJoin']) {
      c[m] = vi.fn(() => c);
    }
    c.then = (res: (v: unknown) => void, rej?: (e: unknown) => void) => Promise.resolve(rows).then(res, rej);
    c.catch = (fn: (e: unknown) => void) => Promise.resolve(rows).catch(fn);
    return c;
  }
  return {
    db: {
      select: vi.fn(() => chain(rowsRef.current)),
      execute: vi.fn(() => Promise.resolve({ rows: [] })),
    },
    withDbRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('@trigger.dev/sdk/v3', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let seq = 0;
function row(old: string, neu: string, opts: { success?: boolean; error?: string } = {}) {
  seq += 1;
  return {
    id: seq,
    createdAt: new Date(Date.UTC(2026, 7, 1, 0, seq)),
    oldConsularDate: old,
    newConsularDate: neu,
    success: opts.success ?? true,
    error: opts.error ?? '',
  };
}

async function getBilling(botId = 266) {
  const { logsRouter } = await import('./logs.js');
  const res = await logsRouter.request(`/bots/${botId}/billing`);
  return { status: res.status, body: await res.json() };
}

describe('GET /bots/:id/billing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seq = 0;
    rowsRef.current = [];
  });

  it('rejects a non-numeric bot id', async () => {
    const { logsRouter } = await import('./logs.js');
    const res = await logsRouter.request('/bots/abc/billing');
    expect(res.status).toBe(400);
  });

  it('returns an empty summary when the bot never rescheduled', async () => {
    const { status, body } = await getBilling();
    expect(status).toBe(200);
    expect(body.moves).toEqual([]);
    expect(body.billableDays).toBe(0);
    expect(body.netDays).toBe(0);
  });

  // The endpoint exists because the old cobros source (?successOnly=true) charged
  // this bot 205 days. 147 of them were the owner's own manual move.
  it('bot 266: bills 58 days, not the 205 the success flag implies', async () => {
    rowsRef.current = [
      row('2027-04-20', '2026-11-24', { error: '[post_error_recovered] fetch failed' }),
      row('2026-10-14', '2026-09-03', { error: '[best_available] attempt 1, #1/1' }),
      row('2026-09-03', '2026-08-21', { error: '[best_available] attempt 1, #1/1' }),
      row('2026-08-21', '2026-08-17', { error: '[best_available] attempt 1, #1/1' }),
    ];

    const { status, body } = await getBilling();
    expect(status).toBe(200);
    expect(body.billableDays).toBe(58);
    expect(body.suspectDays).toBe(147);
    expect(body.externalDays).toBe(41);
    expect(body.netDays).toBe(246);
    expect(body.botDays + body.externalDays).toBe(body.netDays);
  });

  it('marks each move so the UI can render it: billable, suspect or external', async () => {
    rowsRef.current = [
      row('2027-04-20', '2026-11-24', { error: '[post_error_recovered] fetch failed' }),
      row('2026-10-14', '2026-09-03', { error: '[best_available] attempt 1, #1/1' }),
    ];

    const { body } = await getBilling();
    const kinds = body.moves.map((m: any) => [m.actor, m.suspect, m.billable]);
    expect(kinds).toEqual([
      ['bot', true, false],       // recovered → shown, flagged, not chargeable
      ['external', false, false], // the chain break the owner produced
      ['bot', false, true],       // the one real bot move
    ]);
    // Every move carries the fields the cobros tab reads.
    for (const m of body.moves) {
      expect(m).toHaveProperty('from');
      expect(m).toHaveProperty('to');
      expect(typeof m.days).toBe('number');
      expect(typeof m.note).toBe('string');
    }
  });

  it('passes failed rows through so portal_reversion can cancel a move', async () => {
    rowsRef.current = [
      row('2026-12-01', '2026-10-01'),
      row('2026-10-01', '2026-12-01', { success: false, error: 'portal_reversion' }),
    ];

    const { body } = await getBilling();
    expect(body.moves).toEqual([]);
    expect(body.billableDays).toBe(0);
  });
});

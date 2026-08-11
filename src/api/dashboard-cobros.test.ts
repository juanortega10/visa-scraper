import { describe, it, expect, vi, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

// The dashboard ships its JS inside a template literal, so `tsc` never parses it.
// A typo there reaches the browser as a blank Cobros tab. These checks parse the
// emitted script for real and pin the contract it has with /bots/:id/billing.

// dashboard.ts reads these at module scope and throws without them.
vi.hoisted(() => {
  process.env.DASHBOARD_PASSWORD ||= 'test-password';
  process.env.COOKIE_SECRET ||= 'test-cookie-secret';
});

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })) },
  withDbRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@trigger.dev/sdk/v3', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let script = '';

beforeAll(async () => {
  const mod = await import('./dashboard.js');
  // The router is behind a cookie gate; without it we would parse the login page.
  const res = await (mod.dashboardRouter as any).request('/266', {
    headers: { cookie: `dashboard_auth=${mod.computeAuthToken()}` },
  });
  expect(res.status).toBe(200);
  const html: string = await res.text();
  expect(html).toContain('cobrosContent'); // the real dashboard, not the login page

  // Concatenate every inline script block on the page.
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  expect(blocks.length).toBeGreaterThan(0);
  script = blocks.join('\n;\n');
});

describe('dashboard inline script', () => {
  it('is syntactically valid JavaScript', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const file = join(dir, 'inline.js');
    writeFileSync(file, script);
    // node --check throws with the parse error attached if the script is malformed.
    expect(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })).not.toThrow();
  });

  it('defines the cobros entry points it wires up', () => {
    for (const fn of ['renderCobros', 'updateCobros', 'generateCobroMsg', 'saveCoboCfg']) {
      expect(script).toContain('function ' + fn + '(');
    }
  });
});

describe('cobros reads the audited billing endpoint', () => {
  it('fetches /billing', () => {
    expect(script).toContain("'/billing'");
  });

  // The whole point of the fix: success=true is not proof the bot moved the date.
  it('no longer fetches reschedules?successOnly=true for cobros', () => {
    expect(script).not.toContain('successOnly=true');
  });

  it('does not recompute days from raw log fields — the server does that', () => {
    expect(script).not.toContain('function cobroDays(');
    // The cobros path reads the audited move shape (from/to/days), not log columns.
    expect(script).toMatch(/selected\[0\]\.from/);
    expect(script).toMatch(/\.to\b/);
  });

  it('renders the attribution summary the endpoint returns', () => {
    for (const field of ['billableDays', 'externalDays', 'suspectDays', 'netDays']) {
      expect(script).toContain('bill.' + field);
    }
  });

  it('blocks selection of external moves and flags suspect ones', () => {
    expect(script).toContain("m.actor==='external'");
    expect(script).toContain('m.suspect');
    expect(script).toContain('cobro-badge-ext');
    expect(script).toContain('cobro-badge-sus');
    // External rows get a dead placeholder, never a checkbox.
    expect(script).toContain('cobro-cb-off');
  });

  it('warns when the selected total exceeds what is billable', () => {
    expect(script).toContain('totalDays>bill.billableDays');
  });
});

// Run the shipped renderCobros for real against bot 266's audited payload and read
// the markup it produces. Pattern-matching the source proves the code says the right
// thing; this proves it does the right thing.
describe('renderCobros output (executed)', () => {
  function render(bill: unknown, applicants = ['a']) {
    const el = { innerHTML: '' };
    const stub = () => ({
      innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
      classList: { add() {}, remove() {} }, disabled: false, checked: false,
      querySelectorAll: () => [], addEventListener() {},
    });
    const ctx: any = {
      // Silence the boot code's failed refresh(); we only care about renderCobros.
      console: { log() {}, warn() {}, error() {} },
      setTimeout, setInterval: () => 0, clearInterval() {},
      fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
      localStorage: { getItem: () => null, setItem() {} },
      document: {
        getElementById: (id: string) => (id === 'cobrosContent' ? el : stub()),
        querySelector: () => stub(), querySelectorAll: () => [],
        addEventListener() {}, body: stub(), documentElement: stub(),
      },
      location: { href: '', search: '' },
      navigator: { clipboard: { writeText: async () => {} } },
      history: { replaceState() {} },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    // The page's boot code touches browser APIs we do not stub; the function
    // definitions we need are hoisted before it runs.
    try { vm.runInContext(script, ctx, { timeout: 5000 }); } catch { /* boot noise */ }
    ctx.lastBot = { id: 266, applicantIds: applicants, ownerEmail: 'x@y.com', notificationPhone: '1' };
    ctx.lastCobrosRss = bill;
    ctx.renderCobros();
    return el.innerHTML;
  }

  // Exactly what GET /bots/266/billing returns for the real chain.
  const BOT_266 = {
    botDays: 205, externalDays: 41, suspectDays: 147, netDays: 246, billableDays: 58,
    firstDate: '2027-04-20', lastDate: '2026-08-17',
    moves: [
      { at: null, from: '2027-04-20', to: '2026-11-24', days: 147, actor: 'bot', kind: 'post_error_recovered', billable: false, suspect: true, note: 'el POST falló', logId: 1 },
      { at: null, from: '2026-11-24', to: '2026-10-14', days: 41, actor: 'external', kind: 'chain_break', billable: false, suspect: false, note: 'sin log del bot', logId: null },
      { at: null, from: '2026-10-14', to: '2026-09-03', days: 41, actor: 'bot', kind: 'clean', billable: true, suspect: false, note: '', logId: 2 },
      { at: null, from: '2026-09-03', to: '2026-08-21', days: 13, actor: 'bot', kind: 'clean', billable: true, suspect: false, note: '', logId: 3 },
      { at: null, from: '2026-08-21', to: '2026-08-17', days: 4, actor: 'bot', kind: 'clean', billable: true, suspect: false, note: '', logId: 4 },
    ],
  };

  it('shows the attribution summary, not just a total', () => {
    const out = render(BOT_266);
    expect(out).toContain('58d cobrables');
    expect(out).toContain('41d del cliente');
    expect(out).toContain('147d por verificar');
    expect(out).toContain('neto 246d');
  });

  it('gives the external move no checkbox and no price', () => {
    const out = render(BOT_266);
    const extRow = out.split('<label').find((r) => r.includes('cobro-badge-ext'))!;
    expect(extRow).toBeDefined();
    expect(extRow).toContain('cobro-cb-off');
    expect(extRow).not.toContain('type="checkbox"');
    expect(extRow).toContain('manual');
  });

  it('flags the 147-day suspect move instead of pricing it silently', () => {
    const out = render(BOT_266);
    const susRow = out.split('<label').find((r) => r.includes('cobro-badge-sus'))!;
    expect(susRow).toContain('data-suspect="1"');
    expect(susRow).toContain('-147d');
    expect(susRow).toContain('verificar');
  });

  it('leaves the three real bot moves selectable', () => {
    const out = render(BOT_266);
    const rows = out.split('<label').filter((r) => r.includes('type="checkbox"') && !r.includes('data-suspect'));
    expect(rows).toHaveLength(3);
    for (const d of ['-41d', '-13d', '-4d']) expect(out).toContain(d);
  });

  it('renders nothing chargeable when the bot never moved the date', () => {
    const out = render({ moves: [], botDays: 0, externalDays: 0, suspectDays: 0, netDays: 0, billableDays: 0 });
    expect(out).toContain('sin reagendamientos exitosos');
  });
});

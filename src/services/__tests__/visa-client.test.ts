import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock proxyFetch ────────────────────────────────────

const mockProxyFetch = vi.fn();

const DEFAULT_META = { proxyAttemptIp: null, fallbackReason: null, websharePoolSize: 0 };

vi.mock('../proxy-fetch.js', () => ({
  proxyFetch: async (...args: any[]) => {
    const result = await mockProxyFetch(...args);
    return result instanceof Response ? { response: result, meta: DEFAULT_META } : result;
  },
}));

vi.mock('../html-parsers.js', async () => {
  const actual = await vi.importActual<typeof import('../html-parsers.js')>('../html-parsers.js');
  return actual;
});

vi.mock('../../utils/constants.js', () => ({
  USER_AGENT: 'test-agent',
  BROWSER_HEADERS: {},
  getBaseUrl: (locale: string) => `https://ais.usvisa-info.com/${locale}/niv`,
  getLocaleTexts: () => ({ continueText: 'Continuar', rescheduleText: 'Reprogramar', includeCommit: true }),
}));

import { VisaClient } from '../visa-client.js';

// ── Fixtures ───────────────────────────────────────────

const GROUPS_CO = `
<html><body>
<a href="/es-co/niv/schedule/99999/appointment">Reagendar</a>
<p class='consular-appt'>
  <strong>Cita Consular:</strong>
  9 marzo, 2026, 08:15 Bogota Hora Local at Bogota
</p>
<p class='asc-appt'>
  <strong>Cita ASC:</strong>
  5 marzo, 2026, 10:45 BOGOTA Hora Local at Bogota ASC
</p>
</body></html>`;

const GROUPS_PE = `
<html><body>
<a href="/es-pe/niv/schedule/99999/appointment">Reagendar</a>
<p class='consular-appt'>
  <strong>Consular Appointment:</strong>
  20 april, 2026, 10:00 Lima Local Time at Lima
</p>
</body></html>`;

const GROUPS_DOUBLE_QUOTES = `
<html><body>
<a href="/en-ca/niv/schedule/99999/appointment">Reschedule</a>
<p class="consular-appt">
  <strong>Consular Appointment:</strong>
  3 january, 2027, 14:30 Ottawa Local Time at Ottawa
</p>
</body></html>`;

// ── Helpers ────────────────────────────────────────────

function makeResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html', ...headers },
  });
}

function makeClient(userId: string | null = '12345') {
  return new VisaClient(
    { cookie: 'test_cookie', csrfToken: 'csrf', authenticityToken: 'auth' },
    {
      scheduleId: '99999',
      applicantIds: ['1'],
      consularFacilityId: '25',
      ascFacilityId: '26',
      proxyProvider: 'direct',
      userId,
      locale: 'es-co',
    },
  );
}

// Real-world fixture: Colombia production HTML with &#58; entity + &mdash;
const GROUPS_REAL_CO = `
<html><body>
<div class='card'>
<a href="/es-co/niv/schedule/99999/appointment">Reagendar</a>
<p class='consular-appt'>
<strong>Cita Consular<span>&#58;</span></strong>
12 noviembre, 2026, 09:00 Bogota Hora Local at Bogota
 &mdash;
<a href="/es-co/niv/schedule/99999/addresses/consulate"><span class='fas fa-map-marker-alt'></span>
Cómo llegar
</a></p>
<p class='asc-appt'>
<strong>Cita CAS<span>&#58;</span></strong>
 3 noviembre, 2026, 08:00 BOGOTA Hora Local at Bogota ASC
 &mdash;
<a href="/es-co/niv/schedule/99999/addresses/asc"><span class='fas fa-map-marker-alt'></span>
Cómo llegar
</a></p>
</div>
</body></html>`;

// ── Tests ──────────────────────────────────────────────

describe('getCurrentAppointment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when userId is null', async () => {
    const client = makeClient(null);
    const result = await client.getCurrentAppointment();
    expect(result).toBeNull();
    expect(mockProxyFetch).not.toHaveBeenCalled();
  });

  it('returns consular + CAS for Colombia groups page', async () => {
    mockProxyFetch.mockResolvedValue(makeResponse(GROUPS_CO));
    const client = makeClient('12345');

    const result = await client.getCurrentAppointment();

    expect(result).toEqual({
      consularDate: '2026-03-09',
      consularTime: '08:15',
      casDate: '2026-03-05',
      casTime: '10:45',
    });
  });

  it('returns consular + null CAS for Peru groups page (no CAS appointment)', async () => {
    mockProxyFetch.mockResolvedValue(makeResponse(GROUPS_PE));
    const client = makeClient('55555');

    const result = await client.getCurrentAppointment();

    expect(result).toEqual({
      consularDate: '2026-04-20',
      consularTime: '10:00',
      casDate: null,
      casTime: null,
    });
  });

  it('handles double-quoted class attributes', async () => {
    mockProxyFetch.mockResolvedValue(makeResponse(GROUPS_DOUBLE_QUOTES));
    const client = makeClient('99999');

    const result = await client.getCurrentAppointment();

    expect(result).toEqual({
      consularDate: '2027-01-03',
      consularTime: '14:30',
      casDate: null,
      casTime: null,
    });
  });

  it('parses real-world production HTML with &#58; entity and &mdash;', async () => {
    mockProxyFetch.mockResolvedValue(makeResponse(GROUPS_REAL_CO));
    const client = makeClient('49983575');

    const result = await client.getCurrentAppointment();

    expect(result).toEqual({
      consularDate: '2026-11-12',
      consularTime: '09:00',
      casDate: '2026-11-03',
      casTime: '08:00',
    });
  });

  it('returns null for non-200 response', async () => {
    mockProxyFetch.mockResolvedValue(makeResponse('', 302, { location: '/sign_in' }));
    const client = makeClient('12345');

    const result = await client.getCurrentAppointment();
    expect(result).toBeNull();
  });

  it('returns null when HTML has no appointment data', async () => {
    mockProxyFetch.mockResolvedValue(makeResponse('<html><body>No appointments</body></html>'));
    const client = makeClient('12345');

    const result = await client.getCurrentAppointment();
    expect(result).toBeNull();
  });
});

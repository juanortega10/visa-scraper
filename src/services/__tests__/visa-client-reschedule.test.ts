import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Mock proxyFetch ────────────────────────────────────

const mockProxyFetch = vi.fn();

vi.mock('../proxy-fetch.js', () => ({
  proxyFetch: (...args: any[]) => mockProxyFetch(...args),
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

import { VisaClient, SessionExpiredError } from '../visa-client.js';

// ── Load real HTML fixtures from bot 12 ──────────────

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures', 'bot-12-es-co');
const APPOINTMENT_HTML = readFileSync(join(FIXTURES_DIR, 'appointment-page.html'), 'utf-8');
const GROUPS_HTML = readFileSync(join(FIXTURES_DIR, 'groups-page.html'), 'utf-8');

// ── Helpers ────────────────────────────────────────────

function makeResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html', ...headers },
  });
}

function makeJsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeRedirectResponse(location: string): Response {
  return new Response('', {
    status: 302,
    headers: { location },
  });
}

function makeBot12Client(userId: string | null = '49983575') {
  return new VisaClient(
    { cookie: 'test_cookie', csrfToken: 'old_csrf', authenticityToken: 'old_auth' },
    {
      scheduleId: '71075235',
      applicantIds: ['85015928', '85015997', '85016085', '85016161'],
      consularFacilityId: '25',
      ascFacilityId: '26',
      proxyProvider: 'direct',
      userId,
      locale: 'es-co',
    },
  );
}

// ── Tests ──────────────────────────────────────────────

describe('refreshTokens (bot 12 real fixture)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts CSRF token from real appointment page', async () => {
    mockProxyFetch.mockResolvedValue(makeResponse(APPOINTMENT_HTML));
    const client = makeBot12Client();

    await client.refreshTokens();
    const session = client.getSession();

    expect(session.csrfToken).toBe(
      'BPf4TCyzsFcOGO0OlQ+hwyI/eKAaFP5eDGbC8egtGWidaQ7blsdlcSDoB+YxK53vlElIHmrdWa50/b/VAFqRPw==',
    );
  });

  it('extracts authenticity_token from real appointment page', async () => {
    mockProxyFetch.mockResolvedValue(makeResponse(APPOINTMENT_HTML));
    const client = makeBot12Client();

    await client.refreshTokens();
    const session = client.getSession();

    expect(session.authenticityToken).toBe(
      'vL87bPCISEQxU44o4gooUC7hkwVHzlFkSjqWg5L4VIPqW+6OjTZykC7l1CTS3vb4uSZ+u3DKKtYlC+SeyHTnYg==',
    );
  });

  it('extracts userId from /groups/ link', async () => {
    mockProxyFetch.mockResolvedValue(makeResponse(APPOINTMENT_HTML));
    const client = makeBot12Client(null);

    await client.refreshTokens();

    expect(client.getUserId()).toBe('49983575');
  });

  it('extracts ASC facility ID from dropdown', async () => {
    mockProxyFetch.mockResolvedValue(makeResponse(APPOINTMENT_HTML));
    const client = makeBot12Client();

    await client.refreshTokens();

    expect(client.getExtractedAscFacilityId()).toBe('26');
  });

  it('builds correct URL with 4 applicant IDs', async () => {
    mockProxyFetch.mockResolvedValue(makeResponse(APPOINTMENT_HTML));
    const client = makeBot12Client();

    await client.refreshTokens();

    const url = mockProxyFetch.mock.calls[0][0] as string;
    expect(url).toContain('applicants[]=85015928');
    expect(url).toContain('applicants[]=85015997');
    expect(url).toContain('applicants[]=85016085');
    expect(url).toContain('applicants[]=85016161');
    expect(url).toContain('schedule/71075235/appointment');
  });
});

describe('getCurrentAppointment (bot 12 real fixture)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses consular appointment: Nov 12 2026, 09:00', async () => {
    mockProxyFetch.mockResolvedValue(makeResponse(GROUPS_HTML));
    const client = makeBot12Client();

    const result = await client.getCurrentAppointment();

    expect(result).toEqual({
      consularDate: '2026-11-12',
      consularTime: '09:00',
      casDate: '2026-11-03',
      casTime: '08:00',
    });
  });

  it('fetches groups page with correct userId', async () => {
    mockProxyFetch.mockResolvedValue(makeResponse(GROUPS_HTML));
    const client = makeBot12Client('49983575');

    await client.getCurrentAppointment();

    const url = mockProxyFetch.mock.calls[0][0] as string;
    expect(url).toBe('https://ais.usvisa-info.com/es-co/niv/groups/49983575');
  });
});

describe('reschedule (bot 12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('follows /continue redirect and returns true when it leads to /instructions', async () => {
    let callCount = 0;
    mockProxyFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // POST → 302 /continue
        return Promise.resolve(makeRedirectResponse('/es-co/niv/schedule/71075235/appointment/continue'));
      }
      // GET /continue → 302 /instructions
      return Promise.resolve(makeRedirectResponse('/es-co/niv/schedule/71075235/appointment/instructions'));
    });
    const client = makeBot12Client();

    const result = await client.reschedule('2026-10-21', '09:00', '2026-10-15', '08:00');

    expect(result).toBe(true);
    // POST + follow /continue = 2 calls
    expect(mockProxyFetch).toHaveBeenCalledTimes(2);
  });

  it('returns false when /continue leads back to /appointment (silent rejection)', async () => {
    let callCount = 0;
    mockProxyFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // POST → 302 /continue
        return Promise.resolve(makeRedirectResponse('/es-co/niv/schedule/71075235/appointment/continue'));
      }
      if (callCount === 2) {
        // GET /continue → 302 /appointment (rejection)
        return Promise.resolve(makeRedirectResponse('/es-co/niv/schedule/71075235/appointment'));
      }
      // GET /appointment → 200 with appointment form (no success text)
      return Promise.resolve(makeResponse('<html>Appointment form</html>', 200));
    });
    const client = makeBot12Client();

    const result = await client.reschedule('2026-10-21', '09:00', '2026-10-15', '08:00');

    expect(result).toBe(false);
  });

  it('returns true on redirect to /instructions', async () => {
    mockProxyFetch.mockResolvedValue(
      makeRedirectResponse('/es-co/niv/schedule/71075235/appointment/instructions'),
    );
    const client = makeBot12Client();

    const result = await client.reschedule('2026-10-21', '09:00', '2026-10-15', '08:00');

    expect(result).toBe(true);
  });

  it('throws SessionExpiredError on redirect to sign_in', async () => {
    mockProxyFetch.mockResolvedValue(
      makeRedirectResponse('/es-co/niv/users/sign_in'),
    );
    const client = makeBot12Client();

    await expect(
      client.reschedule('2026-10-21', '09:00', '2026-10-15', '08:00'),
    ).rejects.toThrow(SessionExpiredError);
  });

  it('sends correct POST body with 4 applicants and CAS', async () => {
    mockProxyFetch.mockResolvedValue(
      makeRedirectResponse('/es-co/niv/schedule/71075235/appointment/instructions'),
    );

    const client = new VisaClient(
      { cookie: 'session_cookie', csrfToken: 'my_csrf', authenticityToken: 'my_auth_token' },
      {
        scheduleId: '71075235',
        applicantIds: ['85015928', '85015997', '85016085', '85016161'],
        consularFacilityId: '25',
        ascFacilityId: '26',
        proxyProvider: 'direct',
        locale: 'es-co',
      },
    );

    await client.reschedule('2026-10-21', '09:00', '2026-10-15', '08:00');

    const call = mockProxyFetch.mock.calls[0];
    const url = call[0] as string;
    const options = call[1] as RequestInit;

    // Verify URL
    expect(url).toBe('https://ais.usvisa-info.com/es-co/niv/schedule/71075235/appointment');

    // Verify method
    expect(options.method).toBe('POST');

    // Verify body contents
    const body = options.body as string;
    const params = new URLSearchParams(body);

    expect(params.get('authenticity_token')).toBe('my_auth_token');
    expect(params.get('confirmed_limit_message')).toBe('1');
    expect(params.get('use_consulate_appointment_capacity')).toBe('true');
    expect(params.get('appointments[consulate_appointment][facility_id]')).toBe('25');
    expect(params.get('appointments[consulate_appointment][date]')).toBe('2026-10-21');
    expect(params.get('appointments[consulate_appointment][time]')).toBe('09:00');
    expect(params.get('appointments[asc_appointment][facility_id]')).toBe('26');
    expect(params.get('appointments[asc_appointment][date]')).toBe('2026-10-15');
    expect(params.get('appointments[asc_appointment][time]')).toBe('08:00');
    expect(params.get('commit')).toBe('Reprogramar');
  });

  it('sends correct headers: Cookie, Content-Type, Referer with applicant IDs', async () => {
    mockProxyFetch.mockResolvedValue(
      makeRedirectResponse('/es-co/niv/schedule/71075235/appointment/instructions'),
    );

    const client = new VisaClient(
      { cookie: 'my_session_value', csrfToken: 'csrf_val', authenticityToken: 'auth_val' },
      {
        scheduleId: '71075235',
        applicantIds: ['85015928', '85015997', '85016085', '85016161'],
        consularFacilityId: '25',
        ascFacilityId: '26',
        proxyProvider: 'direct',
        locale: 'es-co',
      },
    );

    await client.reschedule('2026-10-21', '09:00', '2026-10-15', '08:00');

    const headers = mockProxyFetch.mock.calls[0][1].headers as Record<string, string>;

    expect(headers.Cookie).toBe('_yatri_session=my_session_value');
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(headers.Origin).toBe('https://ais.usvisa-info.com');

    // Referer must include all 4 applicant IDs
    expect(headers.Referer).toContain('applicants%5B%5D=85015928');
    expect(headers.Referer).toContain('applicants%5B%5D=85015997');
    expect(headers.Referer).toContain('applicants%5B%5D=85016085');
    expect(headers.Referer).toContain('applicants%5B%5D=85016161');
  });

  it('uses direct provider for POST (not proxy)', async () => {
    mockProxyFetch.mockResolvedValue(
      makeRedirectResponse('/es-co/niv/schedule/71075235/appointment/instructions'),
    );

    // Create client with brightdata provider
    const client = new VisaClient(
      { cookie: 'c', csrfToken: 'csrf', authenticityToken: 'auth' },
      {
        scheduleId: '71075235',
        applicantIds: ['85015928'],
        consularFacilityId: '25',
        ascFacilityId: '26',
        proxyProvider: 'brightdata',
        locale: 'es-co',
      },
    );

    await client.reschedule('2026-10-21', '09:00', '2026-10-15', '08:00');

    // POST always uses 'direct' (3rd argument)
    expect(mockProxyFetch.mock.calls[0][2]).toBe('direct');
  });

  it('uses redirect: manual (does not auto-follow)', async () => {
    mockProxyFetch.mockResolvedValue(
      makeRedirectResponse('/es-co/niv/schedule/71075235/appointment/instructions'),
    );
    const client = makeBot12Client();

    await client.reschedule('2026-10-21', '09:00', '2026-10-15', '08:00');

    expect(mockProxyFetch.mock.calls[0][1].redirect).toBe('manual');
  });

  it('returns false for non-redirect non-success response', async () => {
    mockProxyFetch.mockResolvedValue(makeResponse('<html>Error</html>', 200));
    const client = makeBot12Client();

    const result = await client.reschedule('2026-10-21', '09:00', '2026-10-15', '08:00');

    expect(result).toBe(false);
  });
});

describe('followRedirectChain edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('follows multi-hop: 302 /appointment → 302 /continue → 302 /instructions → success', async () => {
    let callCount = 0;
    mockProxyFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // POST → 302 to some intermediate path
        return Promise.resolve(makeRedirectResponse('/es-co/niv/schedule/71075235/appointment/something'));
      }
      if (callCount === 2) {
        // GET intermediate → 302 to /continue
        return Promise.resolve(makeRedirectResponse('/es-co/niv/schedule/71075235/appointment/continue'));
      }
      if (callCount === 3) {
        // GET /continue → 302 to /instructions
        return Promise.resolve(makeRedirectResponse('/es-co/niv/schedule/71075235/appointment/instructions'));
      }
      // Should not reach here
      return Promise.resolve(makeResponse('', 200));
    });

    const client = makeBot12Client();
    const result = await client.reschedule('2026-10-21', '09:00', '2026-10-15', '08:00');

    expect(result).toBe(true);
    // 1st=POST, 2nd=GET intermediate, 3rd=GET /continue (then saw /instructions in 302)
    expect(mockProxyFetch).toHaveBeenCalledTimes(3);
  });

  it('stops after 5 hops without success', async () => {
    // Each hop redirects to another non-terminal path
    mockProxyFetch.mockImplementation(() => {
      return Promise.resolve(makeRedirectResponse('/es-co/niv/schedule/71075235/appointment/loop'));
    });

    const client = makeBot12Client();
    const result = await client.reschedule('2026-10-21', '09:00', '2026-10-15', '08:00');

    // 1 POST + 5 GETs (hop limit) = 6 calls
    expect(result).toBe(false);
    expect(mockProxyFetch).toHaveBeenCalledTimes(6);
  });

  it('detects success from final 200 page with "programado exitosamente"', async () => {
    let callCount = 0;
    mockProxyFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(makeRedirectResponse('/es-co/niv/schedule/71075235/appointment/other'));
      }
      // Final page has success text
      return Promise.resolve(makeResponse('<html>Su cita ha sido programado exitosamente</html>', 200));
    });

    const client = makeBot12Client();
    const result = await client.reschedule('2026-10-21', '09:00', '2026-10-15', '08:00');

    expect(result).toBe(true);
  });
});

describe('full flow: refreshTokens → getCurrentAppointment → reschedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('simulates a successful reschedule sequence', async () => {
    let callCount = 0;
    mockProxyFetch.mockImplementation(() => {
      callCount++;

      if (callCount === 1) {
        // refreshTokens → appointment page
        return Promise.resolve(makeResponse(APPOINTMENT_HTML));
      }
      if (callCount === 2) {
        // getCurrentAppointment → groups page
        return Promise.resolve(makeResponse(GROUPS_HTML));
      }
      if (callCount === 3) {
        // getConsularDays
        return Promise.resolve(makeJsonResponse([
          { date: '2026-10-21', business_day: true },
          { date: '2026-10-22', business_day: true },
        ]));
      }
      if (callCount === 4) {
        // getConsularTimes
        return Promise.resolve(makeJsonResponse({
          available_times: ['09:00', '10:00'],
          business_times: ['09:00', '10:00'],
        }));
      }
      if (callCount === 5) {
        // getCasDays
        return Promise.resolve(makeJsonResponse([
          { date: '2026-10-15', business_day: true },
        ]));
      }
      if (callCount === 6) {
        // getCasTimes
        return Promise.resolve(makeJsonResponse({
          available_times: ['08:00', '09:00'],
          business_times: ['08:00', '09:00'],
        }));
      }
      if (callCount === 7) {
        // reschedule POST → 302 /instructions
        return Promise.resolve(
          makeRedirectResponse('/es-co/niv/schedule/71075235/appointment/instructions'),
        );
      }
      return Promise.resolve(makeResponse('', 500));
    });

    const client = makeBot12Client(null); // start without userId

    // Step 1: refreshTokens
    await client.refreshTokens();
    expect(client.getUserId()).toBe('49983575');
    const session = client.getSession();
    expect(session.csrfToken).toContain('BPf4TCyz');
    expect(session.authenticityToken).toContain('vL87bPCI');

    // Step 2: getCurrentAppointment
    const appt = await client.getCurrentAppointment();
    expect(appt).toEqual({
      consularDate: '2026-11-12',
      consularTime: '09:00',
      casDate: '2026-11-03',
      casTime: '08:00',
    });

    // Step 3: getConsularDays
    const days = await client.getConsularDays();
    expect(days).toHaveLength(2);
    expect(days[0].date).toBe('2026-10-21');

    // Step 4: getConsularTimes
    const times = await client.getConsularTimes('2026-10-21');
    expect(times.available_times).toContain('09:00');

    // Step 5: getCasDays
    const casDays = await client.getCasDays('2026-10-21', '09:00');
    expect(casDays[0].date).toBe('2026-10-15');

    // Step 6: getCasTimes
    const casTimes = await client.getCasTimes('2026-10-15');
    expect(casTimes.available_times).toContain('08:00');

    // Step 7: reschedule
    const success = await client.reschedule('2026-10-21', '09:00', '2026-10-15', '08:00');
    expect(success).toBe(true);

    expect(mockProxyFetch).toHaveBeenCalledTimes(7);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('../../utils/constants.js', () => ({
  USER_AGENT: 'test-agent',
  BROWSER_HEADERS: {},
  getBaseUrl: (locale: string) => `https://ais.usvisa-info.com/${locale}/niv`,
  getLocaleTexts: () => ({ continueText: 'Continuar', rescheduleText: 'Reprogramar', includeCommit: true }),
}));

vi.mock('../proxy-fetch.js', () => ({
  getEffectiveWebshareUrls: () => [],
}));

vi.mock('../../utils/auth-logger.js', () => ({
  logAuth: vi.fn(),
}));

import { pureFetchLogin, InvalidCredentialsError, AccountLockedError } from '../login.js';

const BASE_CREDS = {
  email: 'test@example.com',
  password: 'testpass',
  locale: 'es-co',
  scheduleId: '00000000',
  applicantIds: ['00000000'],
  skipTokens: true as const,
};

function makeGetResponse(csrf = 'test-csrf', cookie = 'abc123') {
  return new Response(
    `<html><head><meta name="csrf-token" content="${csrf}"></head></html>`,
    {
      status: 200,
      headers: { 'Set-Cookie': `_yatri_session=${cookie}; path=/` },
    },
  );
}

describe('pureFetchLogin — credential detection', () => {
  beforeEach(() => mockFetch.mockReset());

  it('throws InvalidCredentialsError when sign_in_form is re-rendered (structural check)', async () => {
    // GET sign_in
    mockFetch.mockResolvedValueOnce(makeGetResponse());
    // POST — server returns 200 with sign_in_form re-rendered (wrong password)
    mockFetch.mockResolvedValueOnce(new Response(
      `auth_partial = $("<form class=\\"simple_form new_user\\" id=\\"sign_in_form\\" action=\\"/es-co/niv/users/sign_in\\" method=\\"post\\">...</form>");`,
      {
        status: 200,
        headers: { 'Set-Cookie': '_yatri_session=newcookie; path=/' },
      },
    ));

    await expect(pureFetchLogin(BASE_CREDS)).rejects.toThrow(InvalidCredentialsError);
  });

  it('throws AccountLockedError when lock message is present', async () => {
    mockFetch.mockResolvedValueOnce(makeGetResponse());
    mockFetch.mockResolvedValueOnce(new Response(
      'Your account is locked until 28 March, 2026, 20:23:21 -05.',
      {
        status: 200,
        headers: { 'Set-Cookie': '_yatri_session=newcookie; path=/' },
      },
    ));

    await expect(pureFetchLogin(BASE_CREDS)).rejects.toThrow(AccountLockedError);
  });

  it('AccountLockedError parses the lockout date', async () => {
    mockFetch.mockResolvedValueOnce(makeGetResponse());
    mockFetch.mockResolvedValueOnce(new Response(
      'Your account is locked until 28 March, 2026, 20:23:21 -05.',
      {
        status: 200,
        headers: { 'Set-Cookie': '_yatri_session=newcookie; path=/' },
      },
    ));

    try {
      await pureFetchLogin(BASE_CREDS);
    } catch (e) {
      expect(e).toBeInstanceOf(AccountLockedError);
      expect((e as AccountLockedError).lockedUntil).toBeInstanceOf(Date);
    }
  });

  it('lock message takes precedence over sign_in_form', async () => {
    mockFetch.mockResolvedValueOnce(makeGetResponse());
    // Body has both lock message and sign_in_form
    mockFetch.mockResolvedValueOnce(new Response(
      'Your account is locked until 28 March, 2026, 20:23:21 -05. <form id="sign_in_form">',
      {
        status: 200,
        headers: { 'Set-Cookie': '_yatri_session=newcookie; path=/' },
      },
    ));

    await expect(pureFetchLogin(BASE_CREDS)).rejects.toThrow(AccountLockedError);
  });
});

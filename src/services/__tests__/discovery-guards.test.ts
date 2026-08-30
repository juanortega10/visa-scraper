import { describe, it, expect } from 'vitest';
import { suggestEmailDomain, MAX_TOTAL_ATTEMPTS } from '../../utils/constants.js';
import { isTerminalDiscoverError } from '../agency-discovery.js';

describe('suggestEmailDomain', () => {
  it('catches the .con typo that burned attempt 21', () => {
    expect(suggestEmailDomain('azualcantara295@gmail.con')).toBe('gmail.com');
  });

  it('catches misspelled providers', () => {
    expect(suggestEmailDomain('a@gmial.com')).toBe('gmail.com');
    expect(suggestEmailDomain('a@hotmial.com')).toBe('hotmail.com');
    expect(suggestEmailDomain('a@outlook.con')).toBe('outlook.com');
  });

  it('is case-insensitive on the domain', () => {
    expect(suggestEmailDomain('YANETHBRAN161@GMAIL.CON')).toBe('gmail.com');
  });

  it('passes real domains through', () => {
    expect(suggestEmailDomain('YANETHBRAN161@GMAIL.COM')).toBeNull();
    expect(suggestEmailDomain('juan@visasok.com')).toBeNull();
    expect(suggestEmailDomain('juan@empresa.com.co')).toBeNull();
  });

  it('returns null when there is no domain', () => {
    expect(suggestEmailDomain('sin-arroba')).toBeNull();
    expect(suggestEmailDomain('trailing@')).toBeNull();
  });
});

describe('isTerminalDiscoverError', () => {
  it('marks portal verdicts as terminal so the reconciler stops retrying', () => {
    expect(isTerminalDiscoverError('invalid_credentials')).toBe(true);
    expect(isTerminalDiscoverError('account_locked')).toBe(true);
  });

  it('marks unusable rows as terminal', () => {
    expect(isTerminalDiscoverError('corrupt_credentials')).toBe(true);
    expect(isTerminalDiscoverError('invalid_country')).toBe(true);
  });

  it('keeps a portal outage retryable', () => {
    expect(isTerminalDiscoverError('discovery_failed')).toBe(false);
  });

  it('handles a missing code', () => {
    expect(isTerminalDiscoverError(null)).toBe(false);
    expect(isTerminalDiscoverError(undefined)).toBe(false);
  });
});

describe('MAX_TOTAL_ATTEMPTS', () => {
  it('stays at the D26 value the reconciler filters on', () => {
    expect(MAX_TOTAL_ATTEMPTS).toBe(4);
  });
});

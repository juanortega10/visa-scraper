/**
 * Shared cache for discovery results so that POST /api/bots can reuse the
 * session created by POST /api/bots/discover-account or by the agency
 * credential-attempts flow. 5-minute TTL.
 *
 * In-memory: not durable across restarts. The agency flow ALSO persists the
 * raw discovery data into bot_credential_attempts.discoveredData, so even if
 * the in-memory token expires we can rebuild from DB (re-discover with same
 * creds) without losing the user's progress.
 */

import { randomUUID } from 'node:crypto';
import type { DiscoverResult } from './login.js';

interface DiscoveryCache {
  result: DiscoverResult;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const tokens = new Map<string, DiscoveryCache>();

function cleanExpired(): void {
  const now = Date.now();
  for (const [key, entry] of tokens) {
    if (entry.expiresAt < now) tokens.delete(key);
  }
}

export function setDiscoveryToken(result: DiscoverResult): string {
  cleanExpired();
  const token = randomUUID();
  tokens.set(token, { result, expiresAt: Date.now() + TTL_MS });
  return token;
}

export function consumeDiscoveryToken(token: string | undefined | null): DiscoverResult | undefined {
  if (!token) return undefined;
  const entry = tokens.get(token);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    tokens.delete(token);
    return undefined;
  }
  tokens.delete(token); // one-time use
  return entry.result;
}

export function peekDiscoveryToken(token: string | undefined | null): DiscoverResult | undefined {
  if (!token) return undefined;
  const entry = tokens.get(token);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    tokens.delete(token);
    return undefined;
  }
  return entry.result;
}

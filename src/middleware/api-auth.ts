import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { verifyToken } from '@clerk/backend';
import { computeAuthToken } from '../api/dashboard.js';

const API_KEY = process.env.API_KEY;
const CLERK_JWT_KEY = process.env.CLERK_JWT_KEY;

const PUBLIC_PATHS = [
  '/api/health',
  '/api/bots/me',
  '/api/bots/countries',
  '/api/bots/validate-credentials',
  '/api/bots/discover-account',
];

export function apiAuth() {
  return createMiddleware(async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (PUBLIC_PATHS.includes(path)) return next();

    // 0. Dashboard referer — dashboard HTML is already auth-protected
    const referer = c.req.header('Referer');
    if (referer) {
      try {
        const refUrl = new URL(referer);
        if (refUrl.pathname.startsWith('/dashboard')) return next();
      } catch {}
    }

    // 1. API key
    const apiKey = c.req.header('X-API-Key');
    if (apiKey && API_KEY && apiKey === API_KEY) return next();

    // 2. Clerk JWT
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token && CLERK_JWT_KEY) {
      try {
        await verifyToken(token, { jwtKey: CLERK_JWT_KEY });
        return next();
      } catch {
        // Invalid JWT — fall through to cookie check
      }
    }

    // 3. Dashboard cookie
    const cookie = getCookie(c, 'dashboard_auth');
    const expected = computeAuthToken();
    if (cookie && cookie === expected) return next();

    console.log(`[api-auth] 401 path=${path} hasCookie=${!!cookie} cookieMatch=${cookie === expected}`);
    return c.json({ error: 'unauthorized' }, 401);
  });
}

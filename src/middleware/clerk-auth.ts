import { createMiddleware } from 'hono/factory';
import { verifyToken } from '@clerk/backend';

const CLERK_JWT_KEY = process.env.CLERK_JWT_KEY;

export interface ClerkUser {
  clerkUserId: string;
}

/**
 * Clerk JWT auth middleware.
 * Extracts clerkUserId from Bearer token using offline verification (PEM public key).
 * Use `required: false` to make auth optional (sets clerkUser to null if no token).
 */
export function clerkAuth(opts: { required?: boolean } = {}) {
  const { required = true } = opts;

  return createMiddleware<{ Variables: { clerkUser: ClerkUser | null } }>(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      if (required) return c.json({ error: 'Authorization required', code: 'no_token' }, 401);
      c.set('clerkUser', null);
      return next();
    }

    if (!CLERK_JWT_KEY) {
      if (required) {
        console.error('[clerk-auth] CLERK_JWT_KEY not configured');
        return c.json({ error: 'Auth not configured' }, 500);
      }
      // Optional auth + no key configured → skip verification, treat as unauthenticated
      c.set('clerkUser', null);
      return next();
    }

    try {
      const payload = await verifyToken(token, { jwtKey: CLERK_JWT_KEY });
      c.set('clerkUser', { clerkUserId: payload.sub });
    } catch (e: unknown) {
      if (required) {
        const msg = e instanceof Error ? e.message : '';
        const isExpired = msg.includes('exp') || msg.includes('expire');
        return c.json({
          error: isExpired ? 'Token expired' : 'Invalid token',
          code: isExpired ? 'token_expired' : 'token_invalid',
        }, 401);
      }
      c.set('clerkUser', null);
    }

    return next();
  });
}

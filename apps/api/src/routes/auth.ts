import { Hono } from 'hono';
import {
  otpRequestSchema,
  otpVerifySchema,
  type OtpRequestResponse,
  type SessionResponse,
} from '@hackathon/shared';
import { hmacHex } from '../auth/crypto';
import { revokeAllSessionsForUser, revokeSessionByTokenHash, writeAudit } from '../auth/repo';
import {
  clearSessionCookie,
  readSessionToken,
  requireAuth,
  setSessionCookie,
} from '../auth/session';
import { getAuthSettings } from '../auth/settings';
import { requestOtp, verifyOtp } from '../auth/service';
import { parseJsonBody } from '../lib/validate';
import type { HonoEnv } from '../types';

export const authRoutes = new Hono<HonoEnv>();

/**
 * POST /api/auth/otp/request
 * Always 202 with an identical body, whether or not the address is eligible, so the endpoint
 * cannot be used to discover who has an account. (429 depends only on the caller's own volume.)
 */
authRoutes.post('/auth/otp/request', async (c) => {
  const { email } = await parseJsonBody(c, otpRequestSchema);
  await requestOtp(c, email);
  const body: OtpRequestResponse = {
    status: 'accepted',
    resendAfterSeconds: getAuthSettings(c).config.AUTH_OTP_RESEND_COOLDOWN_SECONDS,
  };
  return c.json(body, 202);
});

/**
 * POST /api/auth/otp/verify
 * 200 + Set-Cookie on success. Every failure (wrong, expired, used, locked, ineligible) is the
 * same 401 INVALID_OR_EXPIRED_CODE. The session token is only ever in the cookie, never the body.
 */
authRoutes.post('/auth/otp/verify', async (c) => {
  const { email, code } = await parseJsonBody(c, otpVerifySchema);
  const result = await verifyOtp(c, email, code);
  const { config } = getAuthSettings(c);
  setSessionCookie(c, result.token, config.AUTH_SESSION_TTL_SECONDS);
  const body: SessionResponse = { user: result.user, session: { expiresAt: result.expiresAt } };
  return c.json(body, 200);
});

/** GET /api/auth/session — the current user, or 401. */
authRoutes.get('/auth/session', requireAuth, (c) => {
  const auth = c.get('auth');
  if (!auth) throw new Error('auth context missing after requireAuth');
  const body: SessionResponse = {
    user: { id: auth.userId, email: auth.email, displayName: auth.displayName, role: auth.role },
    session: { expiresAt: auth.sessionExpiresAt },
  };
  return c.json(body, 200);
});

/**
 * POST /api/auth/logout — revokes the presented session server-side and clears the cookie.
 * Idempotent: 204 even when nobody is signed in. A copy of the old cookie stops working at once.
 */
authRoutes.post('/auth/logout', async (c) => {
  const token = readSessionToken(c);
  if (token !== null) {
    const { secret } = getAuthSettings(c);
    const now = c.get('now')().toISOString();
    const revoked = await revokeSessionByTokenHash(
      c.env.DB,
      await hmacHex(secret, 'session', token),
      'logout',
      now,
    );
    if (revoked) {
      await writeAudit(c.env.DB, {
        eventType: 'auth.logout',
        outcome: 'success',
        actorUserId: revoked.user_id,
        targetUserId: revoked.user_id,
        requestId: c.get('requestId'),
        now,
      });
    }
  }
  clearSessionCookie(c);
  return c.body(null, 204);
});

/** POST /api/auth/sessions/revoke — "sign out everywhere": revokes ALL of the caller's sessions. */
authRoutes.post('/auth/sessions/revoke', requireAuth, async (c) => {
  const auth = c.get('auth');
  if (!auth) throw new Error('auth context missing after requireAuth');
  const now = c.get('now')().toISOString();
  const revoked = await revokeAllSessionsForUser(c.env.DB, auth.userId, 'revoke_all', now);
  await writeAudit(c.env.DB, {
    eventType: 'auth.sessions.revoke',
    outcome: 'success',
    actorUserId: auth.userId,
    targetUserId: auth.userId,
    requestId: c.get('requestId'),
    details: { revoked },
    now,
  });
  clearSessionCookie(c);
  return c.json({ revoked }, 200);
});

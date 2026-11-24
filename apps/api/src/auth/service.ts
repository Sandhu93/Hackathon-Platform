import type { Context } from 'hono';
import type { SessionUser } from '@hackathon/shared';
import { createEmailProvider, EmailProviderError, type EmailProvider } from '../adapters/email';
import { AppError } from '../lib/errors';
import { afterResponse, withTimeout } from '../lib/async';
import type { HonoEnv } from '../types';
import { hmacHex, randomOtp, randomToken, timingSafeEqual } from './crypto';
import { evaluateEligibility } from './eligibility';
import {
  consumeChallenge,
  createChallenge,
  createSession,
  findActiveChallengeId,
  findUserByEmail,
  insertUserIfAbsent,
  markDelivery,
  purgeExpired,
  takeAttempt,
  writeAudit,
  type UserRow,
} from './repo';
import { getAuthSettings } from './settings';
import { enforceThrottle } from './throttle';

export function getEmailProvider(c: Context<HonoEnv>): EmailProvider {
  const override = c.get('emailProviderOverride');
  if (override) return override;
  return createEmailProvider(
    c.get('config'),
    { EMAIL_PROVIDER_API_KEY: c.env.EMAIL_PROVIDER_API_KEY },
    c.get('logger'),
  );
}

function otpMessage(code: string, ttlSeconds: number) {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  return {
    subject: 'Your Hackathon Platform sign-in code',
    text: [
      `Your sign-in code is ${code}.`,
      '',
      `It expires in ${minutes} minute${minutes === 1 ? '' : 's'} and can be used once.`,
      'If you did not ask to sign in, you can ignore this email.',
      'Never share this code with anyone.',
    ].join('\n'),
  };
}

/**
 * Request a sign-in code. The caller must answer every address identically (see the route):
 * nothing here may be observable by the client except throttling, which depends only on what
 * the client itself sent. What happened is recorded in the audit log.
 */
export async function requestOtp(c: Context<HonoEnv>, email: string): Promise<void> {
  const settings = getAuthSettings(c);
  const { config, secret } = settings;
  const db = c.env.DB;
  const throttle = await enforceThrottle(c, settings, 'request', email);
  // Resolve the provider before looking at the account so that a provider misconfiguration
  // fails every request alike (503), instead of only those for eligible addresses.
  const provider = getEmailProvider(c);

  const requestId = c.get('requestId');
  const nowIso = c.get('now')().toISOString();
  const audit = (outcome: string, details?: Record<string, unknown>) =>
    writeAudit(db, {
      eventType: 'auth.otp.request',
      outcome,
      subjectHash: throttle.emailHash,
      sourceHash: throttle.sourceHash,
      requestId,
      details: details ?? null,
      now: nowIso,
    });

  const user = await findUserByEmail(db, email);
  const eligibility = evaluateEligibility(config, email, user);
  if (!eligibility.ok) {
    await audit('ineligible', { reason: eligibility.reason });
    return;
  }

  const challengeId = crypto.randomUUID();
  const code = randomOtp();
  const nowMs = Date.parse(nowIso);
  const created = await createChallenge(db, {
    id: challengeId,
    email,
    codeHash: await hmacHex(secret, 'otp', `${challengeId}:${code}`),
    now: nowIso,
    expiresAt: new Date(nowMs + config.AUTH_OTP_TTL_SECONDS * 1000).toISOString(),
    cooldownCutoff: new Date(nowMs - config.AUTH_OTP_RESEND_COOLDOWN_SECONDS * 1000).toISOString(),
    maxAttempts: config.AUTH_OTP_MAX_ATTEMPTS,
    sourceHash: throttle.sourceHash,
  });
  if (!created) {
    await audit('cooldown');
    return;
  }
  await audit('issued');

  const message = otpMessage(code, config.AUTH_OTP_TTL_SECONDS);
  await afterResponse(c, async () => {
    try {
      await withTimeout(
        provider.send({ to: email, ...message, idempotencyKey: challengeId }),
        config.AUTH_EMAIL_TIMEOUT_MS,
        'email provider',
      );
      await markDelivery(db, challengeId, 'sent', c.get('now')().toISOString());
    } catch (err) {
      const failedAt = c.get('now')().toISOString();
      await markDelivery(db, challengeId, 'failed', failedAt);
      await writeAudit(db, {
        eventType: 'auth.otp.delivery',
        outcome: 'failed',
        subjectHash: throttle.emailHash,
        requestId,
        details: { retryable: err instanceof EmailProviderError ? err.retryable : true },
        now: failedAt,
      });
      c.get('logger').error('auth.otp.delivery_failed', { err });
    }
  });
}

export interface LoginResult {
  user: SessionUser;
  token: string;
  expiresAt: string;
}

const invalidCode = () =>
  new AppError(
    'INVALID_OR_EXPIRED_CODE',
    'That code is invalid or has expired. Request a new one.',
  );

/** Verify a code and open a session. Every failure looks identical to the client. */
export async function verifyOtp(
  c: Context<HonoEnv>,
  email: string,
  code: string,
): Promise<LoginResult> {
  const settings = getAuthSettings(c);
  const { config, secret } = settings;
  const db = c.env.DB;
  const throttle = await enforceThrottle(c, settings, 'verify', email);
  const requestId = c.get('requestId');
  const nowIso = c.get('now')().toISOString();

  const fail = async (reason: string, details: Record<string, unknown> = {}): Promise<never> => {
    await writeAudit(db, {
      eventType: 'auth.login',
      outcome: 'failure',
      subjectHash: throttle.emailHash,
      sourceHash: throttle.sourceHash,
      requestId,
      details: { reason, ...details },
      now: nowIso,
    });
    throw invalidCode();
  };

  const challengeId = await findActiveChallengeId(db, email);
  if (challengeId === null) {
    await hmacHex(secret, 'otp', 'decoy'); // comparable CPU work whether or not a code exists
    return fail('no_active_code');
  }
  // Count the attempt first and atomically; guesses made in parallel cannot exceed the limit.
  const attempt = await takeAttempt(db, challengeId, nowIso);
  if (!attempt) return fail('expired_or_exhausted');

  const submitted = await hmacHex(secret, 'otp', `${attempt.id}:${code}`);
  if (!timingSafeEqual(submitted, attempt.code_hash)) {
    return fail('wrong_code', { attempt: attempt.attempts, of: attempt.max_attempts });
  }
  // Single use: exactly one concurrent caller can consume the challenge.
  if (!(await consumeChallenge(db, attempt.id, nowIso))) return fail('already_used');

  // Eligibility is re-checked now: the account may have been suspended since the code was sent.
  let user: UserRow | null = await findUserByEmail(db, email);
  let eligibility = evaluateEligibility(config, email, user);
  if (!eligibility.ok) return fail('ineligible', { reason: eligibility.reason });
  if (user === null) {
    // "domain" mode: first successful sign-in provisions the account.
    await insertUserIfAbsent(db, {
      id: crypto.randomUUID(),
      email,
      displayName: null,
      mailboxKind: 'personal',
      now: nowIso,
    });
    user = await findUserByEmail(db, email);
    eligibility = evaluateEligibility(config, email, user);
    if (!user || !eligibility.ok) return fail('ineligible', { reason: 'provisioning_failed' });
  }

  const token = randomToken();
  const expiresAt = new Date(
    Date.parse(nowIso) + config.AUTH_SESSION_TTL_SECONDS * 1000,
  ).toISOString();
  await createSession(db, {
    id: crypto.randomUUID(),
    userId: user.id,
    tokenHash: await hmacHex(secret, 'session', token),
    now: nowIso,
    expiresAt,
    sourceHash: throttle.sourceHash,
  });
  await writeAudit(db, {
    eventType: 'auth.login',
    outcome: 'success',
    actorUserId: user.id,
    targetUserId: user.id,
    subjectHash: throttle.emailHash,
    sourceHash: throttle.sourceHash,
    requestId,
    now: nowIso,
  });

  // Housekeeping on roughly 1 in 25 successful sign-ins (a scheduled job replaces this in M04).
  if ((crypto.getRandomValues(new Uint8Array(1))[0] ?? 1) % 25 === 0) {
    await afterResponse(c, () => purgeExpired(db, nowIso, Math.floor(Date.parse(nowIso) / 1000)));
  }

  return {
    user: {
      id: user.id,
      email: user.email_normalized,
      displayName: user.display_name,
      role: user.role,
    },
    token,
    expiresAt,
  };
}

import type { Context } from 'hono';
import { parseAuthConfig, type AuthConfig } from '@hackathon/shared';
import { ConfigError } from '../lib/errors';
import type { HonoEnv } from '../types';

export interface AuthSettings {
  config: AuthConfig;
  /** Server-side secret for keyed hashes. Never logged, never sent to clients. */
  secret: string;
}

/** Used only when ENVIRONMENT is development/test and no secret is configured. */
export const DEV_FALLBACK_SECRET = 'dev-only-insecure-secret-do-not-use-in-production-0123456789';
const MIN_SECRET_LENGTH = 32;

/**
 * Validate sign-in settings. Fails closed: outside development/test a missing or weak
 * AUTH_HMAC_SECRET is a configuration error, and the client only ever sees a generic 503.
 */
export function getAuthSettings(c: Context<HonoEnv>): AuthSettings {
  const cached = c.get('authSettings');
  if (cached) return cached;

  const parsed = parseAuthConfig(c.env);
  if (!parsed.ok) {
    const names = parsed.issues.map((issue) => issue.path).join(', ');
    throw new ConfigError(`Invalid authentication configuration: ${names}`);
  }

  const environment = c.get('config').ENVIRONMENT;
  const local = environment === 'development' || environment === 'test';
  const raw = c.env.AUTH_HMAC_SECRET;
  let secret: string;
  if (typeof raw === 'string' && raw.length > 0) {
    if (raw.length < MIN_SECRET_LENGTH) {
      throw new ConfigError(`AUTH_HMAC_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    if (!local && raw === DEV_FALLBACK_SECRET) {
      throw new ConfigError('AUTH_HMAC_SECRET must not be the development default');
    }
    secret = raw;
  } else if (local) {
    secret = DEV_FALLBACK_SECRET;
  } else {
    throw new ConfigError('AUTH_HMAC_SECRET is required');
  }

  const settings = { config: parsed.config, secret };
  c.set('authSettings', settings);
  return settings;
}

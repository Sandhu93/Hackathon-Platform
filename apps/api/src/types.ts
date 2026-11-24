import type { AppConfig, Role } from '@hackathon/shared';
import type { AuthSettings } from './auth/settings';
import type { EmailProvider } from './adapters/email';
import type { Logger } from './lib/logger';

/** Cloudflare bindings and variables. Secrets are optional here and validated by the adapter that needs them. */
export interface Bindings {
  DB: D1Database;
  ASSETS?: Fetcher;
  EMAIL_PROVIDER_API_KEY?: string;
  AUTH_HMAC_SECRET?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  [key: string]: unknown;
}

/** The signed-in user for the current request (set by the session middleware). */
export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
  sessionExpiresAt: string;
}

export interface Variables {
  /** Injectable clock (tests). Defaults to the real time. */
  now: () => Date;
  /** Test/integration override for the email provider. */
  emailProviderOverride?: EmailProvider;
  authSettings?: AuthSettings;
  auth?: AuthContext;
  requestId: string;
  logger: Logger;
  /** True when bindings failed validation; `configGuard` then rejects the request with a 503. */
  configInvalid: boolean;
  /** Set only when `configInvalid` is false. Only read it after `configGuard` has run. */
  config: AppConfig;
}

export interface HonoEnv {
  Bindings: Bindings;
  Variables: Variables;
}

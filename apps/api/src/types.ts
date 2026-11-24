import type { AppConfig } from '@hackathon/shared';
import type { Logger } from './lib/logger';

/** Cloudflare bindings and variables. Secrets are optional here and validated by the adapter that needs them. */
export interface Bindings {
  DB: D1Database;
  ASSETS?: Fetcher;
  EMAIL_PROVIDER_API_KEY?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  [key: string]: unknown;
}

export interface Variables {
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

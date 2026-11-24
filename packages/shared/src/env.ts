import { z } from 'zod';
import { isValidDomain, normalizeEmail } from './email';

export const ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;
export const environmentSchema = z.enum(ENVIRONMENTS);
export type EnvironmentName = z.infer<typeof environmentSchema>;

const originSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}, 'must be an origin (scheme://host[:port]) with no path, query or trailing slash');

/** Comma-separated origin list -> validated string[]. Empty string -> []. */
const originListSchema = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(z.array(originSchema).max(10));

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Non-secret configuration, supplied through wrangler `vars` (or `.dev.vars` locally).
 * Secrets are validated lazily by the adapter that needs them, so a missing
 * third-party credential can never take down unrelated endpoints such as /api/health.
 */
export const appConfigSchema = z
  .object({
    ENVIRONMENT: environmentSchema,
    APP_ORIGIN: originSchema,
    CORS_ALLOWED_ORIGINS: originListSchema,
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    APP_VERSION: z.string().min(1).max(64).default('dev'),
    EMAIL_PROVIDER: z.enum(['mock', 'external']).default('mock'),
    DRIVE_PROVIDER: z.enum(['mock', 'google']).default('mock'),
    MAX_JSON_BODY_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(65_536),
    // Used only when EMAIL_PROVIDER=external; presence is enforced by the email adapter factory
    // (so a missing value never takes down /api/health), format is enforced here.
    EMAIL_API_URL: z.url().startsWith('https://').optional(),
    EMAIL_FROM_ADDRESS: z
      .string()
      .refine((v) => normalizeEmail(v) !== null, 'must be a plain email address')
      .optional(),
  })
  .superRefine((cfg, ctx) => {
    const strict = cfg.ENVIRONMENT === 'staging' || cfg.ENVIRONMENT === 'production';
    if (!strict) return;
    const origins: [string, string][] = [
      ['APP_ORIGIN', cfg.APP_ORIGIN],
      ...cfg.CORS_ALLOWED_ORIGINS.map((o): [string, string] => ['CORS_ALLOWED_ORIGINS', o]),
    ];
    for (const [key, origin] of origins) {
      const url = new URL(origin);
      if (url.protocol !== 'https:' || LOCAL_HOSTS.has(url.hostname)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'must be an https, non-local origin in staging and production',
        });
      }
    }
  });

export type AppConfig = z.infer<typeof appConfigSchema>;

export type ConfigResult =
  { ok: true; config: AppConfig } | { ok: false; issues: { path: string; message: string }[] };

/**
 * Validate raw bindings. On failure returns key names and rule messages only —
 * never the offending values, which could be secrets.
 */
export function parseAppConfig(raw: Record<string, unknown>): ConfigResult {
  const result = appConfigSchema.safeParse(raw);
  if (result.success) return { ok: true, config: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Authentication settings (Milestone 01). Parsed lazily by the auth routes only, so a mistake
// here fails closed for sign-in (generic 503) without affecting /api/health or static assets.
// ---------------------------------------------------------------------------------------------

const int = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

/** Comma-separated domain list -> lower-cased, de-duplicated, validated string[]. */
const domainListSchema = z
  .string()
  .default('')
  .transform((raw) => [
    ...new Set(
      raw
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part.length > 0),
    ),
  ])
  .pipe(
    z
      .array(z.string().refine(isValidDomain, 'must be a valid domain name such as example.org'))
      .min(1, 'at least one institutional domain is required')
      .max(20),
  );

export const ELIGIBILITY_MODES = ['roster', 'domain'] as const;

export const authConfigSchema = z.object({
  /** Domains whose mailboxes may sign in, e.g. "example.org". Subdomains are NOT implied. */
  AUTH_ALLOWED_EMAIL_DOMAINS: domainListSchema,
  /**
   * roster: only people an administrator has approved (a `users` row with status "active").
   * domain: any mailbox on an allowed domain, unless an administrator suspended or revoked it.
   */
  AUTH_ELIGIBILITY_MODE: z.enum(ELIGIBILITY_MODES).default('roster'),
  AUTH_OTP_TTL_SECONDS: int(60, 1800, 600),
  AUTH_OTP_MAX_ATTEMPTS: int(1, 10, 5),
  AUTH_OTP_RESEND_COOLDOWN_SECONDS: int(0, 600, 60),
  AUTH_EMAIL_TIMEOUT_MS: int(100, 30_000, 8000),
  AUTH_SESSION_TTL_SECONDS: int(300, 2_592_000, 604_800),
  AUTH_SESSION_IDLE_TTL_SECONDS: int(60, 2_592_000, 86_400),
  // Fixed one-hour windows. See docs/security.md for what each signal protects.
  AUTH_RL_REQUEST_EMAIL: int(1, 1000, 6),
  AUTH_RL_REQUEST_SOURCE: int(1, 100_000, 30),
  AUTH_RL_REQUEST_GLOBAL: int(1, 1_000_000, 3000),
  AUTH_RL_VERIFY_EMAIL: int(1, 1000, 15),
  AUTH_RL_VERIFY_SOURCE: int(1, 100_000, 60),
  AUTH_RL_VERIFY_GLOBAL: int(1, 1_000_000, 6000),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;

export type AuthConfigResult =
  { ok: true; config: AuthConfig } | { ok: false; issues: { path: string; message: string }[] };

export function parseAuthConfig(raw: Record<string, unknown>): AuthConfigResult {
  const result = authConfigSchema.safeParse(raw);
  if (result.success) return { ok: true, config: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}

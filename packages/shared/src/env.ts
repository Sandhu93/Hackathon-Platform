import { z } from 'zod';

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

import { describe, expect, it } from 'vitest';
import { parseAppConfig } from './env';

const valid = { ENVIRONMENT: 'development', APP_ORIGIN: 'http://localhost:5173' };

describe('parseAppConfig', () => {
  it('accepts a minimal development config and applies defaults', () => {
    const result = parseAppConfig(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.LOG_LEVEL).toBe('info');
      expect(result.config.EMAIL_PROVIDER).toBe('mock');
      expect(result.config.CORS_ALLOWED_ORIGINS).toEqual([]);
      expect(result.config.MAX_JSON_BODY_BYTES).toBe(65_536);
    }
  });

  it('detects missing required values without echoing values', () => {
    const result = parseAppConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.path).sort()).toEqual(['APP_ORIGIN', 'ENVIRONMENT']);
    }
  });

  it('rejects an origin with a path or trailing slash', () => {
    expect(parseAppConfig({ ...valid, APP_ORIGIN: 'http://localhost:5173/' }).ok).toBe(false);
    expect(parseAppConfig({ ...valid, APP_ORIGIN: 'http://localhost:5173/app' }).ok).toBe(false);
  });

  it('parses and validates the CORS origin list', () => {
    const ok = parseAppConfig({
      ...valid,
      CORS_ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com',
    });
    expect(ok.ok && ok.config.CORS_ALLOWED_ORIGINS).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
    expect(parseAppConfig({ ...valid, CORS_ALLOWED_ORIGINS: 'not-an-origin' }).ok).toBe(false);
  });

  it('requires https, non-local origins in production and staging', () => {
    for (const environment of ['production', 'staging']) {
      expect(
        parseAppConfig({ ENVIRONMENT: environment, APP_ORIGIN: 'http://x.example.com' }).ok,
      ).toBe(false);
      expect(parseAppConfig({ ENVIRONMENT: environment, APP_ORIGIN: 'https://localhost' }).ok).toBe(
        false,
      );
      expect(
        parseAppConfig({ ENVIRONMENT: environment, APP_ORIGIN: 'https://hack.example.com' }).ok,
      ).toBe(true);
    }
  });

  it('rejects unknown provider names and out-of-range limits', () => {
    expect(parseAppConfig({ ...valid, EMAIL_PROVIDER: 'carrier-pigeon' }).ok).toBe(false);
    expect(parseAppConfig({ ...valid, MAX_JSON_BODY_BYTES: '10' }).ok).toBe(false);
    expect(parseAppConfig({ ...valid, MAX_JSON_BODY_BYTES: '99999999' }).ok).toBe(false);
  });
});

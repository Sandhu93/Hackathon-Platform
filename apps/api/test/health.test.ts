import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { apiErrorSchema, healthResponseSchema } from '@hackathon/shared';
import { makeApp } from './helpers';

const worker = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`http://example.com${path}`, init));

describe('GET /api/health (through the real Worker entry point)', () => {
  it('returns 200 with a valid, minimal body', async () => {
    const res = await worker('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = healthResponseSchema.parse(await res.json());
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('ok');
    expect(body.environment).toBe('test');
    expect(Object.keys(body).sort()).toEqual(
      ['checks', 'environment', 'service', 'status', 'timestamp', 'version'].sort(),
    );
  });

  it('sends security headers, a request id and disables caching', async () => {
    const res = await worker('/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
  });

  it('reuses a safe inbound request id and replaces an unsafe one', async () => {
    const good = await worker('/api/health', { headers: { 'x-request-id': 'trace-12345678' } });
    expect(good.headers.get('x-request-id')).toBe('trace-12345678');
    const bad = await worker('/api/health', { headers: { 'x-request-id': 'x y\tz;<script>' } });
    expect(bad.headers.get('x-request-id')).not.toContain('<');
    expect(bad.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
  });

  it('answers HEAD without a body', async () => {
    const res = await worker('/api/health', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('reports 503/degraded when the database is unreachable', async () => {
    const app = makeApp();
    const brokenDb = {
      prepare: () => ({ first: () => Promise.reject(new Error('D1 down')) }),
    };
    const res = await app.request('/api/health', {}, { DB: brokenDb });
    expect(res.status).toBe(503);
    const body = healthResponseSchema.parse(await res.json());
    expect(body.status).toBe('degraded');
    expect(body.checks.database).toBe('unavailable');
    expect(app.logs.some((l) => l.line.includes('health.database_unavailable'))).toBe(true);
  });
});

describe('error responses', () => {
  it('returns the standard 404 body for an unknown API route', async () => {
    const res = await worker('/api/does-not-exist');
    expect(res.status).toBe(404);
    const body = apiErrorSchema.parse(await res.json());
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('returns 404 for paths outside /api that reach the Worker', async () => {
    const res = await worker('/somewhere/else');
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('NOT_FOUND');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    '%s on /api/health is 405 with an Allow header',
    async (method) => {
      const res = await worker('/api/health', { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
      expect(apiErrorSchema.parse(await res.json()).error.code).toBe('METHOD_NOT_ALLOWED');
    },
  );
});

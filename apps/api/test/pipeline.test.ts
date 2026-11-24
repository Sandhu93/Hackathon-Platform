import { describe, expect, it } from 'vitest';
import { apiErrorSchema } from '@hackathon/shared';
import { CORS_ORIGIN, json, makeApp, ORIGIN } from './helpers';

describe('JSON request handling', () => {
  it('accepts valid JSON', async () => {
    const res = await makeApp().request('/api/_test/echo', json({ name: 'Ada', age: 36 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Ada', age: 36 });
  });

  it('returns 400 MALFORMED_JSON for a broken body', async () => {
    const res = await makeApp().request('/api/_test/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name": "Ada",',
    });
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('MALFORMED_JSON');
  });

  it('returns 400 MALFORMED_JSON for an empty body', async () => {
    const res = await makeApp().request('/api/_test/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('MALFORMED_JSON');
  });

  it('returns 415 when the content type is not JSON', async () => {
    const res = await makeApp().request('/api/_test/echo', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"name":"Ada"}',
    });
    expect(res.status).toBe(415);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('returns 400 VALIDATION_ERROR with field paths but never the rejected values', async () => {
    const res = await makeApp().request(
      '/api/_test/echo',
      json({ name: 'this-name-is-way-too-long-SENTINEL', age: -5 }),
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain('SENTINEL');
    const body = apiErrorSchema.parse(JSON.parse(text));
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details?.map((d) => d.path).sort()).toEqual(['age', 'name']);
  });

  it('rejects an oversized body declared via Content-Length with 413', async () => {
    const res = await makeApp().request('/api/_test/echo', json({ name: 'x'.repeat(5000) }), {
      MAX_JSON_BODY_BYTES: '1024',
    });
    expect(res.status).toBe(413);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects an oversized streamed body (no Content-Length) with 413', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(512));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 8; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    };
    const res = await makeApp().request('/api/_test/echo', init, { MAX_JSON_BODY_BYTES: '1024' });
    expect(res.status).toBe(413);
  });
});

describe('centralised error handling', () => {
  it('never leaks internals for unexpected errors, but logs them redacted', async () => {
    const app = makeApp();
    const res = await app.request('/api/_test/boom');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('alice');
    expect(text).not.toContain('db exploded');
    expect(text).not.toContain('stack');
    expect(apiErrorSchema.parse(JSON.parse(text)).error.code).toBe('INTERNAL_ERROR');

    const logged = app.logs.map((l) => l.line).join('\n');
    expect(logged).toContain('request.unhandled_error');
    expect(logged).not.toContain('alice@example.org');
    expect(logged).not.toContain('hunter2');
  });

  it('serialises AppError with its own code and status', async () => {
    const res = await makeApp().request('/api/_test/app-error');
    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('CONFLICT');
  });
});

describe('CORS and origin checks', () => {
  it('gives no CORS headers to unlisted origins', async () => {
    const res = await makeApp().request('/api/health', {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('echoes an explicitly allowed origin, with credentials, never "*"', async () => {
    const res = await makeApp().request('/api/health', { headers: { origin: CORS_ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).toBe(CORS_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('answers preflight for an allowed origin and withholds permission otherwise', async () => {
    const app = makeApp();
    const ok = await app.request('/api/_test/echo', {
      method: 'OPTIONS',
      headers: { origin: CORS_ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(CORS_ORIGIN);
    const bad = await app.request('/api/_test/echo', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects state-changing requests from an unlisted Origin with 403', async () => {
    const res = await makeApp().request(
      '/api/_test/echo',
      json({ name: 'Ada' }, { headers: { origin: 'https://evil.example' } }),
    );
    expect(res.status).toBe(403);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('FORBIDDEN_ORIGIN');
  });

  it('allows state-changing requests from the app origin and from non-browser clients', async () => {
    const app = makeApp();
    const same = await app.request(
      '/api/_test/echo',
      json({ name: 'Ada' }, { headers: { origin: ORIGIN } }),
    );
    expect(same.status).toBe(200);
    const none = await app.request('/api/_test/echo', json({ name: 'Ada' }));
    expect(none.status).toBe(200);
  });

  it('does not apply the origin check to safe methods', async () => {
    const res = await makeApp().request('/api/health', {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(200);
  });
});

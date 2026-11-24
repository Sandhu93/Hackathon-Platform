import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger';
import { redactString, redactValue, REDACTED } from '../src/lib/redact';
import { makeApp } from './helpers';

describe('redaction', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = redactValue({
      authorization: 'Bearer abc',
      nested: {
        password: 'pw-value',
        sessionId: 'sess-value',
        otp: '123456',
        apiKey: 'key-value',
        ok: 'visible',
      },
      list: [{ cookie: 'cookie-value' }],
    }) as Record<string, unknown>;
    const serialised = JSON.stringify(out);
    for (const secret of [
      'Bearer abc',
      'pw-value',
      'sess-value',
      '123456',
      'key-value',
      'cookie-value',
    ]) {
      expect(serialised).not.toContain(secret);
    }
    expect((out.nested as Record<string, unknown>).ok).toBe('visible');
    expect(out.authorization).toBe(REDACTED);
  });

  it('redacts secrets that appear inside string values', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc-DEF_123';
    const text = redactString(
      `user bob@example.org sent Bearer sk_live_abcdef with ${jwt} and ${'a1'.repeat(30)}`,
    );
    expect(text).not.toContain('bob@example.org');
    expect(text).toContain('b***@example.org');
    expect(text).not.toContain('sk_live_abcdef');
    expect(text).not.toContain(jwt);
    expect(text).not.toContain('a1a1a1a1a1');
  });

  it('redacts key=value secrets embedded in free text', () => {
    const text = redactString(
      'connect failed password=hunter2 token: abc123 api_key="quoted value" ok=fine',
    );
    expect(text).not.toMatch(/hunter2|abc123|quoted value/);
    expect(text).toContain('ok=fine');
  });

  it('redacts PEM private keys', () => {
    const header = '-----BEGIN PRIVATE KEY-----'; // secret-scan:allow (deliberate fake fixture)
    const pem = `${header}\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----`;
    expect(redactString(`key: ${pem}`)).not.toContain('MIIEvQ');
  });

  it('bounds depth and string size', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 20; i += 1) {
      const next: Record<string, unknown> = {};
      cursor.child = next;
      cursor = next;
    }
    expect(JSON.stringify(redactValue(deep))).toContain('[Truncated]');
    expect(redactString('x'.repeat(10_000)).length).toBeLessThan(600);
  });

  it('serialises errors by name and message, redacted', () => {
    const out = redactValue(new Error('failed for carol@example.org')) as { message: string };
    expect(out.message).toContain('c***@example.org');
  });
});

describe('logger', () => {
  it('writes JSON lines with timestamp, level, event, service and bindings', () => {
    const lines: string[] = [];
    const log = createLogger({
      level: 'info',
      bindings: { requestId: 'r-1' },
      sink: (_l, line) => lines.push(line),
    });
    log.info('thing.happened', { count: 2, token: 'secret' });
    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: 'info',
      event: 'thing.happened',
      service: 'hackathon-api',
      requestId: 'r-1',
      count: 2,
      token: REDACTED,
    });
    expect(typeof parsed.ts).toBe('string');
  });

  it('honours the configured level', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', sink: (_l, line) => lines.push(line) });
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(lines).toHaveLength(2);
  });
});

describe('access log', () => {
  it('logs method, path, status and duration but never the query string or headers', async () => {
    const app = makeApp();
    await app.request(
      '/api/health?token=SECRET-QUERY-TOKEN&email=a@b.example',
      { headers: { authorization: 'Bearer SECRET-HEADER', cookie: 'sid=SECRET-COOKIE' } },
      { LOG_LEVEL: 'info' },
    );
    const entry = app.logs
      .map((l) => JSON.parse(l.line) as Record<string, unknown>)
      .find((e) => e.event === 'http.request');
    expect(entry).toMatchObject({ method: 'GET', path: '/api/health', status: 200 });
    expect(typeof entry?.durationMs).toBe('number');
    expect(typeof entry?.requestId).toBe('string');
    expect(app.logs.map((l) => l.line).join('\n')).not.toContain('SECRET-');
  });

  it('logs 4xx at warn and 5xx at error', async () => {
    const app = makeApp();
    await app.request('/api/nope', undefined, { LOG_LEVEL: 'info' });
    await app.request('/api/_test/boom', undefined, { LOG_LEVEL: 'info' });
    const levels = app.logs
      .map((l) => ({ level: l.level, e: JSON.parse(l.line) as Record<string, unknown> }))
      .filter((x) => x.e.event === 'http.request')
      .map((x) => `${String(x.e.status)}:${x.level}`);
    expect(levels).toEqual(['404:warn', '500:error']);
  });
});

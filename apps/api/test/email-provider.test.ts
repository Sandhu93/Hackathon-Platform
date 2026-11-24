import { describe, expect, it } from 'vitest';
import { EmailProviderError, HttpEmailProvider } from '../src/adapters/email';

const message = {
  to: 'ada@example.test',
  subject: 'Your sign-in code',
  text: 'Code 123456',
  idempotencyKey: 'idem-1',
};

function provider(fetchImpl: typeof fetch, timeoutMs = 1000) {
  return new HttpEmailProvider({
    url: 'https://mail.example.test/send',
    from: 'no-reply@example.test',
    apiKey: 'secret-key',
    timeoutMs,
    fetchImpl,
  });
}

describe('HttpEmailProvider', () => {
  it('posts the message with bearer auth and an idempotency key', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = ((url: string, init: RequestInit) => {
      seen = { url, init };
      return Promise.resolve(new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }));
    }) as unknown as typeof fetch;
    const result = await provider(fetchImpl).send(message);
    expect(result.providerMessageId).toBe('msg_1');
    expect(seen?.url).toBe('https://mail.example.test/send');
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-key');
    expect(headers['Idempotency-Key']).toBe('idem-1');
    expect(JSON.parse(seen?.init.body as string)).toMatchObject({
      from: 'no-reply@example.test',
      to: ['ada@example.test'],
      subject: 'Your sign-in code',
    });
  });

  it('accepts a success status even if the body is unreadable', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response('not json', { status: 202 }))) as unknown as typeof fetch;
    expect((await provider(fetchImpl).send(message)).providerMessageId).toBe('unknown');
  });

  it.each([
    [429, true],
    [503, true],
    [400, false],
    [401, false],
  ])(
    'maps HTTP %i to retryable=%s without leaking the response body',
    async (status, retryable) => {
      const fetchImpl = (() =>
        Promise.resolve(
          new Response('echo: ada@example.test 123456', { status }),
        )) as unknown as typeof fetch;
      const error = await provider(fetchImpl)
        .send(message)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EmailProviderError);
      expect((error as EmailProviderError).retryable).toBe(retryable);
      expect((error as Error).message).toBe(`email provider responded ${status}`);
      expect((error as Error).message).not.toContain('123456');
    },
  );

  it('reports network failures as retryable without leaking details', async () => {
    const fetchImpl = (() =>
      Promise.reject(
        new Error('connect ECONNREFUSED ada@example.test'),
      )) as unknown as typeof fetch;
    const error = (await provider(fetchImpl)
      .send(message)
      .catch((e: unknown) => e)) as EmailProviderError;
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('email provider unreachable');
  });

  it('aborts a request that exceeds the timeout', async () => {
    const fetchImpl = ((_: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    const error = (await provider(fetchImpl, 50)
      .send(message)
      .catch((e: unknown) => e)) as EmailProviderError;
    expect(error.message).toBe('email provider timed out');
    expect(error.retryable).toBe(true);
  });
});

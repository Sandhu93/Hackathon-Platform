import { describe, expect, it } from 'vitest';
import { apiErrorSchema, parseAppConfig } from '@hackathon/shared';
import { createDriveStorage, MockDriveStorageAdapter } from '../src/adapters/drive';
import { createEmailProvider, MockEmailProvider } from '../src/adapters/email';
import { ConfigError } from '../src/lib/errors';
import { createLogger } from '../src/lib/logger';
import { makeApp } from './helpers';

function config(overrides: Record<string, unknown>) {
  const result = parseAppConfig({
    ENVIRONMENT: 'development',
    APP_ORIGIN: 'http://localhost:5173',
    ...overrides,
  });
  if (!result.ok) throw new Error('test config invalid');
  return result.config;
}

describe('environment configuration', () => {
  it.each([['APP_ORIGIN'], ['ENVIRONMENT']])(
    'fails closed with a generic 503 when %s is missing',
    async (key) => {
      const app = makeApp();
      const res = await app.request('/api/health', {}, { [key]: undefined });
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(apiErrorSchema.parse(JSON.parse(text)).error.code).toBe('SERVICE_UNAVAILABLE');
      // The client learns nothing about which setting is wrong...
      expect(text).not.toContain(key);
      // ...but the operator does.
      const logged = app.logs.map((l) => l.line).join('\n');
      expect(logged).toContain('config.invalid');
      expect(logged).toContain(key);
    },
  );

  it('fails closed on invalid values and does not log the value', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/health',
      {},
      { APP_ORIGIN: 'https://secret-value.example/path' },
    );
    expect(res.status).toBe(503);
    expect(app.logs.map((l) => l.line).join('\n')).not.toContain('secret-value');
  });

  it('still sends security headers and a request id on a configuration failure', async () => {
    const res = await makeApp().request('/api/health', {}, { ENVIRONMENT: undefined });
    expect(res.status).toBe(503);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('provider adapters (mocks and fail-closed factories)', () => {
  it('uses the mock email provider outside production and records messages', async () => {
    const provider = createEmailProvider(config({}), {});
    expect(provider).toBeInstanceOf(MockEmailProvider);
    const sent = await provider.send({ to: 'a@example.org', subject: 'Hi', text: 'body' });
    expect(sent.providerMessageId).toBe('mock-1');
    expect((provider as MockEmailProvider).outbox).toHaveLength(1);
  });

  it('refuses the mock email provider in production', () => {
    const prod = config({ ENVIRONMENT: 'production', APP_ORIGIN: 'https://hack.example.com' });
    expect(() => createEmailProvider(prod, {})).toThrow(ConfigError);
  });

  it('requires credentials for a real email provider and never exposes their value', () => {
    const external = config({ EMAIL_PROVIDER: 'external' });
    expect(() => createEmailProvider(external, {})).toThrow(/EMAIL_PROVIDER_API_KEY is required/);
    try {
      createEmailProvider(external, { EMAIL_PROVIDER_API_KEY: 'super-secret-key' });
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-key');
    }
  });

  it('does not log the message body of the mock email provider', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', sink: (_l, line) => lines.push(line) });
    const provider = createEmailProvider(config({}), {}, logger);
    await provider.send({ to: 'ada@example.org', subject: 'Your code', text: 'CODE-123456' });
    const logged = lines.join('\n');
    expect(logged).not.toContain('CODE-123456');
    expect(logged).not.toContain('ada@example.org');
    expect(logged).toContain('a***@example.org');
  });

  it('drive: mock round trip, safe names only, refused in production', async () => {
    const drive = createDriveStorage(config({}), {});
    expect(drive).toBeInstanceOf(MockDriveStorageAdapter);
    const folder = await drive.ensureFolder(['Hackathons', 'event-1', 'team-1']);
    expect((await drive.ensureFolder(['Hackathons', 'event-1', 'team-1'])).id).toBe(folder.id);
    const file = await drive.putFile({
      folderId: folder.id,
      name: 'deck.pdf',
      mimeType: 'application/pdf',
      data: new Uint8Array([1, 2, 3]),
    });
    expect(file.sizeBytes).toBe(3);
    expect((await drive.getFile(file.id))?.name).toBe('deck.pdf');
    await drive.deleteFile(file.id);
    expect(await drive.getFile(file.id)).toBeNull();
    await expect(drive.ensureFolder(['..', 'x'])).rejects.toThrow();
    await expect(
      drive.putFile({
        folderId: folder.id,
        name: '../evil',
        mimeType: 'x',
        data: new Uint8Array(),
      }),
    ).rejects.toThrow();

    const prod = config({ ENVIRONMENT: 'production', APP_ORIGIN: 'https://hack.example.com' });
    expect(() => createDriveStorage(prod, {})).toThrow(ConfigError);
    expect(() => createDriveStorage(config({ DRIVE_PROVIDER: 'google' }), {})).toThrow(
      /GOOGLE_SERVICE_ACCOUNT_JSON is required/,
    );
  });
});

import type { AppConfig } from '@hackathon/shared';
import { ConfigError } from '../lib/errors';
import type { Logger } from '../lib/logger';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Lets a provider (or the Milestone 04 outbox) collapse retried sends. */
  idempotencyKey?: string;
}

export interface EmailSendResult {
  providerMessageId: string;
}

/** Thrown by providers; `retryable` tells the (Milestone 04) outbox whether to try again. */
export class EmailProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'EmailProviderError';
    this.retryable = retryable;
  }
}

/** Contract every institutional email integration implements. */
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/** One mock mailbox per Worker isolate, shared by every request in it (dev tooling and tests). */
const mockMailbox: EmailMessage[] = [];

export const mockMailboxStore = {
  get messages(): readonly EmailMessage[] {
    return mockMailbox;
  },
  clear(): void {
    mockMailbox.length = 0;
  },
};

/**
 * Development/test provider. Keeps messages in memory (per Worker isolate) so tests and the
 * development-only mailbox route can read them. It deliberately logs only a masked recipient
 * and the subject, never the body, which contains the login code.
 */
export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock';

  constructor(private readonly logger?: Logger) {}

  get outbox(): readonly EmailMessage[] {
    return mockMailbox;
  }

  send(message: EmailMessage): Promise<EmailSendResult> {
    mockMailbox.push(message);
    if (mockMailbox.length > 50) mockMailbox.shift();
    this.logger?.info('email.mock.sent', { to: message.to, subject: message.subject });
    return Promise.resolve({ providerMessageId: `mock-${mockMailbox.length}` });
  }
}

export interface HttpEmailOptions {
  url: string;
  from: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Generic transactional-email provider over HTTPS: POST a JSON message with a Bearer key.
 * The payload (`from`, `to[]`, `subject`, `text`) matches the common transactional-API shape
 * (e.g. Resend); adapt this one class if the organisation's mail system differs
 * (Microsoft Graph / Gmail API need OAuth and would be a sibling class behind the same
 * interface). Neither request nor response bodies are ever logged: they hold login codes.
 */
export class HttpEmailProvider implements EmailProvider {
  readonly name = 'http';
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpEmailOptions) {
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        }),
        signal: controller.signal,
      });
    } catch (cause) {
      const aborted = cause instanceof DOMException && cause.name === 'AbortError';
      throw new EmailProviderError(
        aborted ? 'email provider timed out' : 'email provider unreachable',
        true,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      // Only the status is surfaced; the body may echo the message.
      throw new EmailProviderError(
        `email provider responded ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    let id = 'unknown';
    try {
      const body = await response.json<{ id?: unknown }>();
      if (typeof body.id === 'string') id = body.id.slice(0, 100);
    } catch {
      // A successful status with an unreadable body still counts as accepted.
    }
    return { providerMessageId: id };
  }
}

export interface EmailSecrets {
  EMAIL_PROVIDER_API_KEY?: string | undefined;
}

/**
 * Select the email provider. Fails closed: the mock is refused in production, and the real
 * provider needs its credential, URL and sender address (each a ConfigError that names the
 * setting but never a value).
 */
export function createEmailProvider(
  config: AppConfig,
  secrets: EmailSecrets,
  logger?: Logger,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): EmailProvider {
  if (config.EMAIL_PROVIDER === 'mock') {
    if (config.ENVIRONMENT === 'production') {
      throw new ConfigError('EMAIL_PROVIDER=mock is not allowed in production');
    }
    return new MockEmailProvider(logger);
  }
  if (!secrets.EMAIL_PROVIDER_API_KEY) {
    throw new ConfigError('EMAIL_PROVIDER_API_KEY is required when EMAIL_PROVIDER=external');
  }
  if (!config.EMAIL_API_URL) {
    throw new ConfigError('EMAIL_API_URL is required when EMAIL_PROVIDER=external');
  }
  if (!config.EMAIL_FROM_ADDRESS) {
    throw new ConfigError('EMAIL_FROM_ADDRESS is required when EMAIL_PROVIDER=external');
  }
  return new HttpEmailProvider({
    url: config.EMAIL_API_URL,
    from: config.EMAIL_FROM_ADDRESS,
    apiKey: secrets.EMAIL_PROVIDER_API_KEY,
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
}

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

/**
 * Development/test provider. Keeps messages in memory (per Worker isolate) so tests and
 * local tooling can read them. It deliberately logs only a masked recipient and the
 * subject — never the body, which will contain login codes in Milestone 01.
 */
export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock';
  readonly outbox: EmailMessage[] = [];
  private counter = 0;

  constructor(private readonly logger?: Logger) {}

  send(message: EmailMessage): Promise<EmailSendResult> {
    this.outbox.push(message);
    this.counter += 1;
    this.logger?.info('email.mock.sent', { to: message.to, subject: message.subject });
    return Promise.resolve({ providerMessageId: `mock-${this.counter}` });
  }
}

export interface EmailSecrets {
  EMAIL_PROVIDER_API_KEY?: string | undefined;
}

/**
 * Select the email provider. Fails closed: the mock is refused in production, and a real
 * provider without credentials is a configuration error. Real providers arrive in
 * Milestone 01, once the institutional mail system is known.
 */
export function createEmailProvider(
  config: AppConfig,
  secrets: EmailSecrets,
  logger?: Logger,
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
  throw new ConfigError('EMAIL_PROVIDER=external is not implemented yet (Milestone 01)');
}

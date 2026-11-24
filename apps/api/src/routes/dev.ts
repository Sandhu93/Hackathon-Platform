import { Hono } from 'hono';
import { mockMailboxStore } from '../adapters/email';
import { AppError } from '../lib/errors';
import type { HonoEnv } from '../types';

/**
 * Development-only mailbox viewer: lets a developer read the sign-in code that the mock email
 * provider "sent". It answers 404 unless ENVIRONMENT is "development" AND the mock provider is
 * selected, so it cannot exist in staging or production, and a message body (the code) is
 * never written to logs.
 */
export const devRoutes = new Hono<HonoEnv>();

devRoutes.get('/dev/mailbox', (c) => {
  const config = c.get('config');
  if (config.ENVIRONMENT !== 'development' || config.EMAIL_PROVIDER !== 'mock') {
    throw new AppError('NOT_FOUND', 'Resource not found.');
  }
  const messages = [...mockMailboxStore.messages].reverse().map((m) => ({
    to: m.to,
    subject: m.subject,
    text: m.text,
  }));
  return c.json({ messages }, 200);
});

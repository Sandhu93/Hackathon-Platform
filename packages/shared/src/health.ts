import { z } from 'zod';
import { environmentSchema } from './env';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('hackathon-api'),
  environment: environmentSchema,
  version: z.string(),
  timestamp: z.iso.datetime(),
  checks: z.object({
    database: z.enum(['ok', 'unavailable']),
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

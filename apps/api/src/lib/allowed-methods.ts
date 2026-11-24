import type { Hono } from 'hono';
import type { HonoEnv } from '../types';

function toPattern(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) => {
      if (segment === '*') return '.*';
      if (segment.startsWith(':')) return '[^/]+';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${source}/?$`);
}

/**
 * Methods registered for a concrete request path, used to answer 405 (with an Allow
 * header) instead of 404 when a known path is called with the wrong method.
 * Catch-all middleware (method ALL) is ignored.
 */
export function allowedMethodsFor(app: Hono<HonoEnv>, path: string): string[] {
  const methods = new Set<string>();
  for (const route of app.routes) {
    if (route.method === 'ALL') continue;
    if (toPattern(route.path).test(path)) methods.add(route.method);
  }
  if (methods.has('GET')) methods.add('HEAD');
  return [...methods].sort();
}

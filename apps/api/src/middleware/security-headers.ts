import { secureHeaders } from 'hono/secure-headers';
import type { MiddlewareHandler } from 'hono';
import type { HonoEnv } from '../types';

/**
 * Headers for API responses (JSON only, never rendered). The SPA's own headers and CSP
 * live in apps/web/public/_headers because static assets bypass this Worker.
 */
export const securityHeaders: MiddlewareHandler<HonoEnv> = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'none'"],
    frameAncestors: ["'none'"],
  },
  strictTransportSecurity: 'max-age=63072000; includeSubDomains',
  xContentTypeOptions: 'nosniff',
  xFrameOptions: 'DENY',
  referrerPolicy: 'no-referrer',
  crossOriginOpenerPolicy: 'same-origin',
  crossOriginResourcePolicy: 'same-origin',
  permissionsPolicy: {
    camera: [],
    microphone: [],
    geolocation: [],
    payment: [],
    usb: [],
  },
});

/** API responses are per-user and must never be cached by browsers or intermediaries. */
export const noStore: MiddlewareHandler<HonoEnv> = async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
};

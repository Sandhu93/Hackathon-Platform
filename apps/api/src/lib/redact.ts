/**
 * Redaction for anything that reaches logs. Over-redacting is acceptable; leaking is not.
 */
const SENSITIVE_KEY =
  /authori[sz]ation|cookie|passw(or)?d|secret|token|otp|api[-_]?key|private[-_]?key|credential|session|signature|verification[-_]?code|magic|csrf/i;

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const EMAIL = /([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
// key=value / key: value pairs embedded in free text, e.g. "password=hunter2".
const INLINE_SECRET =
  /\b(passw(?:or)?d|secret|token|api[-_]?key|otp|authorization|cookie|session[-_]?id)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/g;

const MAX_STRING = 500;
const MAX_DEPTH = 5;
const MAX_KEYS = 30;
const MAX_ITEMS = 20;

export const REDACTED = '[REDACTED]';

export function redactString(input: string): string {
  const clipped = input.length > MAX_STRING ? `${input.slice(0, MAX_STRING)}…[truncated]` : input;
  return clipped
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(INLINE_SECRET, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`)
    .replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(EMAIL, (_m, local: string, domain: string) => `${local.slice(0, 1)}***@${domain}`)
    .replace(LONG_TOKEN, REDACTED);
}

export function redactValue(value: unknown, key?: string, depth = 0): unknown {
  if (key !== undefined && SENSITIVE_KEY.test(key)) return REDACTED;
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return `[${typeof value}]`;
  }
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(value.stack ? { stack: redactString(value.stack.slice(0, 1500)) } : {}),
    };
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ITEMS)
      .map((item: unknown) => redactValue(item, undefined, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
    out[k] = redactValue(v, k, depth + 1);
  }
  return out;
}

const encoder = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    if (keyCache.size >= 4) keyCache.clear();
    keyCache.set(secret, key);
  }
  return key;
}

/**
 * Keyed hash (HMAC-SHA-256, hex). `label` separates uses of the one server secret ("otp",
 * "session", "email", ...) so a value hashed for one purpose can never be replayed as another.
 * HMAC is a single fast operation, which matters on the Workers Free plan's 10 ms CPU budget
 * (password-hashing KDFs are not an option there). It is appropriate here because the inputs
 * are high-entropy random tokens or are rate-limited, and the key never leaves the server.
 */
export async function hmacHex(secret: string, label: string, value: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    encoder.encode(`${label}\u0000${value}`),
  );
  return toHex(new Uint8Array(signature));
}

/** Constant-time comparison of two equal-purpose hex digests. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Uniformly distributed numeric code (rejection sampling, no modulo bias). */
export function randomOtp(digits = 6): string {
  const range = 10 ** digits;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] ?? 0;
    if (value < limit) return String(value % range).padStart(digits, '0');
  }
}

/** 256 bits of randomness, URL-safe (43 characters). Used for session tokens. */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

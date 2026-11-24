/**
 * Email normalisation policy (documented in docs/security.md):
 *
 * - Surrounding whitespace is trimmed; the whole address is lower-cased. Institutional mail
 *   systems (Exchange, Google Workspace) treat addresses case-insensitively.
 * - Nothing else is rewritten. In particular `+tag` suffixes are NOT stripped and dots are NOT
 *   removed: those rules are provider-specific (Gmail) and applying them universally would let
 *   `a.b@org` and `ab@org` collide, or merge two genuinely different mailboxes.
 * - Only plain ASCII dot-atom addresses are accepted. Quoted local parts, comments, display
 *   names, IP-literal domains, whitespace, control characters and non-ASCII characters (a
 *   homograph risk) are rejected. Internationalised domains must be given as punycode.
 */
const LOCAL_ATOM = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface NormalizedEmail {
  /** Canonical form used for storage and comparison. */
  email: string;
  local: string;
  domain: string;
}

/** True for a syntactically valid, lower-case, multi-label DNS name (no trailing dot, not an IP). */
export function isValidDomain(domain: string): boolean {
  if (domain.length < 3 || domain.length > 253) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) return false;
  const tld = labels[labels.length - 1] ?? '';
  return /[a-z]/.test(tld); // rejects all-numeric "TLDs" such as 1.2.3.4
}

export function normalizeEmail(input: string): NormalizedEmail | null {
  if (input.length === 0 || input.length > 320) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return null;
  // Printable ASCII without spaces only.
  if (!/^[\x21-\x7e]+$/.test(trimmed)) return null;

  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return null;

  const local = trimmed.slice(0, at).toLowerCase();
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (local.length > 64) return null;
  if (!local.split('.').every((atom) => atom.length > 0 && LOCAL_ATOM.test(atom))) return null;
  if (!isValidDomain(domain)) return null;
  return { email: `${local}@${domain}`, local, domain };
}

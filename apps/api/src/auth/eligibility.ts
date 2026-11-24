import type { AuthConfig } from '@hackathon/shared';
import type { UserRow } from './repo';

export type IneligibleReason =
  'domain_not_allowed' | 'not_on_roster' | 'suspended' | 'revoked' | 'shared_mailbox';

export type Eligibility = { ok: true } | { ok: false; reason: IneligibleReason };

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

export function domainAllowed(config: AuthConfig, email: string): boolean {
  return config.AUTH_ALLOWED_EMAIL_DOMAINS.includes(emailDomain(email));
}

/**
 * The eligibility policy, in one place:
 *  1. The address must be on an allowed institutional domain (exact match, no subdomains).
 *  2. A revoked or suspended account is always denied, in either mode.
 *  3. A shared/group mailbox is never allowed to sign in: one code in a mailbox read by many
 *     people would give all of them one identity. Administrators must approve personal
 *     mailboxes only.
 *  4. roster mode: the address must already have an approved (active) account.
 *     domain mode: an address with no account is eligible and is provisioned on first success.
 */
export function evaluateEligibility(
  config: AuthConfig,
  email: string,
  user: Pick<UserRow, 'status' | 'mailbox_kind'> | null,
): Eligibility {
  if (!domainAllowed(config, email)) return { ok: false, reason: 'domain_not_allowed' };
  if (user === null) {
    return config.AUTH_ELIGIBILITY_MODE === 'domain'
      ? { ok: true }
      : { ok: false, reason: 'not_on_roster' };
  }
  if (user.status === 'revoked') return { ok: false, reason: 'revoked' };
  if (user.status === 'suspended') return { ok: false, reason: 'suspended' };
  if (user.mailbox_kind === 'shared') return { ok: false, reason: 'shared_mailbox' };
  return { ok: true };
}

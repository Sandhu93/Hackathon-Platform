import { describe, expect, it } from 'vitest';
import { isValidDomain, normalizeEmail } from './email';

describe('normalizeEmail', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmail('  Ada.Lovelace@Example.ORG ')).toEqual({
      email: 'ada.lovelace@example.org',
      local: 'ada.lovelace',
      domain: 'example.org',
    });
  });

  it('does not apply plus-address or dot normalisation', () => {
    expect(normalizeEmail('a.b+tag@example.org')?.email).toBe('a.b+tag@example.org');
    expect(normalizeEmail('ab@example.org')?.email).not.toBe(
      normalizeEmail('a.b@example.org')?.email,
    );
  });

  it.each([
    '',
    'plain',
    '@example.org',
    'a@',
    'a@@example.org',
    'a b@example.org',
    'a@exa mple.org',
    'a@example',
    '.a@example.org',
    'a.@example.org',
    'a..b@example.org',
    'a@-example.org',
    'a@example..org',
    'a@example.123',
    'ünï@example.org',
    'a@exämple.org',
    'a\n@example.org',
    '"quoted"@example.org',
    'a,b@example.org',
    `${'x'.repeat(65)}@example.org`,
    `a@${'x'.repeat(250)}.org`,
  ])('rejects %j', (input) => {
    expect(normalizeEmail(input)).toBeNull();
  });

  it('accepts the 64-character local-part limit', () => {
    expect(normalizeEmail(`${'x'.repeat(64)}@example.org`)).not.toBeNull();
  });
});

describe('isValidDomain', () => {
  it('requires at least two labels and a lettered TLD', () => {
    expect(isValidDomain('example.org')).toBe(true);
    expect(isValidDomain('sub.example.co.in')).toBe(true);
    expect(isValidDomain('localhost')).toBe(false);
    expect(isValidDomain('example.123')).toBe(false);
    expect(isValidDomain('-a.org')).toBe(false);
  });
});
